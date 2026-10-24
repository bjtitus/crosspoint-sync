import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument } from '../kosync.js';
import { nowSeconds } from '../../models/sync.js';
import {
  combineBookStats,
  combineGlobalStats,
  parseBookStats,
  parseGlobalStats,
  parseDailyReading,
  type BookStatsSnapshot,
  type GlobalStatsSnapshot,
} from '../../models/stats.js';
import { computeActivity, type DocInfo, type LogRow } from '../../models/activity.js';
import { documentInfo } from '../../models/cover.js';
import { resolveDocument, statsAliases, statsDocuments } from '../../models/merge.js';
import type { HttpTransport } from '../../connectors/types.js';
import { bookorbitExclusions, readBookorbitStats } from '../../models/bookorbit-stats.js';

import { parseReadingSession } from '../../models/reading-sessions.js';
import { importBookorbitStats } from '../../connectors/bookorbit-stats.js';

const MAX_BOOK_BATCH = 20;
const MAX_INFO_LOOKUPS = 25;

const EPOCH_DAY = Date.UTC(2000, 0, 1) / 86400000;
const DEFAULT_OVERVIEW_DAYS = 365;
const MAX_OVERVIEW_DAYS = 3650;

/** The caller's UTC offset in minutes as JS getTimezoneOffset() gives it; 0 when absent or implausible. */
function tzFrom(raw: string | undefined): number {
  const tz = Number(raw ?? 0);
  return Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0;
}

function deviceIdFrom(o: Record<string, unknown>): string | null {
  return typeof o.device_id === 'string' && o.device_id.length > 0 && o.device_id.length <= 128
    ? o.device_id
    : null;
}

export function statsRoutes(db: DB, http?: HttpTransport): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Device snapshots combined across devices, plus seconds per day.
  function summaryFor(userId: number) {
    const rows = db
      .prepare(
        'SELECT device_id, device, payload, updated_at FROM stats_device_global WHERE user_id = ?'
      )
      .all(userId) as { device_id: string; device: string; payload: string; updated_at: number }[];
    const snapshots = rows.map((r) => JSON.parse(r.payload) as GlobalStatsSnapshot);
    const imported = readBookorbitStats(db, userId);
    if (imported.global.sessions) snapshots.push(imported.global);
    const summary = combineGlobalStats(snapshots);
    const daily = new Map<string, number>();
    for (const d of [...db.prepare(
      'SELECT date, SUM(seconds) AS seconds FROM stats_device_day WHERE user_id = ? GROUP BY date ORDER BY date'
    ).all(userId) as { date: string; seconds: number }[], ...imported.daily]) {
      daily.set(d.date, (daily.get(d.date) ?? 0) + d.seconds);
    }
    return { rows, imported, summary, daily };
  }

  async function activityFor(userId: number, tz: number) {
    // Books never looked up yet get their page count now (bounded per request).
    const pending = db
      .prepare(
        `SELECT document FROM documents WHERE user_id = ? AND cover_checked_at IS NULL
           AND (title IS NOT NULL OR filename IS NOT NULL) LIMIT ?`
      )
      .all(userId, MAX_INFO_LOOKUPS) as { document: string }[];
    await Promise.all(pending.map((d) => documentInfo(db, userId, d.document, http).catch(() => null)));

    const rows = db
      .prepare('SELECT document, percentage, at FROM progress_log WHERE user_id = ?')
      .all(userId) as unknown as LogRow[];
    const docs = new Map(
      (
        db
          .prepare('SELECT document, page_count, status, status_at, start_date, finished_date FROM documents WHERE user_id = ?')
          .all(userId) as unknown as (DocInfo & { document: string })[]
      ).map((d) => [d.document, d])
    );
    // CrossInk's own finish dates, combined across devices like /stats/books/:document.
    const merged = statsAliases(db, userId);
    const snapshotsByDoc = new Map<string, BookStatsSnapshot[]>();
    for (const r of db
      .prepare('SELECT document, payload FROM stats_device_book WHERE user_id = ?')
      .all(userId) as { document: string; payload: string }[]) {
      const document = merged.get(r.document) ?? r.document;
      const list = snapshotsByDoc.get(document) ?? [];
      list.push(JSON.parse(r.payload) as BookStatsSnapshot);
      snapshotsByDoc.set(document, list);
    }
    const finishedDates = new Map<string, number>();
    const startDates = new Map<string, number>();
    for (const [document, snapshots] of snapshotsByDoc) {
      const combined = combineBookStats(snapshots);
      if (combined.completed && combined.finished_date > 0) finishedDates.set(document, combined.finished_date);
      if (combined.start_date > 0) startDates.set(document, combined.start_date);
    }
    const activity = computeActivity(rows, docs, tz, finishedDates, startDates);
    const imported = readBookorbitStats(db, userId);
    activity.reading_days = [...new Set([...activity.reading_days, ...imported.daily.map((d) => d.date)])].sort();
    return activity;
  }


  // Cumulative session checkpoints retain one identity, including stale retries.
  app.put('/stats/sessions', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return kosyncError(c, 403, 2003, 'Invalid request'); }
    const deviceId = body && deviceIdFrom(body);
    const now = nowSeconds();
    if (!deviceId || !Array.isArray(body.items) || !body.items.length || body.items.length > 20) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const items = body.items.map((s: unknown) => parseReadingSession(s, now));
    if (items.some((s: unknown) => !s) || new Set(items.map((s: any) => s.session_id)).size !== items.length) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const userId = c.get('user').id;
    const existing = db.prepare('SELECT * FROM reading_sessions WHERE user_id=? AND device_id=? AND session_id=?');
    for (const s of items) {
      const old = existing.get(userId, deviceId, s.session_id);
      if (old && (['document', 'started_at', 'utc_offset_minutes'].some((key) => old[key] !== s[key]) ||
          !((s.seconds >= Number(old.seconds) && s.ended_at >= Number(old.ended_at)) ||
            (s.seconds <= Number(old.seconds) && s.ended_at <= Number(old.ended_at))))) {
        return kosyncError(c, 403, 2003, 'Session ID already has different data');
      }
    }
    withTransaction(db, () => {
      const insert = db.prepare(`INSERT INTO reading_sessions
        (user_id, device_id, session_id, document, started_at, ended_at, seconds, utc_offset_minutes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id,device_id,session_id) DO UPDATE SET
          seconds=MAX(reading_sessions.seconds, excluded.seconds),
          ended_at=MAX(reading_sessions.ended_at, excluded.ended_at)`);
      for (const s of items) insert.run(userId, deviceId, s.session_id, s.document, s.started_at,
        s.ended_at, s.seconds, s.utc_offset_minutes, now);
    });
    for (const document of new Set<string>(items.map((s: any) => resolveDocument(db, userId, s.document)))) {
      void importBookorbitStats(db, userId, http, { document }).catch(() => {});
    }
    return c.json({ until: now, accepted_session_ids: items.map((s: any) => s.session_id) });
  });

  app.put('/stats/global', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const deviceId = deviceIdFrom(o);
    const snapshot = parseGlobalStats(o);
    const daily = parseDailyReading(o.daily);
    if (!deviceId || !snapshot || !daily) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const device = typeof o.device === 'string' ? o.device.slice(0, 128) : '';
    const user = c.get('user');
    const now = nowSeconds();
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO stats_device_global (user_id, device_id, device, payload, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_id) DO UPDATE SET
           device = excluded.device, payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(user.id, deviceId, device, JSON.stringify(snapshot), now);
      const upsertDay = db.prepare(
        `INSERT INTO stats_device_day (user_id, device_id, date, seconds, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_id, date) DO UPDATE SET
           seconds = MAX(stats_device_day.seconds, excluded.seconds),
           updated_at = excluded.updated_at`
      );
      for (const day of daily) upsertDay.run(user.id, deviceId, day.date, day.seconds, now);
    });
    // Explicit acknowledgment lets readers retain unsent counters when talking to old servers.
    return c.json({ until: now, accepted_daily: daily.length });
  });

  app.put('/stats/books', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const deviceId = deviceIdFrom(o);
    const items = o.items;
    if (!deviceId || !Array.isArray(items) || items.length === 0 || items.length > MAX_BOOK_BATCH) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const parsed: { document: string; snapshot: BookStatsSnapshot }[] = [];
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const snapshot = parseBookStats(item);
      if (!isValidDocument(item.document) || !snapshot) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      parsed.push({ document: item.document, snapshot });
    }
    const user = c.get('user');
    const now = nowSeconds();
    const upsert = db.prepare(
      `INSERT INTO stats_device_book (user_id, device_id, document, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, device_id, document) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at`
    );
    withTransaction(db, () => {
      for (const p of parsed) {
        upsert.run(user.id, deviceId, p.document, JSON.stringify(p.snapshot), now);
      }
    });
    return c.json({ until: now, accepted: parsed.length });
  });

  app.get('/stats/global', (c) => {
    const user = c.get('user');
    const rows = db
      .prepare(
        'SELECT device_id, device, payload, updated_at FROM stats_device_global WHERE user_id = ?'
      )
      .all(user.id) as { device_id: string; device: string; payload: string; updated_at: number }[];
    const imported = readBookorbitStats(db, user.id);
    const devices = rows.map((r) => ({
        device_id: r.device_id,
        device: r.device,
        updated_at: r.updated_at,
        stats: {
          ...JSON.parse(r.payload),
          daily: db.prepare('SELECT date, seconds FROM stats_device_day WHERE user_id = ? AND device_id = ? ORDER BY date')
            .all(user.id, r.device_id),
        },
      }));
    if (imported.global.sessions) devices.push({
      device_id: 'connector:bookorbit', device: 'BookOrbit', updated_at: imported.updated_at,
      stats: { ...imported.global, daily: imported.daily },
    });
    return c.json({
      devices,
      bookorbit: bookorbitExclusions(imported),
    });
  });

  app.get('/stats/summary', (c) => {
    const user = c.get('user');
    const { rows, imported, summary, daily } = summaryFor(user.id);
    return c.json({
      ...summary,
      daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds, minutes: seconds / 60 })),
      bookorbit: bookorbitExclusions(imported),
      devices: [...rows.map((r) => ({
        device_id: r.device_id,
        device: r.device,
        updated_at: r.updated_at,
      })), ...(imported.global.sessions ? [{ device_id: 'connector:bookorbit', device: 'BookOrbit', updated_at: imported.updated_at }] : [])],
    });
  });

  app.get('/stats/books/:document', (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    // Merged copies keep their stats under their own hash; fold in the ones
    // merged with stats.
    const documents = statsDocuments(db, user.id, resolveDocument(db, user.id, document));
    const rows = db
      .prepare(
        `SELECT device_id, document, payload, updated_at FROM stats_device_book
         WHERE user_id = ? AND document IN (${documents.map(() => '?').join(',')})`
      )
      .all(user.id, ...documents) as {
      device_id: string;
      document: string;
      payload: string;
      updated_at: number;
    }[];
    const snapshots = rows.map((r) => JSON.parse(r.payload) as BookStatsSnapshot);
    const imported = readBookorbitStats(db, user.id, documents);
    if (imported.book.sessions) snapshots.push(imported.book);
    return c.json({
      document,
      combined: combineBookStats(snapshots),
      bookorbit: bookorbitExclusions(imported),
      devices: [...rows.map((r) => ({
        device_id: r.device_id,
        document: r.document,
        updated_at: r.updated_at,
        stats: JSON.parse(r.payload),
      })), ...(imported.book.sessions ? [{ device_id: 'connector:bookorbit', document,
        updated_at: imported.updated_at, stats: imported.book }] : [])],
    });
  });

  // Pages/books activity from the progress history (print pages), for readers
  // that don't send stats. ?tz= is the client's Date#getTimezoneOffset().
  app.get('/stats/activity', async (c) => c.json(await activityFor(c.get('user').id, tzFrom(c.req.query('tz')))));

  // A device-sized digest of what the Stats page shows: the same finished counts, pages and streaks,
  // and reading days from every source. Counts cover all history; only the reading-day bitmap is
  // windowed (`days`, default 365, at most 3650) so the response stays a few hundred bytes.
  app.get('/stats/overview', async (c) => {
    const user = c.get('user');
    const tz = tzFrom(c.req.query('tz'));
    const daysRaw = Number(c.req.query('days') ?? DEFAULT_OVERVIEW_DAYS);
    const days = Number.isInteger(daysRaw) && daysRaw >= 1 ? Math.min(daysRaw, MAX_OVERVIEW_DAYS) : DEFAULT_OVERVIEW_DAYS;
    const activity = await activityFor(user.id, tz);
    const { summary, daily } = summaryFor(user.id);
    const day = (t: number) => Math.floor(t / 86400000) - EPOCH_DAY; // days since 2000-01-01
    const dayName = (d: number) => new Date((d + EPOCH_DAY) * 86400000).toISOString().slice(0, 10);
    const today = day(Date.now() - tz * 60000);
    const read = new Set<number>();
    for (const d of activity.reading_days) read.add(day(Date.parse(`${d}T00:00:00Z`)));
    for (const [d, seconds] of daily) if (seconds > 0) read.add(day(Date.parse(`${d}T00:00:00Z`)));
    if (summary.anchor_day > 0 && summary.history_b64) {
      const bits = Buffer.from(summary.history_b64, 'base64');
      for (let n = 0; n < bits.length * 8; n++) if (bits[n >> 3] & (1 << (n & 7))) read.add(summary.anchor_day - n);
    }
    const past = [...read].filter((d) => d <= today).sort((a, b) => a - b);
    let longest = 0;
    for (let i = 0, run = 0; i < past.length; i++) {
      run = i > 0 && past[i] === past[i - 1] + 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    // Today counts once read; until then the streak runs to yesterday.
    let current = 0;
    for (let d = read.has(today) ? today : today - 1; read.has(d); d--) current++;
    const history = Buffer.alloc(Math.ceil(days / 8));
    for (const d of past) if (today - d < days) history[(today - d) >> 3] |= 1 << ((today - d) & 7);
    const year = new Date(Date.now() - tz * 60000).getUTCFullYear();
    const finished = activity.books.filter((b) => b.finished_at);
    return c.json({
      anchor_day: today,
      days,
      history_b64: history.toString('base64'),
      reading_days: past.length,
      current_streak: current,
      longest_streak: longest,
      books_finished: finished.length,
      finished_this_year: finished.filter((b) => new Date((b.finished_at! - tz * 60) * 1000).getUTCFullYear() === year).length,
      pages_read: activity.pages_total,
      // Reading time as the reader measured it (devices that upload stats); none for synced-only books.
      seconds: summary.seconds,
      sessions: summary.sessions,
      today_seconds: daily.get(dayName(today)) ?? 0,
      week_seconds: [0, 1, 2, 3, 4, 5, 6].reduce((sum, n) => sum + (daily.get(dayName(today - n)) ?? 0), 0),
    });
  });

  return app;
}

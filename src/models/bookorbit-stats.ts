import type { DB } from '../db/db.js';
import { HISTORY_BYTES, HISTORY_DAYS, type GlobalStatsSnapshot, type BookStatsSnapshot, type DailyReading } from './stats.js';

interface StoredSession {
  session_id: number; external_id: string; started_at: number; ended_at: number;
  seconds: number; owned: number; source: string | null; timezone: string; refreshed_at: number;
}
const DAY_MS = 86400_000;
const EPOCH = Date.UTC(2000, 0, 1);

function calendar(timezone: string) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return (at: number) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(at * 1000)).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour),
      minute: Number(parts.minute), second: Number(parts.second) };
  };
}

export interface BookorbitStats {
  global: GlobalStatsSnapshot;
  book: BookStatsSnapshot;
  daily: DailyReading[];
  updated_at: number;
  excluded_sessions: number;
  excluded_seconds: number;
}

/** Count provider identities once without guessing overlaps with cumulative device totals. */
export function readBookorbitStats(db: DB, userId: number, documents?: string[]): BookorbitStats {
  const docFilter = documents ? `AND m.document IN (${documents.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT s.*, b.timezone, b.refreshed_at,
    EXISTS(SELECT 1 FROM bookorbit_session_exports e
      JOIN bookorbit_session_destination dest ON dest.user_id=e.user_id AND dest.destination=e.destination
      WHERE e.user_id=s.user_id AND e.external_id=s.external_id AND e.remote_id=s.session_id) AS owned FROM bookorbit_stats_sessions s
    JOIN bookorbit_stats_sync b ON b.user_id = s.user_id AND b.external_id = s.external_id AND b.active_generation = s.generation
    WHERE s.user_id = ? AND EXISTS (SELECT 1 FROM connector_matches m WHERE m.user_id = s.user_id
      AND m.connector_id = 'bookorbit' AND m.external_id = s.external_id ${docFilter})
    ORDER BY s.session_id, s.external_id`).all(userId, ...(documents ?? [])) as unknown as StoredSession[];
  const out: BookorbitStats = {
    global: { v: 5, sessions: 0, seconds: 0, pages: 0, completed: 0, tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
      anchor_day: 0, history_b64: '', streak: 0 },
    book: { v: 5, sessions: 0, seconds: 0, pages: 0, completed: false, avg_fwd: 0, pace_n: 0, eta: 0,
      start_manual: false, finish_manual: false, start_date: 0, finished_date: 0, tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0] },
    daily: [], updated_at: 0, excluded_sessions: 0, excluded_seconds: 0,
  };
  const days = new Map<string, number>();
  const seen = new Set<number>();
  const exactSessions = new Set<string>();
  const calendars = new Map<string, ReturnType<typeof calendar>>();
  let anchor = 0;
  for (const s of rows) {
    out.updated_at = Math.max(out.updated_at, s.refreshed_at);
    if (s.seconds <= 0) continue;
    if (s.owned) {
      out.excluded_sessions++;
      out.excluded_seconds += s.seconds;
      continue;
    }
    // Source alone (e.g. KOReader on a Kindle) says nothing about whether a
    // CrossInk counter contains this reading. Only remove identifiable repeats.
    // A zero-length manual entry has no time span to compare reliably.
    const exact = s.ended_at > s.started_at
      ? JSON.stringify([s.external_id, s.source, s.started_at, s.ended_at, s.seconds]) : null;
    const duplicate = seen.has(s.session_id) || (exact !== null && exactSessions.has(exact));
    seen.add(s.session_id);
    if (exact !== null) exactSessions.add(exact);
    if (duplicate) {
      out.excluded_sessions++;
      out.excluded_seconds += s.seconds;
      continue;
    }
    let local = calendars.get(s.timezone);
    if (!local) { local = calendar(s.timezone); calendars.set(s.timezone, local); }
    anchor = Math.max(anchor, Math.floor((Date.parse(local(Date.now() / 1000).date) - EPOCH) / DAY_MS));
    out.global.sessions++;
    out.global.seconds += s.seconds;
    // Allocate measured duration in proportion to its wall-clock span. Splitting at
    // local hour boundaries also handles midnight, UTC offsets, and DST changes.
    let at = s.started_at;
    let allocated = 0;
    do {
      const part = local(at);
      const end = s.ended_at > at ? Math.min(s.ended_at, at + 3600 - part.minute * 60 - part.second) : at;
      const cumulative = s.ended_at > s.started_at
        ? Math.round(s.seconds * (end - s.started_at) / (s.ended_at - s.started_at)) : s.seconds;
      const seconds = cumulative - allocated;
      allocated = cumulative;
      if (seconds > 0) {
        days.set(part.date, (days.get(part.date) ?? 0) + seconds);
        const hour = part.hour;
        out.global.tod[hour >= 6 && hour < 12 ? 0 : hour >= 12 && hour < 18 ? 1 : hour >= 18 ? 2 : 3] += seconds;
        out.global.dow[(new Date(part.date).getUTCDay() + 6) % 7] += seconds;
      }
      at = end;
    } while (at < s.ended_at);
  }
  out.daily = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds }));
  const history = Buffer.alloc(HISTORY_BYTES);
  let last = -Infinity;
  let streak = 0;
  for (const d of out.daily) {
    const day = Math.floor((Date.parse(d.date) - EPOCH) / DAY_MS);
    anchor = Math.max(anchor, day);
    streak = day === last + 1 ? streak + 1 : 1;
    out.global.streak = Math.max(out.global.streak, streak);
    last = day;
  }
  for (const d of out.daily) {
    const bit = anchor - Math.floor((Date.parse(d.date) - EPOCH) / DAY_MS);
    if (bit >= 0 && bit < HISTORY_DAYS) history[bit >> 3] |= 1 << (bit & 7);
  }
  out.global.anchor_day = out.daily.length ? anchor : 0;
  out.global.history_b64 = history.toString('base64');
  out.book = { ...out.book, sessions: out.global.sessions, seconds: out.global.seconds,
    tod: out.global.tod, dow: out.global.dow,
    start_date: out.daily.length ? Date.parse(out.daily[0].date) / 1000 : 0 };
  return out;
}

export function bookorbitExclusions(stats: BookorbitStats) {
  return { excluded_sessions: stats.excluded_sessions, excluded_seconds: stats.excluded_seconds,
    reason: stats.excluded_sessions ? 'Exported CrossPoint sessions, repeated BookOrbit IDs, and exact duplicate records are counted once.' : null };
}

import { exportBookorbitSessions } from './bookorbit-session-export.js';
import { withTransaction, type DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import { bookorbitStatsJson } from './bookorbit.js';
import { resolveMatch } from './runner.js';
import { fetchTransport } from './registry.js';
import { decryptCredential, getAccount, listMatches, setAccountStatus } from './store.js';
import { ConnectorOperationError, type Credential, type HttpTransport } from './types.js';

const PAGE_SIZE = 100;
const PAGES_PER_PASS = 5;
const BOOKS_PER_PASS = 3;
const REFRESH_SECONDS = 3600;
interface SyncState {
  active_generation: number;
  next_page: number;
  expected_total: number | null;
  cutoff: string | null;
  timezone: string;
  refreshed_at: number;
}
interface Session {
  id: number; start: number; end: number; seconds: number; source: string | null;
}

function parseSession(raw: any): Session {
  const start = typeof raw?.startedAt === 'string' ? Date.parse(raw.startedAt) / 1000 : NaN;
  const end = typeof raw?.endedAt === 'string' ? Date.parse(raw.endedAt) / 1000 : NaN;
  if (!Number.isSafeInteger(raw?.id) || raw.id <= 0 || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end < start || end - start > 366 * 86400 ||
      !Number.isSafeInteger(raw?.durationSeconds) || raw.durationSeconds < 0 || raw.durationSeconds > 0xffffffff ||
      (raw.source != null && (typeof raw.source !== 'string' || raw.source.length > 64))) {
    throw new Error('BookOrbit returned an invalid reading session');
  }
  return { id: raw.id, start, end, seconds: raw.durationSeconds, source: raw.source ?? null };
}

/** One bounded chunk of a full-history reconciliation. Progress sync never waits for it. */
async function importBook(
  db: DB, userId: number, externalId: string, cred: Credential, credentialVersion: string,
  timezone: string, http: HttpTransport
): Promise<void> {
  const current = () => {
    const account = getAccount(db, userId, 'bookorbit');
    return account?.enabled && account.status === 'ok' && account.cred_enc === credentialVersion &&
      listMatches(db, userId, 'bookorbit').some((m) => m.external_id === externalId);
  };
  if (!current()) return;
  db.prepare('INSERT INTO bookorbit_stats_sync (user_id, external_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .run(userId, externalId);
  let state = db.prepare('SELECT * FROM bookorbit_stats_sync WHERE user_id = ? AND external_id = ?')
    .get(userId, externalId) as unknown as SyncState;
  if (!state.cutoff && state.refreshed_at > nowSeconds() - REFRESH_SECONDS) return;
  db.prepare('UPDATE bookorbit_stats_sync SET attempted_at = ? WHERE user_id = ? AND external_id = ?')
    .run(nowSeconds(), userId, externalId);
  if (!state.cutoff) {
    const cutoff = new Date().toISOString();
    db.prepare('UPDATE bookorbit_stats_sync SET cutoff = ?, next_page = 1, expected_total = NULL WHERE user_id = ? AND external_id = ?')
      .run(cutoff, userId, externalId);
    state = { ...state, cutoff, next_page: 1, expected_total: null };
  }
  const generation = state.active_generation + 1;
  for (let n = 0; n < PAGES_PER_PASS; n++) {
    const query = new URLSearchParams({ page: String(state.next_page), pageSize: String(PAGE_SIZE),
      sortBy: 'startedAt', sortDir: 'asc', dateTo: state.cutoff! });
    const body = await bookorbitStatsJson(cred, http, `/books/${encodeURIComponent(externalId)}/sessions?${query}`);
    if (!current()) return;
    if (!Array.isArray(body?.items) || !Number.isSafeInteger(body.total) || body.total < 0 ||
        body.page !== state.next_page || body.pageSize !== PAGE_SIZE || body.items.length > PAGE_SIZE ||
        (state.expected_total !== null && body.total !== state.expected_total)) {
      // The caller resets staging, retaining the last published generation.
      throw new Error('BookOrbit reading history changed or returned an invalid page; retrying the import');
    }
    const items: Session[] = body.items.map(parseSession);
    const total: number = body.total;
    const complete = state.next_page * PAGE_SIZE >= total;
    if (items.length !== Math.min(PAGE_SIZE, Math.max(0, total - (state.next_page - 1) * PAGE_SIZE))) {
      throw new Error('BookOrbit returned an incomplete reading history page');
    }
    withTransaction(db, () => {
      const insert = db.prepare(`INSERT INTO bookorbit_stats_sessions
        (user_id, external_id, generation, session_id, started_at, ended_at, seconds, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET
        started_at = excluded.started_at, ended_at = excluded.ended_at, seconds = excluded.seconds, source = excluded.source`);
      for (const s of items) insert.run(userId, externalId, generation, s.id, s.start, s.end, s.seconds, s.source);
      if (complete) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM bookorbit_stats_sessions WHERE user_id = ? AND external_id = ? AND generation = ?')
          .get(userId, externalId, generation) as { n: number };
        if (count.n !== total) throw new Error('BookOrbit returned duplicate or missing reading sessions');
        db.prepare(`UPDATE bookorbit_stats_sync SET active_generation = ?, next_page = 1, expected_total = NULL,
          cutoff = NULL, timezone = ?, refreshed_at = ? WHERE user_id = ? AND external_id = ?`)
          .run(generation, timezone, nowSeconds(), userId, externalId);
        db.prepare('DELETE FROM bookorbit_stats_sessions WHERE user_id = ? AND external_id = ? AND generation != ?')
          .run(userId, externalId, generation);
      } else {
        db.prepare('UPDATE bookorbit_stats_sync SET next_page = ?, expected_total = ? WHERE user_id = ? AND external_id = ?')
          .run(state.next_page + 1, total, userId, externalId);
      }
    });
    if (complete) return;
    state = { ...state, next_page: state.next_page + 1, expected_total: total };
  }
}

interface ImportOptions { document?: string; force?: boolean; throwOnError?: boolean }
// Serialize exports/imports per account; scoped requests must not share another book's result.
const pending = new WeakMap<DB, Map<number, Promise<number>>>();
export function importBookorbitStats(db: DB, userId: number, http: HttpTransport = fetchTransport, options: ImportOptions = {}): Promise<number> {
  let users = pending.get(db);
  if (!users) { users = new Map(); pending.set(db, users); }
  const existing = users.get(userId);
  if (existing) return options.document
    ? existing.catch(() => 0).then(() => importBookorbitStats(db, userId, http, options)) : existing;
  const run = importAccount(db, userId, http, options).finally(() => users!.delete(userId));
  users.set(userId, run);
  return run;
}

async function importAccount(db: DB, userId: number, http: HttpTransport, options: ImportOptions): Promise<number> {
  const account = getAccount(db, userId, 'bookorbit');
  if (!account?.enabled || account.status !== 'ok') return 0;
  // Each request has its own deadline; imports run outside device progress requests.
  const bounded: HttpTransport = (url, init) => http(url, { ...init,
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  try {
    if (options.force && options.document) {
      db.prepare(`UPDATE bookorbit_stats_sync SET refreshed_at=0 WHERE user_id=? AND external_id IN
        (SELECT external_id FROM connector_matches WHERE user_id=? AND connector_id='bookorbit' AND document=?)`)
        .run(userId, userId, options.document);
    }
    await exportBookorbitSessions(db, userId, bounded, options.document);
    const cred = decryptCredential(account, db);
    // Include old/finished books already known to Sync, not just today's open book.
    const unmatched = db.prepare(`SELECT d.document FROM documents d WHERE d.user_id = ?
      AND NOT EXISTS (SELECT 1 FROM connector_matches m WHERE m.user_id = d.user_id
        AND m.connector_id = 'bookorbit' AND m.document = d.document)
      AND (d.title IS NOT NULL OR d.filename IS NOT NULL) AND (? IS NULL OR d.document=?) ORDER BY d.document LIMIT 3`)
      .all(userId, options.document ?? null, options.document ?? null) as { document: string }[];
    for (const d of unmatched) {
      if (getAccount(db, userId, 'bookorbit')?.cred_enc !== account.cred_enc) return 0;
      await resolveMatch(db, 'bookorbit', userId, d.document, bounded);
    }
    const books = db.prepare(`SELECT DISTINCT m.external_id FROM connector_matches m
      LEFT JOIN bookorbit_stats_sync s ON s.user_id = m.user_id AND s.external_id = m.external_id
      WHERE m.user_id = ? AND m.connector_id = 'bookorbit' AND m.external_id IS NOT NULL
        AND (? IS NULL OR m.document=?)
        AND NOT EXISTS (SELECT 1 FROM bookorbit_session_exports e
          JOIN bookorbit_session_destination dest ON dest.user_id=e.user_id AND dest.destination=e.destination
          JOIN reading_sessions local USING(user_id, device_id, session_id)
          WHERE e.user_id=m.user_id AND e.external_id=m.external_id AND e.prior_ids IS NOT NULL
            AND (e.remote_id IS NULL OR e.exported_seconds < local.seconds))
        AND (s.refreshed_at IS NULL OR s.cutoff IS NOT NULL OR s.refreshed_at <= ?)
      ORDER BY COALESCE(s.attempted_at, 0), m.external_id LIMIT ?`)
      .all(userId, options.document ?? null, options.document ?? null, nowSeconds() - REFRESH_SECONDS, BOOKS_PER_PASS) as { external_id: string }[];
    if (!books.length) return 0;
    const me = await bookorbitStatsJson(cred, bounded, '/auth/me');
    let timezone = typeof me?.settings?.timezone === 'string' ? me.settings.timezone : 'UTC';
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { timezone = 'UTC'; }
    let imported = 0;
    for (const b of books) {
      try {
        await importBook(db, userId, b.external_id, cred, account.cred_enc, timezone, bounded);
        imported++;
      } catch (err) {
        if (err instanceof ConnectorOperationError) throw err;
        // A malformed/changing page must not leave us retrying a broken final
        // page forever. Published data stays intact while backfill starts over.
        if (getAccount(db, userId, 'bookorbit')?.cred_enc === account.cred_enc) {
          withTransaction(db, () => {
            db.prepare(`DELETE FROM bookorbit_stats_sessions WHERE user_id = ? AND external_id = ?
              AND generation > (SELECT active_generation FROM bookorbit_stats_sync WHERE user_id = ? AND external_id = ?)`)
              .run(userId, b.external_id, userId, b.external_id);
            db.prepare('UPDATE bookorbit_stats_sync SET cutoff = NULL, next_page = 1, expected_total = NULL WHERE user_id = ? AND external_id = ?')
              .run(userId, b.external_id);
          });
        }
        console.error(JSON.stringify({ msg: 'BookOrbit stats import failed', user_id: userId,
          error: err instanceof Error ? err.message : 'invalid history' }));
        if (options.throwOnError) throw err;
      }
    }
    return imported;
  } catch (err) {
    if (getAccount(db, userId, 'bookorbit')?.cred_enc === account.cred_enc &&
        err instanceof ConnectorOperationError && err.needsReauth) {
      setAccountStatus(db, userId, 'bookorbit', 'needs_reauth', err.message);
    }
    console.error(JSON.stringify({ msg: 'BookOrbit stats import failed', user_id: userId,
      error: err instanceof Error ? err.message : 'request failed' }));
    if (options.throwOnError) throw err;
    return 0;
  }
}

export async function pollBookorbitStats(db: DB, http: HttpTransport = fetchTransport): Promise<number> {
  const users = db.prepare("SELECT user_id FROM connector_accounts WHERE connector_id = 'bookorbit' AND enabled = 1 AND status = 'ok'")
    .all() as { user_id: number }[];
  let count = 0;
  for (const u of users) count += await importBookorbitStats(db, u.user_id, http);
  return count;
}

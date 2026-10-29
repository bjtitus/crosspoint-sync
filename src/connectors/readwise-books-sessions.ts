import type { DB } from '../db/db.js';
import { resolveDocument, statsDocuments } from '../models/merge.js';
import { nowSeconds } from '../models/sync.js';
import { deleteSession, postSession, timezoneFor, type SessionInput } from './readwise-books.js';
import { fetchTransport } from './registry.js';
import { resolveMatch } from './runner.js';
import { decryptCredential, getAccount, listAllEnabledAccounts, setAccountStatus } from './store.js';
import { ConnectorOperationError, type Credential, type HttpTransport } from './types.js';

/**
 * Exports measured reading sessions (PUT /api/v1/stats/sessions, sent by CrossInk
 * firmware) to Readwise Books as finished ebook sessions. Stock CrossPoint and
 * KOReader send no sessions; their shelf state still syncs through the connector's
 * progress events, and the `position_sessions` option can mirror the position.
 *
 * Readwise sessions carry a start and end percentage. Devices report only time,
 * so the percentages come from the progress history (progress_log): the last
 * position before the session began, and the furthest position reached by the
 * end of it plus a grace period (the progress sync lands shortly after the
 * session flush, on the same connection or the next one).
 *
 * A device checkpoint can still grow after upload, and Readwise cannot change a
 * session's duration (PATCH only edits the caption). So a session is exported
 * once it has settled, and one that grows afterwards is deleted on Readwise and
 * posted again. Export rows outlive an unlink: relinking the same account must
 * not post everything twice.
 */

export const CONNECTOR_ID = 'readwise-books';
/** A checkpoint this old is taken as final. */
export const SETTLE_SECONDS = 30 * 60;
/** How long after a session ends its progress sync may still land. */
const END_GRACE_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 8;
const BACKOFF = [60, 300, 900, 3600, 10800, 21600, 43200, 86400];
const REQUEST_TIMEOUT_MS = 15_000;

interface Row {
  device_id: string;
  session_id: string;
  document: string;
  started_at: number;
  ended_at: number;
  seconds: number;
  utc_offset_minutes: number;
  device_name: string | null;
  remote_id: number | null;
  exported_seconds: number | null;
  attempts: number | null;
  attempted_at: number | null;
}

function due(row: Row, now: number): boolean {
  const attempts = row.attempts ?? 0;
  if (attempts >= MAX_ATTEMPTS) return false;
  if (attempts === 0) return true;
  return (row.attempted_at ?? 0) + BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] <= now;
}

/** Start/end reading fractions for a session, from the progress history. */
export function percentBounds(
  db: DB,
  userId: number,
  canonical: string,
  session: { document: string; started_at: number; ended_at: number }
): { start: number; end: number } {
  const docs = [...new Set([canonical, session.document, ...statsDocuments(db, userId, canonical)])];
  const marks = docs.map(() => '?').join(',');
  const before = db
    .prepare(`SELECT percentage FROM progress_log WHERE user_id = ? AND document IN (${marks}) AND at <= ? ORDER BY at DESC LIMIT 1`)
    .get(userId, ...docs, session.started_at) as { percentage: number } | undefined;
  const within = db
    .prepare(
      `SELECT MIN(percentage) AS lo, MAX(percentage) AS hi FROM progress_log
       WHERE user_id = ? AND document IN (${marks}) AND at > ? AND at <= ?`
    )
    .get(userId, ...docs, session.started_at, session.ended_at + END_GRACE_SECONDS) as { lo: number | null; hi: number | null };
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const start = clamp(before?.percentage ?? within.lo ?? 0);
  const end = Math.max(start, clamp(within.hi ?? start));
  return { start, end };
}

export function sessionInput(bookId: number, row: Row, bounds: { start: number; end: number }): SessionInput {
  const span = row.ended_at - row.started_at;
  return {
    book_id: bookId,
    started_at: new Date(row.started_at * 1000).toISOString(),
    ended_at: new Date(row.ended_at * 1000).toISOString(),
    paused_seconds: Math.max(0, span - row.seconds),
    format: 'ebook',
    percent_at_start: bounds.start,
    percent_at_end: bounds.end,
    ...(timezoneFor(row.utc_offset_minutes) ? { timezone: timezoneFor(row.utc_offset_minutes) } : {}),
    device: { model: row.device_name?.trim() || 'CrossPoint', type: 'E-Reader' },
    publish_to_feed: false,
  };
}

// One pass per user at a time; a request-triggered pass queues behind a running one.
const pending = new WeakMap<DB, Map<number, Promise<number>>>();

/**
 * Export this user's settled, not-yet-exported (or grown) sessions. `document`
 * scopes a pass to one book (Sync now on a book page). Returns how many were posted.
 */
export function exportReadwiseSessions(db: DB, userId: number, http: HttpTransport = fetchTransport, document?: string): Promise<number> {
  let users = pending.get(db);
  if (!users) {
    users = new Map();
    pending.set(db, users);
  }
  const running = users.get(userId);
  if (running) return running.catch(() => 0).then(() => exportReadwiseSessions(db, userId, http, document));
  const run = exportUser(db, userId, http, document).finally(() => users!.delete(userId));
  users.set(userId, run);
  return run;
}

async function exportUser(db: DB, userId: number, http: HttpTransport, document?: string): Promise<number> {
  const account = getAccount(db, userId, CONNECTOR_ID);
  if (!account?.enabled || account.status !== 'ok') return 0;
  const cred: Credential = decryptCredential(account, db);
  const current = () => {
    const a = getAccount(db, userId, CONNECTOR_ID);
    return !!a?.enabled && a.status === 'ok' && a.cred_enc === account.cred_enc;
  };
  const bounded: HttpTransport = (url, init) =>
    http(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  const now = nowSeconds();
  const limit = document ? 100 : 10;
  const rows = (
    db
      .prepare(
        `SELECT s.device_id, s.session_id, s.document, s.started_at, s.ended_at, s.seconds, s.utc_offset_minutes,
                (SELECT p.device FROM progress p WHERE p.user_id = s.user_id AND p.device_id = s.device_id
                   ORDER BY p.updated_at DESC LIMIT 1) AS device_name,
                e.remote_id, e.exported_seconds, e.attempts, e.attempted_at
         FROM reading_sessions s
         LEFT JOIN readwise_books_session_exports e
           ON e.user_id = s.user_id AND e.device_id = s.device_id AND e.session_id = s.session_id
         WHERE s.user_id = ? AND s.ended_at <= ?
           AND (e.session_id IS NULL OR e.exported_seconds < s.seconds OR e.exported_ended_at < s.ended_at)
           AND (? IS NULL OR s.document = ?
                OR s.document IN (SELECT alias FROM document_aliases WHERE user_id = s.user_id AND document = ?))
         ORDER BY COALESCE(e.attempted_at, 0), s.started_at
         LIMIT ?`
      )
      .all(userId, now - SETTLE_SECONDS, document ?? null, document ?? null, document ?? null, limit * 3) as unknown as Row[]
  )
    .filter((r) => due(r, now))
    .slice(0, limit);

  let exported = 0;
  const key = (row: Row) => [userId, row.device_id, row.session_id] as const;
  for (const row of rows) {
    if (!current()) break;
    db.prepare(
      `INSERT INTO readwise_books_session_exports (user_id, device_id, session_id, attempts, attempted_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id, device_id, session_id) DO UPDATE SET attempts = attempts + 1, attempted_at = excluded.attempted_at`
    ).run(...key(row), now);
    try {
      const canonical = resolveDocument(db, userId, row.document);
      // No event here, so an unknown book is not created on Readwise: the
      // progress sync that accompanies a session does that, and until then the
      // session waits.
      const match = await resolveMatch(db, CONNECTOR_ID, userId, canonical, bounded);
      const bookId = Number(match?.externalId);
      if (!match || !Number.isSafeInteger(bookId) || bookId <= 0) throw new Error('no book match for reading session');
      if (!current()) break;
      const input = sessionInput(bookId, row, percentBounds(db, userId, canonical, row));
      if (row.remote_id != null) {
        await deleteSession(cred, bounded, row.remote_id);
        // The old session is gone whatever happens next; never try to delete it twice.
        db.prepare('UPDATE readwise_books_session_exports SET remote_id = NULL WHERE user_id = ? AND device_id = ? AND session_id = ?').run(...key(row));
      }
      if (!current()) break;
      const remoteId = await postSession(cred, bounded, input);
      db.prepare(
        `UPDATE readwise_books_session_exports
         SET remote_id = ?, exported_seconds = ?, exported_ended_at = ?, attempts = 0, last_error = NULL
         WHERE user_id = ? AND device_id = ? AND session_id = ?`
      ).run(remoteId, row.seconds, row.ended_at, ...key(row));
      exported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reading session export failed';
      db.prepare('UPDATE readwise_books_session_exports SET last_error = ? WHERE user_id = ? AND device_id = ? AND session_id = ?')
        .run(message.slice(0, 500), ...key(row));
      if (err instanceof ConnectorOperationError && err.needsReauth) {
        setAccountStatus(db, userId, CONNECTOR_ID, 'needs_reauth', message);
        break;
      }
      // Rate limited or Readwise is down: the rest of this pass would fail the same way.
      if (err instanceof ConnectorOperationError && err.retryable) break;
    }
  }
  return exported;
}

/** Every linked account, for the periodic worker (settled sessions need a later pass). Returns sessions posted. */
export async function exportAllReadwiseSessions(db: DB, http: HttpTransport = fetchTransport): Promise<number> {
  let exported = 0;
  for (const a of listAllEnabledAccounts(db)) {
    if (a.connector_id !== CONNECTOR_ID) continue;
    try {
      exported += await exportReadwiseSessions(db, a.user_id, http);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'readwise-books session export failed', user_id: a.user_id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return exported;
}

/** Export failures shown with the connector (alongside queue errors), shaped like them. */
export function sessionExportErrors(db: DB, userId: number): { kind: string; message: string; count: number; titles: string[] }[] {
  const rows = db
    .prepare(
      `SELECT e.last_error AS message, COUNT(*) AS count,
              json_group_array(DISTINCT COALESCE(d.title, d.filename, 'Untitled book')) AS titles
       FROM readwise_books_session_exports e
       JOIN reading_sessions s ON s.user_id = e.user_id AND s.device_id = e.device_id AND s.session_id = e.session_id
       LEFT JOIN documents d ON d.user_id = s.user_id AND d.document = s.document
       WHERE e.user_id = ? AND e.last_error IS NOT NULL
       GROUP BY e.last_error ORDER BY MAX(e.attempted_at) DESC LIMIT 3`
    )
    .all(userId) as { message: string; count: number; titles: string }[];
  return rows.map((r) => ({ kind: 'reading session', message: r.message, count: r.count, titles: (JSON.parse(r.titles) as string[]).sort() }));
}

import { resolveDocument } from '../models/merge.js';
import type { DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import { bookorbitDestination, type ReadingSession } from '../models/reading-sessions.js';
import { bookorbitConnector, bookorbitStatsJson, saveBookorbitSession } from './bookorbit.js';
import { decryptCredential, getAccount } from './store.js';
import { resolveMatch } from './runner.js';
import { ConnectorOperationError, type Credential, type HttpTransport } from './types.js';

interface Export extends ReadingSession {
  user_id: number; device_id: string; destination: string; export_id: string;
  external_id: string | null; file_id: string | null; prior_ids: string | null; remote_id: number | null; payload: string | null;
}

// BookOrbit currently returns a numeric row ID, not the submitted sessionId.
// Compare a complete bounded window before/after POST and retain its exact ID.
async function matchingIds(cred: Credential, http: HttpTransport, row: Export): Promise<number[]> {
  const ids: number[] = [];
  let expected: number | null = null;
  for (let page = 1; page <= 5; page++) {
    const query = new URLSearchParams({ page: String(page), pageSize: '100', sortBy: 'startedAt', sortDir: 'asc',
      dateFrom: new Date(row.started_at * 1000).toISOString(), dateTo: new Date(row.ended_at * 1000).toISOString() });
    const body = await bookorbitStatsJson(cred, http, `/books/${encodeURIComponent(row.external_id!)}/sessions?${query}`);
    if (!Array.isArray(body?.items) || !Number.isSafeInteger(body.total) || body.total < 0 ||
        body.page !== page || body.pageSize !== 100 || (expected !== null && expected !== body.total) ||
        body.items.length !== Math.min(100, Math.max(0, body.total - (page - 1) * 100))) {
      throw new Error('BookOrbit session verification returned an incomplete or changing page');
    }
    expected = body.total;
    for (const s of body.items) {
      if (!Number.isSafeInteger(s?.id) || s.id <= 0) throw new Error('Invalid BookOrbit session ID');
      if (String(s.bookFileId) === row.file_id && Date.parse(s.startedAt) === row.started_at * 1000 &&
          Date.parse(s.endedAt) === row.ended_at * 1000 && s.durationSeconds === row.seconds &&
          s.source === 'web' && (s.sessionType == null || s.sessionType === 'read')) ids.push(s.id);
    }
    if (page * 100 >= body.total) return ids;
  }
  throw new Error('BookOrbit session verification window is too large');
}

/** Called inside the per-user stats worker lock, before history reconciliation. */
export async function exportBookorbitSessions(db: DB, userId: number, http: HttpTransport, document?: string): Promise<void> {
  const account = getAccount(db, userId, 'bookorbit');
  if (!account?.enabled || account.status !== 'ok') return;
  const cred = decryptCredential(account, db);
  const destination = bookorbitDestination(cred);
  db.prepare(`INSERT INTO bookorbit_session_destination VALUES (?, ?) ON CONFLICT(user_id)
    DO UPDATE SET destination=excluded.destination`).run(userId, destination);
  const current = () => {
    const a = getAccount(db, userId, 'bookorbit');
    return a?.enabled && a.status === 'ok' && a.cred_enc === account.cred_enc;
  };
  // Create stable outbound identities even if this service is not yet matched.
  db.prepare(`INSERT INTO bookorbit_session_exports (user_id, device_id, session_id, destination, export_id)
    SELECT s.user_id, s.device_id, s.session_id, ?, lower(hex(randomblob(16))) FROM reading_sessions s WHERE s.user_id=?
    AND (? IS NULL OR s.document=? OR s.document IN (SELECT alias FROM document_aliases WHERE user_id=s.user_id AND document=?))
    AND NOT EXISTS (SELECT 1 FROM bookorbit_session_exports e WHERE e.user_id=s.user_id
      AND e.device_id=s.device_id AND e.session_id=s.session_id AND e.destination=?) LIMIT 100
    ON CONFLICT DO NOTHING`).run(destination, userId, document ?? null, document ?? null, document ?? null, destination);
  const rows = db.prepare(`SELECT s.*, e.destination, e.export_id, e.external_id, e.file_id, e.prior_ids, e.remote_id, e.payload
    FROM reading_sessions s JOIN bookorbit_session_exports e USING(user_id, device_id, session_id)
    WHERE s.user_id=? AND e.destination=? AND e.exported_seconds < s.seconds
    AND (? IS NULL OR s.document=? OR s.document IN (SELECT alias FROM document_aliases WHERE user_id=s.user_id AND document=?))
    ORDER BY e.attempted_at, s.created_at LIMIT ?`).all(userId, destination, document ?? null, document ?? null, document ?? null,
      document ? 100 : 5) as unknown as Export[];
  for (const row of rows) {
    if (!current()) return;
    const key = [userId, row.device_id, row.session_id, destination];
    db.prepare(`UPDATE bookorbit_session_exports SET attempted_at=? WHERE user_id=? AND device_id=? AND session_id=? AND destination=?`)
      .run(nowSeconds(), ...key);
    try {
      // Finish ownership verification of an uncertain checkpoint before sending
      // a newer one. A timeout must not change the preflight comparison window.
      if (row.remote_id === null && row.payload) Object.assign(row, JSON.parse(row.payload));
      if (!row.external_id || !row.file_id) {
        const match = await resolveMatch(db, 'bookorbit', userId, resolveDocument(db, userId, row.document), http);
        if (!match) throw new Error('no book match for reading session');
        // Cached progress matches need not have resolved an edition yet.
        let file = match.externalEdition;
        if (!file) {
          file = await bookorbitConnector.resolveEdition!(cred, match.externalId, http);
        }
        if (!file) throw new Error('book has no EPUB file for reading session');
        row.external_id = match.externalId; row.file_id = file;
      }
      if (!current()) return;
      if (row.prior_ids === null) {
        row.prior_ids = JSON.stringify(await matchingIds(cred, http, row));
        if (!current()) return;
        // Commit BEFORE POST: a lost response must not lose our ownership boundary.
        db.prepare(`UPDATE bookorbit_session_exports SET external_id=?, file_id=?, prior_ids=?, payload=?
          WHERE user_id=? AND device_id=? AND session_id=? AND destination=?`)
          .run(row.external_id, row.file_id, row.prior_ids, JSON.stringify({started_at:row.started_at, ended_at:row.ended_at, seconds:row.seconds}), ...key);
      }
      if (!current()) return;
      await saveBookorbitSession(cred, http, row.file_id, {
        sessionId: `cps-${row.export_id}`, startedAt: new Date(row.started_at * 1000).toISOString(),
        endedAt: new Date(row.ended_at * 1000).toISOString(), durationSeconds: row.seconds, sessionType: 'read',
      });
      const before = new Set<number>(JSON.parse(row.prior_ids));
      const matching = await matchingIds(cred, http, row);
      const added = row.remote_id === null ? matching.filter((id) => !before.has(id)) : matching.filter((id) => id === row.remote_id);
      const claimed = db.prepare(`SELECT 1 FROM bookorbit_session_exports WHERE user_id=? AND destination=? AND remote_id=?`);
      if (added.length !== 1 || (row.remote_id === null && claimed.get(userId, destination, added[0]))) throw new Error('BookOrbit session ownership could not be verified; history import for this book is deferred');
      if (!current()) return;
      db.prepare(`UPDATE bookorbit_session_exports SET remote_id=?, exported_seconds=?, last_error=NULL
        WHERE user_id=? AND device_id=? AND session_id=? AND destination=?`).run(added[0], row.seconds, ...key);
      db.prepare('UPDATE bookorbit_stats_sync SET refreshed_at=0 WHERE user_id=? AND external_id=?').run(userId, row.external_id);
    } catch (err) {
      db.prepare(`UPDATE bookorbit_session_exports SET last_error=? WHERE user_id=? AND device_id=? AND session_id=? AND destination=?`)
        .run(err instanceof Error ? err.message : 'Reading session export failed', ...key);
      if (err instanceof ConnectorOperationError && err.needsReauth) throw err;
    }
  }
}

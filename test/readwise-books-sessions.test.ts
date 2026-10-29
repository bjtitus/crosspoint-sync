import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { exportReadwiseSessions, percentBounds, SETTLE_SECONDS } from '../src/connectors/readwise-books-sessions.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { saveMatch, upsertAccount } from '../src/connectors/store.js';
import type { HttpTransport } from '../src/connectors/types.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'e'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

const now = Math.floor(Date.now() / 1000);
// A session that ended long enough ago to count as settled: 20 minutes of reading
// inside a 30-minute span (10 minutes idle), in New York winter time.
const settled = {
  session_id: 'sess1', document: DOC,
  started_at: now - SETTLE_SECONDS - 3600, ended_at: now - SETTLE_SECONDS - 1800,
  seconds: 1200, utc_offset_minutes: -300,
};

async function fixture(opts: { match?: boolean } = {}) {
  const posts: { method: string; url: string; body?: unknown }[] = [];
  let nextId = 9000;
  let refuse: string | null = null;
  let status = 200;
  const http: HttpTransport = async (url, init) => {
    const reply = (body: unknown, s = 200) => ({ status: s, json: async () => body, text: async () => JSON.stringify(body) });
    const u = new URL(url);
    if (init.method === 'POST' && u.pathname.endsWith('/sessions')) {
      posts.push({ method: 'POST', url, body: JSON.parse(init.body as string) });
      if (status !== 200) return reply({ error: { message: 'down' } }, status);
      if (refuse) return reply({ results: [{ status: 'error', session_id: null, error: refuse }] });
      return reply({ results: [{ status: 'created', session_id: nextId++, error: null }] });
    }
    if (init.method === 'DELETE' && u.pathname.endsWith('/sessions')) {
      posts.push({ method: 'DELETE', url });
      return reply({ results: [{ id: Number(u.searchParams.get('ids')), status: 'deleted', error: null }] });
    }
    if (init.method === 'GET' && u.pathname.endsWith('/books')) {
      // Library walk for matching: empty, so an unmatched book stays unmatched.
      return reply({ results: [], next: null });
    }
    throw new Error(`Unexpected ${init.method} ${url}`);
  };
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const user = await registerUser(app);
  const userId = (db.prepare('SELECT id FROM users WHERE username = ?').get(user.username) as { id: number }).id;
  upsertAccount(db, userId, 'readwise-books', { token: 'rw' }, null);
  if (opts.match !== false) saveMatch(db, userId, 'readwise-books', DOC, { externalId: '4815162', confidence: 1 }, 'manual');
  // The device's progress rows: name the device, and leave a position history.
  db.prepare(`INSERT INTO progress (user_id, document, device_id, device, percentage, progress, position, updated_at)
    VALUES (?, ?, 'reader1', 'CrossInk', 0.5, '/body/x', NULL, ?)`).run(userId, DOC, now);
  const log = db.prepare('INSERT INTO progress_log (user_id, document, device_id, percentage, at) VALUES (?, ?, ?, ?, ?)');
  log.run(userId, DOC, 'reader1', 0.2, settled.started_at - 86400); // yesterday's position
  log.run(userId, DOC, 'reader1', 0.31, settled.ended_at + 60); // synced right after the session
  log.run(userId, DOC, 'reader1', 0.5, settled.ended_at + 7200); // a later session's position
  // `quiet` stores the sessions without the upload-triggered export pass, so a
  // test can drive exactly one pass itself.
  const submit = async (items: unknown[] = [settled], quiet = false) => {
    if (quiet) db.prepare('UPDATE connector_accounts SET enabled = 0 WHERE user_id = ?').run(userId);
    const res = await app.request('/api/v1/stats/sessions', { method: 'PUT', headers: user.headers, body: JSON.stringify({ device_id: 'reader1', items }) });
    if (quiet) db.prepare('UPDATE connector_accounts SET enabled = 1 WHERE user_id = ?').run(userId);
    return res;
  };
  const exportRow = () => db.prepare('SELECT * FROM readwise_books_session_exports WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;
  return { app, db, userId, headers: user.headers, http, posts, submit, exportRow, setRefuse: (m: string | null) => { refuse = m; }, setStatus: (s: number) => { status = s; } };
}

describe('percentBounds', () => {
  it('uses the position before the session and the furthest position by the end grace', async () => {
    const f = await fixture();
    expect(percentBounds(f.db, f.userId, DOC, settled)).toEqual({ start: 0.2, end: 0.31 });
  });
  it('falls back to the first in-session position, then to zero, and never goes backwards', async () => {
    const f = await fixture();
    f.db.prepare('DELETE FROM progress_log WHERE user_id = ?').run(f.userId);
    expect(percentBounds(f.db, f.userId, DOC, settled)).toEqual({ start: 0, end: 0 });
    f.db.prepare('INSERT INTO progress_log (user_id, document, device_id, percentage, at) VALUES (?, ?, ?, ?, ?)')
      .run(f.userId, DOC, 'reader1', 0.42, settled.started_at + 10);
    expect(percentBounds(f.db, f.userId, DOC, settled)).toEqual({ start: 0.42, end: 0.42 });
  });
});

describe('readwise-books session export', () => {
  it('exports a settled session as an ebook session with pauses, percentages, zone and device', async () => {
    const f = await fixture();
    expect((await f.submit()).status).toBe(200);
    await exportReadwiseSessions(f.db, f.userId, f.http); // waits for the upload-triggered pass
    const sent = f.posts.filter((p) => p.method === 'POST');
    expect(sent).toHaveLength(1);
    expect((sent[0].body as { items: unknown[] }).items[0]).toEqual({
      book_id: 4815162,
      started_at: new Date(settled.started_at * 1000).toISOString(),
      ended_at: new Date(settled.ended_at * 1000).toISOString(),
      paused_seconds: 600,
      format: 'ebook',
      percent_at_start: 0.2,
      percent_at_end: 0.31,
      timezone: 'Etc/GMT+5',
      device: { model: 'CrossInk', type: 'E-Reader' },
      publish_to_feed: false,
    });
    expect(f.exportRow()).toMatchObject({ remote_id: 9000, exported_seconds: 1200, attempts: 0, last_error: null });
  });

  it('posts a session once, even across repeated passes and re-uploads', async () => {
    const f = await fixture();
    await f.submit();
    await exportReadwiseSessions(f.db, f.userId, f.http);
    await f.submit();
    await exportReadwiseSessions(f.db, f.userId, f.http);
    await exportReadwiseSessions(f.db, f.userId, f.http);
    expect(f.posts.filter((p) => p.method === 'POST')).toHaveLength(1);
  });

  it('a checkpoint that grows after export is deleted on Readwise and posted again', async () => {
    const f = await fixture();
    await f.submit();
    await exportReadwiseSessions(f.db, f.userId, f.http);
    await f.submit([{ ...settled, seconds: 1500, ended_at: settled.ended_at + 300 }]);
    await exportReadwiseSessions(f.db, f.userId, f.http);
    expect(f.posts.map((p) => p.method)).toEqual(['POST', 'DELETE', 'POST']);
    expect(f.posts[1].url).toContain('ids=9000');
    expect(((f.posts[2].body as { items: { paused_seconds: number }[] }).items[0]).paused_seconds).toBe(600);
    expect(f.exportRow()).toMatchObject({ remote_id: 9001, exported_seconds: 1500 });
  });

  it('a fresh checkpoint waits until it has settled', async () => {
    const f = await fixture();
    await f.submit([{ ...settled, session_id: 'fresh', started_at: now - 1200, ended_at: now - 60, seconds: 600 }]);
    await exportReadwiseSessions(f.db, f.userId, f.http);
    expect(f.posts).toHaveLength(0);
  });

  it('an unmatched book records the error and keeps the session for later', async () => {
    const f = await fixture({ match: false });
    await f.submit();
    await exportReadwiseSessions(f.db, f.userId, f.http);
    expect(f.posts).toHaveLength(0);
    expect(f.exportRow()).toMatchObject({ remote_id: null, attempts: 1, last_error: 'no book match for reading session' });
    // The failure shows with the connector in the list.
    const list = await (await f.app.request('/api/v1/connectors', { headers: f.headers })).json();
    expect(list.connectors.find((c: { id: string }) => c.id === 'readwise-books').queue_errors).toEqual([
      { kind: 'reading session', message: 'no book match for reading session', count: 1, titles: ['Untitled book'] },
    ]);
  });

  it('a refusal from Readwise is kept as the error and retried later with backoff', async () => {
    const f = await fixture();
    f.setRefuse('percent_at_end out of range');
    await f.submit();
    await exportReadwiseSessions(f.db, f.userId, f.http);
    expect(f.exportRow()).toMatchObject({ attempts: 1, last_error: expect.stringContaining('percent_at_end out of range') });
    // Not due again yet: nothing posted on an immediate second pass.
    await exportReadwiseSessions(f.db, f.userId, f.http);
    expect(f.posts.filter((p) => p.method === 'POST')).toHaveLength(1);
  });

  it('a server failure stops the pass and leaves the sessions pending', async () => {
    const f = await fixture();
    f.setStatus(503);
    const earlier = { ...settled, session_id: 'sess0', started_at: settled.started_at - 7200, ended_at: settled.ended_at - 7200 };
    expect((await f.submit([earlier, settled], true)).status).toBe(200);
    await exportReadwiseSessions(f.db, f.userId, f.http);
    expect(f.posts.filter((p) => p.method === 'POST')).toHaveLength(1); // stopped after the first 503
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM readwise_books_session_exports').get() as { n: number }).n).toBe(1);
    expect(f.exportRow()).toMatchObject({ session_id: 'sess0', remote_id: null, attempts: 1, last_error: expect.stringContaining('server 503') });
    // Once Readwise is back, the untouched session goes first; the failed one waits out its backoff.
    f.setStatus(200);
    await exportReadwiseSessions(f.db, f.userId, f.http);
    const posted = f.posts.filter((p) => p.method === 'POST');
    expect(posted).toHaveLength(2);
    expect((posted[1].body as { items: { started_at: string }[] }).items[0].started_at).toBe(new Date(settled.started_at * 1000).toISOString());
  });

  it('does nothing without a linked, healthy account', async () => {
    const f = await fixture();
    f.db.prepare(`UPDATE connector_accounts SET status = 'needs_reauth' WHERE user_id = ?`).run(f.userId);
    await f.submit();
    expect(await exportReadwiseSessions(f.db, f.userId, f.http)).toBe(0);
    expect(f.posts).toHaveLength(0);
  });
});

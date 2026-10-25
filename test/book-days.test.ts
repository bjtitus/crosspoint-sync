import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteDocumentData } from '../src/models/document.js';
import { makeTestApp, registerUser } from './helpers.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

const book = (document: string, over: Record<string, unknown> = {}) => ({
  document, v: 5, sessions: 2, seconds: 1200, pages: 0, completed: false, avg_fwd: 0, pace_n: 0, eta: 0,
  start_manual: false, finish_manual: false, start_date: 0, finished_date: 0, tod: [0, 0, 0, 0],
  dow: [0, 0, 0, 0, 0, 0, 0], ...over,
});

afterEach(() => vi.useRealTimers());

describe('per-book days', () => {
  it('are uploaded with the snapshot, kept at the larger value and returned per device and combined', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = (deviceId: string, items: unknown[]) =>
      app.request('/api/v1/stats/books', { method: 'PUT', headers, body: JSON.stringify({ device_id: deviceId, items }) });

    const res = await put('x4', [book(A, { daily: [{ date: '2026-10-20', seconds: 600 }, { date: '2026-10-21', seconds: 600 }] })]);
    expect(await res.json()).toMatchObject({ accepted: 1, accepted_daily: 2 });
    await put('x4', [book(A, { daily: [{ date: '2026-10-21', seconds: 300 }] })]); // a smaller resend changes nothing
    await put('kobo', [book(A, { daily: [{ date: '2026-10-21', seconds: 120 }] })]);
    await put('kobo', [book(B)]); // no days: still accepted

    const one = await (await app.request(`/api/v1/stats/books/${A}`, { headers })).json();
    const x4 = one.devices.find((d: { device_id: string }) => d.device_id === 'x4');
    expect(x4.stats.daily).toEqual([{ date: '2026-10-20', seconds: 600 }, { date: '2026-10-21', seconds: 600 }]);
    expect(one.combined.daily).toEqual([{ date: '2026-10-20', seconds: 600 }, { date: '2026-10-21', seconds: 720 }]);

    const bad = await put('x4', [book(A, { daily: [{ date: '2026-02-30', seconds: 60 }] })]);
    expect(bad.status).toBe(403);
  });

  it('list every book a page at a time, with metadata, optionally for one device', async () => {
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    db.prepare('INSERT INTO documents (user_id, document, title, filename, language, updated_at) VALUES (?, ?, ?, ?, ?, 0)')
      .run(id, A, 'Kokoro', 'kokoro.epub', 'ja');
    const put = (deviceId: string, items: unknown[]) =>
      app.request('/api/v1/stats/books', { method: 'PUT', headers, body: JSON.stringify({ device_id: deviceId, items }) });
    await put('x4', [book(A, { daily: [{ date: '2026-10-20', seconds: 600 }] }), book(B)]);
    await put('kobo', [book(A)]);

    const first = await (await app.request('/api/v1/stats/books?limit=2', { headers })).json();
    expect(first.items.map((i: { device_id: string; document: string }) => [i.document, i.device_id])).toEqual([
      [A, 'kobo'],
      [A, 'x4'],
    ]);
    expect(first.items[1]).toMatchObject({ title: 'Kokoro', filename: 'kokoro.epub', language: 'ja' });
    expect(first.items[1].stats.daily).toEqual([{ date: '2026-10-20', seconds: 600 }]);
    expect(first.items[0].stats.daily).toEqual([]);
    const second = await (await app.request(`/api/v1/stats/books?limit=2&cursor=${first.next}`, { headers })).json();
    expect(second.items.map((i: { document: string }) => i.document)).toEqual([B]);
    expect(second.next).toBeNull();

    const own = await (await app.request('/api/v1/stats/books?device_id=x4', { headers })).json();
    expect(own.items.map((i: { device_id: string }) => i.device_id)).toEqual(['x4', 'x4']);
    const all = await (await app.request('/api/v1/stats/books?device_id=', { headers })).json();
    expect(all.items).toHaveLength(3);
  });

  it('drive reading days and today in a filtered overview, and go with the book', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T18:00:00Z'));
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    db.prepare('INSERT INTO documents (user_id, document, language, updated_at) VALUES (?, ?, ?, 0)').run(id, A, 'ja');
    const daily = [{ date: '2026-10-23', seconds: 900 }, { date: '2026-10-24', seconds: 300 }];
    await app.request('/api/v1/stats/books', {
      method: 'PUT', headers, body: JSON.stringify({ device_id: 'x4', items: [book(A, { daily })] }),
    });
    const o = await (await app.request('/api/v1/stats/overview?days=10&language=ja', { headers })).json();
    expect(o).toMatchObject({ reading_days: 2, current_streak: 2, seconds: 1200, today_seconds: 300, week_seconds: 1200 });

    deleteDocumentData(db, id, A);
    expect(db.prepare('SELECT COUNT(*) AS n FROM stats_device_book_day').get()).toEqual({ n: 0 });
  });

  it('count imported BookOrbit time in a filtered overview, only for the matched book', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T18:00:00Z'));
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    const doc = db.prepare('INSERT INTO documents (user_id, document, language, updated_at) VALUES (?, ?, ?, 0)');
    doc.run(id, A, 'ja');
    doc.run(id, B, 'ja');
    db.prepare("INSERT INTO connector_accounts (user_id, connector_id, cred_enc, created_at, updated_at) VALUES (?, 'bookorbit', '', 0, 0)").run(id);
    db.prepare("INSERT INTO connector_matches (user_id, connector_id, document, external_id, source, updated_at) VALUES (?, 'bookorbit', ?, 'orbit-1', 'manual', 0)").run(id, A);
    db.prepare("INSERT INTO bookorbit_stats_sync (user_id, external_id, active_generation, timezone) VALUES (?, 'orbit-1', 1, 'UTC')").run(id);
    const start = Date.parse('2026-10-24T08:00:00Z') / 1000;
    db.prepare('INSERT INTO bookorbit_stats_sessions (user_id, external_id, generation, session_id, started_at, ended_at, seconds) VALUES (?, ?, 1, 1, ?, ?, 600)')
      .run(id, 'orbit-1', start, start + 600);

    const o = await (await app.request('/api/v1/stats/overview?days=10&group_by=language', { headers })).json();
    expect(o.groups.ja).toMatchObject({ reading_days: 1, seconds: 600, sessions: 1, today_seconds: 600 });
  });
});

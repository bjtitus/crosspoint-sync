import { describe, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';

// Seeds rows directly so timestamps (and ties between them) are under the test's control.
async function setup() {
  const { app, db } = makeTestApp();
  const me = await registerUser(app);
  const other = await registerUser(app);
  const id = (u: string) => (db.prepare('SELECT id FROM users WHERE username = ?').get(u) as { id: number }).id;
  const progress = db.prepare(
    "INSERT INTO progress (user_id, document, device_id, device, percentage, progress, updated_at) VALUES (?, ?, ?, 'x', 0.5, 'p', ?)"
  );
  const documents = db.prepare('INSERT INTO documents (user_id, document, title, updated_at) VALUES (?, ?, ?, ?)');
  return { app, db, me, myId: id(me.username), otherId: id(other.username), progress, documents };
}

const doc = (n: number) => `doc${String(n).padStart(5, '0')}`;
// Seven books share each timestamp, so ties straddle every page boundary.
const at = (n: number) => 1_700_000_000 + Math.floor(n / 7);

async function pages(app: ReturnType<typeof makeTestApp>['app'], headers: Record<string, string>, path: string) {
  const seen: string[] = [];
  const sizes: number[] = [];
  let next: string | null = null;
  for (let i = 0; i < 100; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await app.request(next ? `${path}${sep}cursor=${encodeURIComponent(next)}` : path, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { document: string }[]; next: string | null };
    sizes.push(body.items.length);
    seen.push(...body.items.map((b) => b.document));
    next = body.next;
    if (!next) return { seen, sizes };
  }
  throw new Error('paging never ended');
}

// Newest first, ties by document descending: the order the cursor relies on.
const expected = (count: number) =>
  Array.from({ length: count }, (_, n) => n).sort((a, b) => at(b) - at(a) || doc(b).localeCompare(doc(a))).map(doc);

describe('GET /api/v1/progress paging', () => {
  it('returns every book exactly once, in order, across pages', async () => {
    const { app, me, myId, otherId, progress } = await setup();
    for (let n = 0; n < 1203; n++) progress.run(myId, doc(n), 'reader', at(n));
    // A second device with the same time must not duplicate the book.
    for (let n = 0; n < 1203; n += 50) progress.run(myId, doc(n), 'phone', at(n));
    for (let n = 0; n < 30; n++) progress.run(otherId, `other${n}`, 'reader', at(n));

    const { seen, sizes } = await pages(app, me.headers, '/api/v1/progress?limit=500');
    expect(sizes).toEqual([500, 500, 203]);
    expect(seen).toEqual(expected(1203));
  });

  it('pages correctly when ties straddle tiny pages', async () => {
    const { app, me, myId, progress } = await setup();
    for (let n = 0; n < 40; n++) progress.run(myId, doc(n), 'reader', at(n));
    const { seen, sizes } = await pages(app, me.headers, '/api/v1/progress?limit=3');
    expect(sizes.every((s) => s <= 3)).toBe(true);
    expect(seen).toEqual(expected(40));
  });

  it('has no next page when the books fill the page exactly', async () => {
    const { app, me, myId, progress } = await setup();
    for (let n = 0; n < 500; n++) progress.run(myId, doc(n), 'reader', at(n));
    const body = await (await app.request('/api/v1/progress?limit=500', { headers: me.headers })).json();
    expect(body.items).toHaveLength(500);
    expect(body.next).toBeNull();
  });

  it('keeps the old response for a small library', async () => {
    const { app, me, myId, progress } = await setup();
    progress.run(myId, doc(1), 'reader', at(1));
    const body = await (await app.request('/api/v1/progress', { headers: me.headers })).json();
    expect(body.items.map((b: { document: string }) => b.document)).toEqual([doc(1)]);
    expect(body.next).toBeNull();
  });

  it('rejects a malformed cursor', async () => {
    const { app, me } = await setup();
    for (const bad of ['abc', '12:', ':doc1', '12:bad doc', '12:../x', '-1:doc1', '1.5:doc1']) {
      const res = await app.request(`/api/v1/progress?cursor=${encodeURIComponent(bad)}`, { headers: me.headers });
      expect(res.status, bad).toBe(403);
    }
  });

  it('never returns another account’s books on later pages', async () => {
    const { app, me, myId, otherId, progress } = await setup();
    for (let n = 0; n < 10; n++) progress.run(myId, doc(n), 'reader', at(n));
    for (let n = 0; n < 10; n++) progress.run(otherId, doc(n + 100), 'reader', at(n));
    const { seen } = await pages(app, me.headers, '/api/v1/progress?limit=4');
    expect(seen).toEqual(expected(10));
  });
});

describe('GET /api/v1/documents paging', () => {
  it('returns every document exactly once across 500-item pages', async () => {
    const { app, me, myId, otherId, documents } = await setup();
    for (let n = 0; n < 1001; n++) documents.run(myId, doc(n), `Book ${n}`, at(n));
    documents.run(otherId, 'otherdoc', 'Not mine', at(5));
    const { seen, sizes } = await pages(app, me.headers, '/api/v1/documents');
    expect(sizes).toEqual([500, 500, 1]);
    expect(seen).toEqual(expected(1001));
  });

  it('rejects a malformed cursor', async () => {
    const { app, me } = await setup();
    const res = await app.request('/api/v1/documents?cursor=nope', { headers: me.headers });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/connectors/:id/review paging', () => {
  it('lists every synced book once across pages, newest first', async () => {
    const { app, me, myId, otherId, progress } = await setup();
    for (let n = 0; n < 1005; n++) progress.run(myId, doc(n), 'reader', at(n));
    // An older position on another device must not move the book.
    for (let n = 0; n < 1005; n += 40) progress.run(myId, doc(n), 'phone', at(n) - 5000);
    progress.run(otherId, 'otherdoc', 'reader', at(3));
    const seen: string[] = [];
    const sizes: number[] = [];
    let next: string | null = null;
    do {
      const res = await app.request(
        `/api/v1/connectors/hardcover/review${next ? `?cursor=${encodeURIComponent(next)}` : ''}`,
        { headers: me.headers }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { books: { document: string }[]; next: string | null };
      sizes.push(body.books.length);
      seen.push(...body.books.map((b) => b.document));
      next = body.next;
    } while (next && sizes.length < 10);
    expect(sizes).toEqual([500, 500, 5]);
    expect(seen).toEqual(expected(1005));
  });

  it('rejects a malformed cursor', async () => {
    const { app, me } = await setup();
    expect((await app.request('/api/v1/connectors/hardcover/review?cursor=x', { headers: me.headers })).status).toBe(403);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HttpTransport } from '../src/connectors/types.js';
import { readwiseBooksConnector, timezoneFor } from '../src/connectors/readwise-books.js';
import { setConnectorOptions, upsertAccount } from '../src/connectors/store.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

// Records calls; answers with the last-registered handler whose match string
// appears in "METHOD url" or the body.
function fakeTransport() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const h = [...handlers].reverse().find((x) => `${init.method} ${url}`.includes(x.match) || (init.body ?? '').includes(x.match));
    const status = h?.status ?? 200;
    const body = h?.body ?? {};
    return { status, text: async () => JSON.stringify(body), json: async () => body };
  };
  return { transport: t, calls, on: (m: string, s: number, b: unknown) => handlers.push({ match: m, status: s, body: b }) };
}

const CRED = { token: 'rw_books_token' };
const book = (over: Record<string, unknown> = {}) => ({
  id: 4815162,
  title: 'Middlemarch',
  author: 'George Eliot',
  status: 'unsorted',
  progress: 0.1,
  started_reading_at: null,
  finished_reading_at: null,
  product: { id: '1', title: 'Middlemarch', author: 'George Eliot' },
  ...over,
});
const META = { document: DOC, title: 'Middlemarch', author: 'George Eliot', filename: null };

describe('readwise-books connector', () => {
  it('validates with GET /books?limit=1 and the Token header', async () => {
    const fake = fakeTransport();
    fake.on('GET https://readwise.io/books/api/v1/books?limit=1', 200, { results: [], next: null });
    const v = await readwiseBooksConnector.validate(CRED, fake.transport);
    expect(v.ok).toBe(true);
    expect(fake.calls[0].url).toBe('https://readwise.io/books/api/v1/books?limit=1');
  });

  it('reports an invalid token on 401', async () => {
    const fake = fakeTransport();
    fake.on('/books?limit=1', 401, { error: { code: 'unauthenticated', message: 'bad token' } });
    expect((await readwiseBooksConnector.validate(CRED, fake.transport)).ok).toBe(false);
  });

  it('matches a document against the library, skipping the Deleted shelf and following pages', async () => {
    const fake = fakeTransport();
    fake.on('GET https://readwise.io/books/api/v1/books?limit=1000', 200, {
      results: [book({ id: 1, title: 'Middlemarch', status: 'deleted' }), book({ id: 2, title: 'Silas Marner' })],
      next: 'https://readwise.io/books/api/v1/books?limit=1000&cursor=abc',
    });
    fake.on('cursor=abc', 200, { results: [book({ id: 3, title: 'Middlemarch' })], next: null });
    const m = await readwiseBooksConnector.match(CRED, META, fake.transport);
    expect(m?.externalId).toBe('3');
    expect(m?.title).toBe('Middlemarch');
  });

  it('listCurrentlyReading filters by status and search looks through the library', async () => {
    const fake = fakeTransport();
    fake.on('status=currently_reading', 200, { results: [book({ id: 9, title: 'Daniel Deronda' })], next: null });
    const reading = await readwiseBooksConnector.listCurrentlyReading!(CRED, fake.transport);
    expect(reading).toEqual([{ externalId: '9', title: 'Daniel Deronda', author: 'George Eliot' }]);

    const lib = fakeTransport();
    lib.on('/books?limit=1000', 200, { results: [book({ id: 1, title: 'Dune', author: 'Frank Herbert' }), book({ id: 2 })], next: null });
    const found = await readwiseBooksConnector.search!(CRED, 'dune', lib.transport);
    expect(found.map((b) => b.externalId)).toEqual(['1']);
  });

  it('createBook posts title/author and shelf, and returns the library id', async () => {
    const fake = fakeTransport();
    fake.on('POST https://readwise.io/books/api/v1/books', 200, { results: [{ status: 'created', matched_by: 'title_author', book_id: 77, error: null }] });
    const m = await readwiseBooksConnector.createBook!(CRED, META, { kind: 'progress', document: DOC, percentage: 0.2, timestamp: 1_700_000_000 }, fake.transport);
    expect(m?.externalId).toBe('77');
    const sent = JSON.parse(fake.calls[0].body!);
    expect(sent.items[0]).toMatchObject({ product: { title: 'Middlemarch', author: 'George Eliot' }, status: 'currently_reading' });
    expect(sent.items[0].started_reading_at).toBe('2023-11-14T22:13:20.000Z');
  });

  it('createBook never seeds the library from a filename guess', async () => {
    const fake = fakeTransport();
    const m = await readwiseBooksConnector.createBook!(CRED, { document: DOC, title: null, author: null, filename: 'Middlemarch - Eliot.epub' },
      { kind: 'progress', document: DOC, percentage: 0.2, timestamp: 1 }, fake.transport);
    expect(m).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('progress on an unsorted book moves it to Currently reading with a start date', async () => {
    const fake = fakeTransport();
    fake.on('ids=4815162', 200, { results: [book()] });
    fake.on('PATCH https://readwise.io/books/api/v1/books', 200, { results: [{ id: 4815162, status: 'updated', error: null }] });
    const r = await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.3, timestamp: 1_700_000_000 }, fake.transport);
    expect(r.ok).toBe(true);
    const patch = fake.calls.find((c) => c.method === 'PATCH');
    expect(JSON.parse(patch!.body!)).toEqual({ items: [{ id: 4815162, status: 'currently_reading', started_reading_at: '2023-11-14T22:13:20.000Z' }] });
    // No position write without the option.
    expect(fake.calls.some((c) => c.url.endsWith('/sessions'))).toBe(false);
  });

  it('progress on a book already being read with a start date writes nothing', async () => {
    const fake = fakeTransport();
    fake.on('ids=4815162', 200, { results: [book({ status: 'currently_reading', started_reading_at: '2026-01-01T00:00:00Z' })] });
    const r = await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.5, timestamp: 1 }, fake.transport);
    expect(r.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('finishing sets Finished and the finish date (and a missing start date)', async () => {
    const fake = fakeTransport();
    fake.on('ids=4815162', 200, { results: [book({ status: 'currently_reading' })] });
    fake.on('PATCH https://readwise.io/books/api/v1/books', 200, { results: [{ id: 4815162, status: 'updated', error: null }] });
    const r = await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'finished', document: DOC, percentage: 1, timestamp: 1_700_000_000 }, fake.transport);
    expect(r.ok).toBe(true);
    const patch = JSON.parse(fake.calls.find((c) => c.method === 'PATCH')!.body!);
    expect(patch.items[0]).toEqual({ id: 4815162, status: 'finished', finished_reading_at: '2023-11-14T22:13:20.000Z', started_reading_at: '2023-11-14T22:13:20.000Z' });
  });

  it.each(['finished', 'did_not_finish'])('never reopens a %s book', async (status) => {
    const fake = fakeTransport();
    fake.on('ids=4815162', 200, { results: [book({ status })] });
    const r = await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1 }, fake.transport);
    expect(r.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('a Deleted book is acknowledged with a note instead of resurrected', async () => {
    const fake = fakeTransport();
    fake.on('ids=4815162', 200, { results: [book({ status: 'deleted' })] });
    const r = await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1 }, fake.transport);
    expect(r).toMatchObject({ ok: true });
    expect((r as { note?: string }).note).toMatch(/Deleted shelf/);
  });

  it('a book missing from the library fails permanently; 401 asks for re-auth; 429 retries', async () => {
    const gone = fakeTransport();
    gone.on('ids=4815162', 200, { results: [] });
    expect(await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1 }, gone.transport)).toMatchObject({ ok: false, retryable: false });

    const unauth = fakeTransport();
    unauth.on('ids=4815162', 401, { error: { code: 'unauthenticated', message: 'nope' } });
    expect(await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1 }, unauth.transport)).toMatchObject({ ok: false, needsReauth: true });

    const limited = fakeTransport();
    limited.on('ids=4815162', 429, {});
    expect(await readwiseBooksConnector.push({ token: 'other_token' }, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1 }, limited.transport)).toMatchObject({ ok: false, retryable: true });
    // That token is now parked: the next push makes no HTTP call.
    const parked = fakeTransport();
    expect(await readwiseBooksConnector.push({ token: 'other_token' }, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1 }, parked.transport)).toMatchObject({ ok: false, retryable: true });
    expect(parked.calls).toHaveLength(0);
  });

  it('lookup verifies a pasted book id', async () => {
    const fake = fakeTransport();
    fake.on('ids=4815162', 200, { results: [book()] });
    expect(await readwiseBooksConnector.lookup!(CRED, '4815162', fake.transport)).toEqual({ externalId: '4815162', title: 'Middlemarch', author: 'George Eliot' });
    expect(await readwiseBooksConnector.lookup!(CRED, 'not-a-number', fake.transport)).toBeNull();
  });

  it('maps whole-hour UTC offsets to Etc/GMT zones (sign inverted), nothing otherwise', () => {
    expect(timezoneFor(0)).toBe('Etc/UTC');
    expect(timezoneFor(-300)).toBe('Etc/GMT+5'); // New York in winter
    expect(timezoneFor(120)).toBe('Etc/GMT-2');
    expect(timezoneFor(330)).toBeUndefined(); // India: no Etc zone
  });
});

describe('readwise-books position mirroring option', () => {
  beforeEach(() => { process.env.TOKEN_ENC_KEY = 'd'.repeat(64); resetEncryptionKeyCache(); });
  afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

  async function linked(optionOn: boolean) {
    const { app, db } = makeTestApp();
    const user = await registerUser(app);
    const userId = (db.prepare('SELECT id FROM users WHERE username = ?').get(user.username) as { id: number }).id;
    upsertAccount(db, userId, 'readwise-books', CRED, null);
    if (optionOn) setConnectorOptions(db, userId, 'readwise-books', { position_sessions: true });
    return { db, userId };
  }

  it('posts a zero-time session from Readwise\'s position to the synced one when on', async () => {
    const { db, userId } = await linked(true);
    const fake = fakeTransport();
    fake.on('ids=4815162', 200, { results: [book({ status: 'currently_reading', started_reading_at: '2026-01-01T00:00:00Z', progress: 0.25 })] });
    fake.on('POST https://readwise.io/books/api/v1/sessions', 200, { results: [{ status: 'created', session_id: 501, error: null }] });
    const r = await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1_700_000_000 }, fake.transport, { db, userId });
    expect(r).toEqual({ ok: true });
    const post = fake.calls.find((c) => c.method === 'POST');
    expect(JSON.parse(post!.body!).items[0]).toEqual({
      book_id: 4815162,
      started_at: '2023-11-14T22:12:20.000Z',
      ended_at: '2023-11-14T22:13:20.000Z',
      paused_seconds: 60,
      format: 'ebook',
      percent_at_start: 0.25,
      percent_at_end: 0.4,
      publish_to_feed: false,
    });
  });

  it('skips the position write when Readwise is already at or past it, and when off', async () => {
    const { db, userId } = await linked(true);
    const fake = fakeTransport();
    fake.on('ids=4815162', 200, { results: [book({ status: 'currently_reading', started_reading_at: '2026-01-01T00:00:00Z', progress: 0.5 })] });
    await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1 }, fake.transport, { db, userId });
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    const off = await linked(false);
    const quiet = fakeTransport();
    quiet.on('ids=4815162', 200, { results: [book({ status: 'currently_reading', started_reading_at: '2026-01-01T00:00:00Z', progress: 0.1 })] });
    await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1 }, quiet.transport, { db: off.db, userId: off.userId });
    expect(quiet.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a refused position write keeps the shelf sync and surfaces a note', async () => {
    const { db, userId } = await linked(true);
    const fake = fakeTransport();
    fake.on('ids=4815162', 200, { results: [book({ progress: 0 })] });
    fake.on('PATCH https://readwise.io/books/api/v1/books', 200, { results: [{ id: 4815162, status: 'updated', error: null }] });
    fake.on('POST https://readwise.io/books/api/v1/sessions', 200, { results: [{ status: 'error', session_id: null, error: 'sessions need time' }] });
    const r = await readwiseBooksConnector.push(CRED, { externalId: '4815162', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, timestamp: 1_700_000_000 }, fake.transport, { db, userId });
    expect(r).toMatchObject({ ok: true });
    expect((r as { note?: string }).note).toMatch(/sessions need time/);
    expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpTransport } from '../src/connectors/types.js';
import { documentInfo } from '../src/models/cover.js';
import { resetHardcoverThrottle } from '../src/models/hardcover-catalog.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

// Hardcover finds the book with its own genres; the free cover sources find nothing.
const hardcover: HttpTransport = async (url) => {
  const hit = { id: '41398', slug: 'foundryside', title: 'Foundryside', author_names: ['Robert Jackson Bennett'], genres: ['Fantasy', 'Magic'] };
  const body = url.includes('hardcover') ? { data: { search: { results: { hits: [{ document: hit }] } } } } : {};
  return { status: 200, text: async () => JSON.stringify(body), json: async () => body };
};

beforeEach(() => resetHardcoverThrottle());

describe('manual genres', () => {
  it('sticks over Hardcover lookups and clears back to them', async () => {
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[2]', percentage: 0.2, device: 'X4', device_id: 'x4',
        metadata: { title: 'Foundryside', authors: 'Robert Jackson Bennett' } }),
    });
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    const put = (body: unknown) => app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify(body) });
    const listed = async () => ((await (await app.request('/api/v1/progress', { headers })).json()) as { items: { genres: string[] }[] }).items[0].genres;
    const enrich = () => documentInfo(db, id, DOC, hardcover, { HARDCOVER_API_KEY: 'k' }, { hardcover: true });

    expect((await put({ genres: 'Fantasy' })).status).toBe(403);
    expect((await put({ genres: [''] })).status).toBe(403);
    expect((await put({ genres: ['x'.repeat(65)] })).status).toBe(403);
    expect((await put({ genres: Array.from({ length: 11 }, (_, i) => `g${i}`) })).status).toBe(403);

    // Trimmed and de-duplicated, and back in the book list.
    expect(await (await put({ genres: [' Heist ', 'Heist', 'Fantasy'] })).json()).toMatchObject({ genres: ['Heist', 'Fantasy'] });
    expect(await listed()).toEqual(['Heist', 'Fantasy']);

    // Hardcover's lookup fills the other details but leaves the genres alone.
    await enrich();
    expect(await listed()).toEqual(['Heist', 'Fantasy']);
    expect(db.prepare('SELECT hc_slug FROM documents WHERE document = ?').get(DOC)).toEqual({ hc_slug: 'foundryside' });

    // null hands them back: the next lookup brings Hardcover's genres.
    expect(await (await put({ genres: null })).json()).toMatchObject({ genres: [] });
    await enrich();
    expect(await listed()).toEqual(['Fantasy', 'Magic']);

    // Other info edits don't touch manual genres.
    await put({ genres: ['Heist'] });
    await put({ page_count: 500 });
    expect(await listed()).toEqual(['Heist']);
  });
});

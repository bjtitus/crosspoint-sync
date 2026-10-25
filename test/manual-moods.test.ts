import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpTransport } from '../src/connectors/types.js';
import { documentInfo } from '../src/models/cover.js';
import { resetHardcoverThrottle } from '../src/models/hardcover-catalog.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

// Hardcover finds the book with its own moods; the free cover sources find nothing.
const hardcover: HttpTransport = async (url) => {
  const hit = { id: '41398', slug: 'foundryside', title: 'Foundryside', author_names: ['Robert Jackson Bennett'],
    moods: ['adventurous', 'funny'] };
  const body = url.includes('hardcover') ? { data: { search: { results: { hits: [{ document: hit }] } } } } : {};
  return { status: 200, text: async () => JSON.stringify(body), json: async () => body };
};

beforeEach(() => resetHardcoverThrottle());

const progress = (document: string) => ({
  method: 'PUT',
  body: JSON.stringify({ document, progress: '/body/DocFragment[2]', percentage: 0.2, device: 'X4', device_id: 'x4',
    metadata: { title: 'Foundryside', authors: 'Robert Jackson Bennett' } }),
});

describe('manual moods', () => {
  it('stick over Hardcover lookups and clear back to them', async () => {
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    await app.request('/syncs/progress', { ...progress(DOC), headers });
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    const put = (body: unknown) => app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify(body) });
    const listed = async () => ((await (await app.request('/api/v1/progress', { headers })).json()) as { items: { moods: string[] }[] }).items[0].moods;
    const enrich = () => documentInfo(db, id, DOC, hardcover, { HARDCOVER_API_KEY: 'k' }, { hardcover: true });

    expect((await put({ moods: 'tense' })).status).toBe(403);
    expect((await put({ moods: [''] })).status).toBe(403);
    expect((await put({ moods: Array.from({ length: 13 }, (_, i) => `m${i}`) })).status).toBe(403);

    // Trimmed and de-duplicated, returned, and in the book list.
    expect(await (await put({ moods: [' tense ', 'tense', 'dark'] })).json()).toMatchObject({ moods: ['tense', 'dark'] });
    expect(await listed()).toEqual(['tense', 'dark']);

    // Hardcover's lookup leaves them alone; null hands them back.
    await enrich();
    expect(await listed()).toEqual(['tense', 'dark']);
    expect(await (await put({ moods: null })).json()).toMatchObject({ moods: [] });
    await enrich();
    expect(await listed()).toEqual(['Adventurous', 'Funny']);  // as Hardcover stores them

    // Genres and moods are set apart: one never touches the other.
    await put({ moods: ['dark'] });
    await put({ genres: ['Heist'] });
    expect(await listed()).toEqual(['dark']);
  });

  it('keep manual moods through a merge, over Hardcover\'s', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    const OTHER = 'ffffffffffffffffffffffffffffffff';
    for (const document of [DOC, OTHER]) await app.request('/syncs/progress', { ...progress(document), headers });
    db.prepare('UPDATE documents SET moods = ? WHERE document = ?').run('["funny"]', DOC);
    await app.request(`/api/v1/documents/${OTHER}/info`, { method: 'PUT', headers, body: JSON.stringify({ moods: ['dark'] }) });

    const merge = await app.request('/api/v1/documents/merge', { method: 'POST', headers, body: JSON.stringify({ document: OTHER, into: DOC }) });
    expect(merge.status).toBe(200);
    expect(db.prepare('SELECT moods, moods_manual FROM documents WHERE document = ?').get(DOC)).toEqual({ moods: '["dark"]', moods_manual: 1 });
  });
});

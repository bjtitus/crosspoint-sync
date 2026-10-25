import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpTransport } from '../src/connectors/types.js';
import { documentInfo } from '../src/models/cover.js';
import { resetHardcoverThrottle } from '../src/models/hardcover-catalog.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

// Hardcover finds the book with its own details; the free cover sources find nothing.
const hardcover: HttpTransport = async (url) => {
  const hit = {
    id: '41398', slug: 'foundryside', title: 'Foundryside', author_names: ['Robert Jackson Bennett'],
    content_warnings: ['Violence'], description: 'A thief in Tevanne.', release_year: 2018,
    series_names: ['The Founders'], featured_series: { series: { id: 77 } }, featured_series_position: 1,
  };
  const body = url.includes('hardcover') ? { data: { search: { results: { hits: [{ document: hit }] } } } } : {};
  return { status: 200, text: async () => JSON.stringify(body), json: async () => body };
};

beforeEach(() => resetHardcoverThrottle());

const progress = (document: string) => ({
  method: 'PUT',
  body: JSON.stringify({ document, progress: '/body/DocFragment[2]', percentage: 0.2, device: 'X4', device_id: 'x4',
    metadata: { title: 'Foundryside', authors: 'Robert Jackson Bennett' } }),
});
const COLUMNS = 'content_warnings, description, release_year, series, series_position, hc_series_id';

describe('book details set by hand', () => {
  it('stick over Hardcover lookups and clear back to them', async () => {
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    await app.request('/syncs/progress', { ...progress(DOC), headers });
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    const put = (body: unknown) => app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify(body) });
    const row = () => db.prepare(`SELECT ${COLUMNS} FROM documents WHERE document = ?`).get(DOC);
    const enrich = () => documentInfo(db, id, DOC, hardcover, { HARDCOVER_API_KEY: 'k' }, { hardcover: true });

    await enrich();
    expect(row()).toEqual({ content_warnings: '["Violence"]', description: 'A thief in Tevanne.', release_year: 2018,
      series: 'The Founders', series_position: 1, hc_series_id: 77 });

    expect((await put({ release_year: 0 })).status).toBe(403);
    expect((await put({ release_year: '2018' })).status).toBe(403);
    expect((await put({ description: 'x'.repeat(6001) })).status).toBe(403);
    expect((await put({ series: '' })).status).toBe(403);
    expect((await put({ series_position: 2 })).status).toBe(403);  // a number needs its series
    expect((await put({ series: 'Tevanne', series_position: -1 })).status).toBe(403);

    const res = await put({ content_warnings: ['violence', 'Death'], description: ' Another one. ', release_year: 2020,
      series: 'Tevanne', series_position: 2.5 });
    expect(await res.json()).toMatchObject({ content_warnings: ['Violence', 'Death'], description: 'Another one.',
      release_year: 2020, series: 'Tevanne', series_position: 2.5 });
    // Hardcover's series id goes with the series it named.
    const set = { content_warnings: '["Violence","Death"]', description: 'Another one.', release_year: 2020,
      series: 'Tevanne', series_position: 2.5, hc_series_id: null };
    expect(row()).toEqual(set);

    // A lookup leaves them all alone.
    db.prepare('UPDATE documents SET hc_checked_at = NULL WHERE document = ?').run(DOC);
    await enrich();
    expect(row()).toEqual(set);

    // null hands one back; the others stay.
    await put({ series: null, description: null });
    await enrich();
    expect(row()).toEqual({ ...set, description: 'A thief in Tevanne.', series: 'The Founders', series_position: 1, hc_series_id: 77 });
  });

  it('keep a series set by hand together through a merge', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    const OTHER = 'ffffffffffffffffffffffffffffffff';
    for (const document of [DOC, OTHER]) await app.request('/syncs/progress', { ...progress(document), headers });
    db.prepare('UPDATE documents SET series = ?, series_position = 1, hc_series_id = 77 WHERE document = ?').run('The Founders', DOC);
    await app.request(`/api/v1/documents/${OTHER}/info`, { method: 'PUT', headers, body: JSON.stringify({ series: 'Tevanne', series_position: 3 }) });

    const merge = await app.request('/api/v1/documents/merge', { method: 'POST', headers, body: JSON.stringify({ document: OTHER, into: DOC }) });
    expect(merge.status).toBe(200);
    expect(db.prepare('SELECT series, series_position, hc_series_id, series_manual FROM documents WHERE document = ?').get(DOC))
      .toEqual({ series: 'Tevanne', series_position: 3, hc_series_id: null, series_manual: 1 });
  });

  it('keep a detail cleared by hand cleared through a merge', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    const OTHER = 'ffffffffffffffffffffffffffffffff';
    for (const document of [DOC, OTHER]) await app.request('/syncs/progress', { ...progress(document), headers });
    // No moods on purpose on the kept copy; Hardcover's on the other.
    await app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify({ moods: [] }) });
    db.prepare('UPDATE documents SET moods = ? WHERE document = ?').run('["Funny"]', OTHER);

    await app.request('/api/v1/documents/merge', { method: 'POST', headers, body: JSON.stringify({ document: OTHER, into: DOC }) });
    expect(db.prepare('SELECT moods, moods_manual FROM documents WHERE document = ?').get(DOC)).toEqual({ moods: null, moods_manual: 1 });
  });
});


import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const OTHER = 'ffffffffffffffffffffffffffffffff';

describe('book language', () => {
  it('comes from device metadata, sticks once set by hand, and survives a merge', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const sync = (document: string, language?: string) =>
      app.request('/syncs/progress', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document, progress: '/body/DocFragment[2]', percentage: 0.2, device: 'X4', device_id: 'x4',
          metadata: { title: '変な家２', authors: '雨穴', ...(language === undefined ? {} : { language }) } }),
      });
    const put = (body: unknown) => app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify(body) });
    const language = async (document = DOC) => {
      const items = ((await (await app.request('/api/v1/progress', { headers })).json()) as { items: { document: string; language: string | null }[] }).items;
      return items.find((i) => i.document === document)?.language;
    };

    // A malformed tag is dropped without failing the sync.
    expect((await sync(DOC, 'Japanese!')).status).toBe(200);
    expect(await language()).toBeNull();

    await sync(DOC, ' ja ');
    expect(await language()).toBe('ja');
    const docs = (await (await app.request('/api/v1/documents', { headers })).json()) as { items: { language: string }[] };
    expect(docs.items[0].language).toBe('ja');

    // Set by hand, it stays over later device syncs.
    expect((await put({ language: 'not a tag' })).status).toBe(403);
    expect(await (await put({ language: 'ja-JP' })).json()).toMatchObject({ language: 'ja-JP' });
    await sync(DOC, 'en');
    expect(await language()).toBe('ja-JP');

    // Cleared, the next device sync fills it again.
    await put({ language: null });
    await sync(DOC, 'ja');
    expect(await language()).toBe('ja');

    // A merge fills a blank language from the merged-away book.
    await sync(OTHER);
    await put({ language: null });
    await app.request(`/api/v1/documents/${OTHER}/info`, { method: 'PUT', headers, body: JSON.stringify({ language: 'ja' }) });
    const merge = await app.request('/api/v1/documents/merge', { method: 'POST', headers, body: JSON.stringify({ document: OTHER, into: DOC }) });
    expect(merge.status).toBe(200);
    expect(await language()).toBe('ja');
  });
});

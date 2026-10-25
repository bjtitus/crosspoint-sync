import { describe, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

describe('PUT /api/v1/documents', () => {
  it('takes the fields progress metadata takes, filling blanks', async () => {
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    const put = (items: unknown[]) =>
      app.request('/api/v1/documents', { method: 'PUT', headers, body: JSON.stringify({ items }) });

    const res = await put([
      { document: A, title: 'Kokoro', authors: 'Natsume Soseki', language: 'ja', filename: 'kokoro.epub',
        filesize: 1234, bookfusion_id: '36835' },
      { document: B, title: 'Der Zauberberg', author: 'Thomas Mann' }, // older clients' `author`
    ]);
    expect(await res.json()).toMatchObject({ accepted: 2 });
    const row = (doc: string) =>
      db.prepare('SELECT title, author, language, filename, filesize FROM documents WHERE user_id = ? AND document = ?').get(id, doc);
    expect(row(A)).toEqual({ title: 'Kokoro', author: 'Natsume Soseki', language: 'ja', filename: 'kokoro.epub', filesize: 1234 });
    expect(row(B)).toMatchObject({ author: 'Thomas Mann', language: null });
    // The exact service id seeds the connector match, as from progress.
    expect(db.prepare("SELECT external_id, source FROM connector_matches WHERE user_id = ? AND document = ?").get(id, A))
      .toEqual({ external_id: '36835', source: 'sidecar' });

    // A language already set stays; a bad tag is ignored, not stored.
    await put([{ document: A, language: 'en' }, { document: B, language: 'not a tag!' }]);
    expect(row(A)).toMatchObject({ language: 'ja', filesize: 1234 });
    expect(row(B)).toMatchObject({ language: null });
  });

  it('stores a merged copy\'s metadata on its book', async () => {
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    for (const document of [A, B]) {
      await app.request('/syncs/progress', {
        method: 'PUT', headers, body: JSON.stringify({ document, progress: 'p', percentage: 0.1, device_id: 'd' }),
      });
    }
    await app.request('/api/v1/documents/merge', { method: 'POST', headers, body: JSON.stringify({ document: B, into: A }) });
    await app.request('/api/v1/documents', {
      method: 'PUT', headers, body: JSON.stringify({ items: [{ document: B, language: 'de' }] }),
    });
    expect(db.prepare('SELECT language FROM documents WHERE user_id = ? AND document = ?').get(id, A)).toEqual({ language: 'de' });
  });
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HttpTransport } from '../src/connectors/types.js';
import { getConnector } from '../src/connectors/registry.js';
import { saveMatch, upsertAccount } from '../src/connectors/store.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertProgress } from '../src/routes/kosync.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'c'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); vi.restoreAllMocks(); });
const OTHER = '1234567890abcdef1234567890abcdef';

async function fixture(id: string) {
  const http = vi.fn<HttpTransport>(async () => { throw new Error('Unexpected network request'); });
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const { username, headers } = await registerUser(app);
  const { id: userId } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  upsertAccount(db, userId, id, { token: 'test' }, null);
  for (const document of [DOC, OTHER]) {
    upsertProgress(db, { userId, document, deviceId: 'x4', device: 'X4', percentage: 0.1,
      progress: '/old', position: null, metadata: null, updatedAt: 100 });
    if (id !== 'kosync') saveMatch(db, userId, id, document, { externalId: document, confidence: 1 }, 'manual');
  }
  const sync = () => app.request(`/api/v1/connectors/${id}/sync/${DOC}`, { method: 'POST', headers });
  return { app, db, userId, headers, sync, http };
}

it.each(['audiobookshelf', 'bookfusion', 'readwise-reader'])('%s pulls only the selected book before queueing its new position', async (id) => {
  const f = await fixture(id);
  const pull = vi.spyOn(getConnector(id)!, 'pullProgress').mockImplementation(async (_cred, match) => {
    expect(f.db.prepare('SELECT * FROM connector_queue').all()).toHaveLength(0);
    return { externalId: match.externalId, percentage: 1, finished: true, updatedAtMs: 200000, progress: '/new' };
  });
  const res = await f.sync();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ applied: 1, queued: 1 });
  expect(pull).toHaveBeenCalledTimes(1);
  expect(pull.mock.calls[0][1].externalId).toBe(DOC);
  const rows = f.db.prepare('SELECT document, payload FROM connector_queue').all();
  expect(rows).toHaveLength(1);
  expect(rows[0].document).toBe(DOC);
  expect(JSON.parse(String(rows[0].payload)).percentage).toBe(1);
});

it.each(['hardcover', 'microblog', 'kosync'])('%s queues one book without pulling', async (id) => {
  const f = await fixture(id);
  const res = await f.sync();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ applied: 0, queued: 1 });
  expect(f.http).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT document FROM connector_queue').all()).toEqual([{ document: DOC }]);
});

it('Kindle pulls without queueing a write back', async () => {
  const f = await fixture('kindle');
  vi.spyOn(getConnector('kindle')!, 'pullProgress').mockResolvedValue({
    externalId: DOC, percentage: 0.6, finished: false, updatedAtMs: 200000, furthestReadOnly: true,
  });
  expect(await (await f.sync()).json()).toEqual({ applied: 1, queued: 0 });
  expect(f.db.prepare('SELECT * FROM connector_queue').all()).toHaveLength(0);
});

it('does not queue writes on failed pulls or disabled accounts', async () => {
  const f = await fixture('audiobookshelf');
  const pull = vi.spyOn(getConnector('audiobookshelf')!, 'pullProgress').mockRejectedValue(new Error('Offline'));
  expect((await f.sync()).status).toBe(502);
  expect(f.db.prepare('SELECT * FROM connector_queue').all()).toHaveLength(0);
  f.db.prepare('UPDATE connector_accounts SET enabled=0').run();
  expect((await f.sync()).status).toBe(400);
  expect(pull).toHaveBeenCalledTimes(1);
});

it('exposes sync directions and document matching in book services', async () => {
  const f = await fixture('kosync');
  const res = await f.app.request(`/api/v1/documents/${DOC}/matches`, { headers: f.headers });
  expect((await res.json()).services).toEqual([expect.objectContaining({
    id: 'kosync', matched: true, match_by: 'document', sync: { read: false, write: true, enabled: true },
  })]);
});

it.each(['audiobookshelf', 'readwise-reader'])('%s HTTP failures cannot be mistaken for an empty pull', async (id) => {
  const f = await fixture(id);
  upsertAccount(f.db, f.userId, id, { token: 'failure-test', server: 'https://abs.test' }, null);
  f.http.mockImplementation(async () => ({ status: 503, json: async () => ({}), text: async () => 'Unavailable' }));
  expect((await f.sync()).status).toBe(502);
  expect(f.db.prepare('SELECT * FROM connector_queue').all()).toHaveLength(0);
});

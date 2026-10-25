import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { syncStreak } from '../src/routes/profile.js';

describe('public profile', () => {
  it('is off by default, shows reading and finished books when on, and 404s once off', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const other = 'b'.repeat(32);
    for (const [document, title, percentage] of [[DOC, 'Foundryside <b>', 0.4], [other, 'Piranesi', 1]] as const) {
      await app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify({ document, progress: 'x', percentage, device: 'X4', device_id: 'x4' }) });
      await app.request('/api/v1/documents', { method: 'PUT', headers, body: JSON.stringify({ items: [{ document, title }] }) });
      await app.request(`/api/v1/documents/${document}/info`, { method: 'PUT', headers, body: JSON.stringify({ page_count: document === DOC ? 250 : 0 }) });
    }
    expect(await (await app.request('/api/v1/profile', { headers })).json()).toEqual({ slug: null });

    const { slug } = (await (await app.request('/api/v1/profile', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).json()) as { slug: string };
    const page = await app.request(`/u/${slug}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Foundryside &lt;b&gt;');
    expect(html.indexOf('Reading now')).toBeLessThan(html.indexOf('Foundryside'));
    expect(html.indexOf('Finished')).toBeLessThan(html.indexOf('Piranesi'));
    // No device stats uploaded: no reading time, but pages come from the sync history.
    expect(html).not.toContain('hours read');
    expect(html).toContain('<b>100</b><span>pages read</span>');

    await app.request('/api/v1/profile', { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
    expect((await app.request(`/u/${slug}`)).status).toBe(404);
  });
});

describe('syncStreak', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  it('counts back from today, or from yesterday when today has no reading', () => {
    expect(syncStreak(['2026-10-23', '2026-10-24', '2026-10-25'], now)).toBe(3);
    expect(syncStreak(['2026-10-22', '2026-10-23', '2026-10-24'], now)).toBe(3);
    expect(syncStreak(['2026-10-21', '2026-10-23'], now)).toBe(0);
  });
});

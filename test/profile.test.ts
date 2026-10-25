import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

describe('public profile', () => {
  it('is off by default, shows reading and finished books when on, and 404s once off', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const other = 'b'.repeat(32);
    for (const [document, title, percentage] of [[DOC, 'Foundryside <b>', 0.4], [other, 'Piranesi', 1]] as const) {
      await app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify({ document, progress: 'x', percentage, device: 'X4', device_id: 'x4' }) });
      await app.request('/api/v1/documents', { method: 'PUT', headers, body: JSON.stringify({ items: [{ document, title }] }) });
    }
    expect(await (await app.request('/api/v1/profile', { headers })).json()).toEqual({ slug: null });

    const { slug } = (await (await app.request('/api/v1/profile', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).json()) as { slug: string };
    const page = await app.request(`/u/${slug}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Foundryside &lt;b&gt;');
    expect(html.indexOf('Reading now')).toBeLessThan(html.indexOf('Foundryside'));
    expect(html.indexOf('Finished')).toBeLessThan(html.indexOf('Piranesi'));

    await app.request('/api/v1/profile', { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
    expect((await app.request(`/u/${slug}`)).status).toBe(404);
  });
});

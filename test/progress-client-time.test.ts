import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const READ_AT = 1767254400; // 2026-01-01T08:00:00Z

describe('client time on PUT /api/v1/progress', () => {
  it('keeps when the position was read, and only on the API route', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const body = (percentage: number, device_id: string, timestamp?: unknown) =>
      JSON.stringify({ document: DOC, progress: 'p', percentage, device: device_id, device_id, ...(timestamp === undefined ? {} : { timestamp }) });
    const put = async (percentage: number, device_id: string, timestamp?: unknown) =>
      ((await (await app.request('/api/v1/progress', { method: 'PUT', headers, body: body(percentage, device_id, timestamp) })).json()) as { timestamp: number }).timestamp;
    const now = () => Math.floor(Date.now() / 1000);

    // A past time is stored as given, and the timeline puts the read on that day.
    expect(await put(0.2, 'importer', READ_AT)).toBe(READ_AT);
    const listed = (await (await app.request('/api/v1/progress', { headers })).json()) as { items: { timestamp: number }[] };
    expect(listed.items[0].timestamp).toBe(READ_AT);
    const activity = (await (await app.request('/api/v1/stats/activity', { headers })).json()) as { days: { day: string }[] };
    expect(activity.days.map((d) => d.day)).toContain('2026-01-01');

    // The future is capped at now; garbage and an unset clock mean now.
    const before = now();
    expect(await put(0.3, 'importer', now() + 86400)).toBeLessThanOrEqual(now());
    expect(await put(0.4, 'importer', '1767254400')).toBeGreaterThanOrEqual(before);
    expect(await put(0.5, 'importer', 12)).toBeGreaterThanOrEqual(before);

    // An older position from one device doesn't beat a newer one from another.
    await put(0.6, 'reader');
    await put(0.9, 'importer', READ_AT);
    const newest = (await (await app.request(`/syncs/progress/${DOC}`, { headers })).json()) as { percentage: number };
    expect(newest.percentage).toBe(0.6);

    // The kosync route ignores a client time.
    const res = await app.request('/syncs/progress', { method: 'PUT', headers, body: body(0.7, 'reader', READ_AT) });
    expect(((await res.json()) as { timestamp: number }).timestamp).toBeGreaterThanOrEqual(before);
  });
});

import { describe, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';

describe('GET /api/v1/stats/global', () => {
  it('filters by device and by upload time', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    const global = (deviceId: string, daily: unknown[]) => ({
      device_id: deviceId, device: deviceId, v: 5, sessions: 0, seconds: 0, pages: 0, completed: 0,
      tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0], anchor_day: 0, history_b64: '', streak: 0, daily,
    });
    const put = (body: unknown) => app.request('/api/v1/stats/global', { method: 'PUT', headers, body: JSON.stringify(body) });
    await put(global('x4', [{ date: '2026-10-20', seconds: 600 }, { date: '2026-10-21', seconds: 600 }]));
    await put(global('kobo', [{ date: '2026-10-21', seconds: 300 }]));

    const all = await (await app.request('/api/v1/stats/global', { headers })).json();
    expect(all.devices.map((d: { device_id: string }) => d.device_id).sort()).toEqual(['kobo', 'x4']);
    const own = await (await app.request('/api/v1/stats/global?device_id=x4', { headers })).json();
    expect(own.devices).toHaveLength(1);
    expect(own.devices[0].stats.daily).toHaveLength(2);
    // An empty device_id means no filter.
    expect((await (await app.request('/api/v1/stats/global?device_id=', { headers })).json()).devices).toHaveLength(2);

    const until = own.until as number;
    db.prepare("UPDATE stats_device_day SET updated_at = ? WHERE device_id = 'x4'").run(until - 10);
    db.prepare("UPDATE stats_device_day SET updated_at = ? WHERE device_id = 'x4' AND date = '2026-10-21'").run(until);
    const changed = await (await app.request(`/api/v1/stats/global?device_id=x4&since=${until}`, { headers })).json();
    expect(changed.devices[0].stats.daily).toEqual([{ date: '2026-10-21', seconds: 600 }]);
  });
});

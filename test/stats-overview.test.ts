import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';

const at = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;

afterEach(() => vi.useRealTimers());

describe('GET /api/v1/stats/overview', () => {
  it('sums every source into counts, streaks and a windowed reading-day bitmap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T18:00:00Z'));
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    const log = db.prepare('INSERT INTO progress_log (user_id, document, device_id, percentage, at) VALUES (?, ?, ?, ?, ?)');
    log.run(id, 'a'.repeat(32), 'libby', 0.2, at('2026-10-20')); // synced from elsewhere
    log.run(id, 'a'.repeat(32), 'libby', 0.4, at('2026-10-21'));
    log.run(id, 'b'.repeat(32), 'goodreads', 1, at('2025-12-01')); // finished last year
    log.run(id, 'c'.repeat(32), 'goodreads', 1, at('2026-03-01')); // finished this year
    // The reader's own minutes: yesterday and today.
    const global = {
      device_id: 'x4', device: 'CrossPoint', v: 5, sessions: 0, seconds: 3000, pages: 0, completed: 0,
      tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0], anchor_day: 0, history_b64: '', streak: 0,
      daily: [{ date: '2026-10-23', seconds: 2460 }, { date: '2026-10-24', seconds: 540 }],
    };
    expect((await app.request('/api/v1/stats/global', { method: 'PUT', headers, body: JSON.stringify(global) })).status).toBe(200);

    const res = await app.request('/api/v1/stats/overview?days=10', { headers });
    expect(res.status).toBe(200);
    const o = await res.json();
    expect(o).toMatchObject({
      anchor_day: 9793, // 2026-10-24
      days: 10,
      reading_days: 6,
      current_streak: 2, // 10-23 and 10-24; 10-22 was a gap
      longest_streak: 2,
      books_finished: 2,
      finished_this_year: 1,
      seconds: 3000,
      today_seconds: 540,
      week_seconds: 3000,
    });
    // Bit N = today - N within the 10-day window: today, yesterday, 3 and 4 days ago.
    expect(Buffer.from(o.history_b64, 'base64')).toEqual(Buffer.from([0b00011011, 0]));

    // The default window is a year; the cap keeps a careless request small.
    expect(Buffer.from((await (await app.request('/api/v1/stats/overview', { headers })).json()).history_b64, 'base64').length).toBe(46);
    expect((await (await app.request('/api/v1/stats/overview?days=99999', { headers })).json()).days).toBe(3650);
  });
});

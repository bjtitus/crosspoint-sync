import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDay, longestReadingStreak, readingStreak, shadeLevels } from './readingHistory.js'

const anchorDay = (date) => (Date.parse(`${date}T00:00:00Z`) - Date.UTC(2000, 0, 1)) / 86400000
const summary = (date, bits) => ({
  anchor_day: anchorDay(date), history_b64: btoa(String.fromCharCode(bits)), current_streak: 99,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 30, 12))
})
afterEach(() => vi.useRealTimers())

describe('current reading streak from grid dates', () => {
  it('joins overlapping device and sync dates without counting duplicates', () => {
    expect(readingStreak(summary('2026-09-29', 3), {
      reading_days: ['2026-09-29', '2026-09-30', '2026-09-30'],
    })).toBe(3)
  })

  it('keeps a streak ending yesterday but expires older device snapshots', () => {
    expect(readingStreak(summary('2026-09-29', 7))).toBe(3)
    expect(readingStreak(summary('2026-09-28', 7))).toBe(0)
    expect(readingStreak(summary('2026-09-30', 14))).toBe(3)
  })

  it('stops at gaps without filling the days between chosen dates', () => {
    expect(readingStreak(summary('2026-09-30', 1), {
      reading_days: ['2026-09-26', '2026-09-28'],
    })).toBe(1)
  })

  it('updates when chosen dates are added or removed', () => {
    const device = summary('2026-09-28', 1)
    expect(readingStreak(device, { reading_days: ['2026-09-29', '2026-09-30'] })).toBe(3)
    expect(readingStreak(device, { reading_days: ['2026-09-30'] })).toBe(1)
  })

  it('uses sync-only dates across month and year boundaries and ignores future dates', () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12))
    expect(readingStreak(null, {
      reading_days: ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'],
    })).toBe(3)
  })

  it('uses the device fallback only while dated history is unavailable', () => {
    expect(readingStreak({ current_streak: 8 }, null)).toBe(8)
    expect(readingStreak({ current_streak: 8 }, { reading_days: [] })).toBe(0)
    expect(readingStreak(summary('2026-09-30', 0))).toBe(0)
    expect(readingStreak(null, null)).toBe(0)
  })

  it('uses local calendar dates across daylight saving time changes', () => {
    vi.setSystemTime(new Date(2026, 10, 2, 0, 30))
    expect(readingStreak(null, { reading_days: ['2026-10-31', '2026-11-01', '2026-11-02'] })).toBe(3)
  })
})

describe('longest reading streak from combined dates', () => {
  it('joins device and sync dates without counting overlaps twice or using the old total', () => {
    expect(longestReadingStreak({ ...summary('2026-09-28', 3), streak: 99 }, {
      reading_days: ['2026-09-30', '2026-09-29', '2026-09-28', '2026-09-29'],
    })).toBe(4)
  })

  it('finds an older run and never fills gaps between chosen dates', () => {
    const device = summary('2026-09-30', 0b111001)
    expect(longestReadingStreak(device, { reading_days: ['2026-09-29'] })).toBe(3)
    expect(readingStreak(device, { reading_days: ['2026-09-29'] })).toBe(2)
  })

  it('updates when a chosen date bridges or breaks a run', () => {
    const device = summary('2026-09-28', 1)
    expect(longestReadingStreak(device, { reading_days: ['2026-09-29', '2026-09-30'] })).toBe(3)
    expect(longestReadingStreak(device, { reading_days: ['2026-09-30'] })).toBe(1)
  })

  it('includes sync-only runs older than the device window', () => {
    expect(longestReadingStreak(summary('2026-09-30', 1), {
      reading_days: ['2020-02-28', '2020-02-29', '2020-03-01'],
    })).toBe(3)
  })

  it('handles year boundaries and excludes future sync and device dates', () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12))
    expect(longestReadingStreak(null, {
      reading_days: ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'],
    })).toBe(3)
    expect(longestReadingStreak(summary('2027-01-03', 31))).toBe(3)
    expect(longestReadingStreak(null, { reading_days: ['2027-01-02'] })).toBe(0)
  })

  it('uses the device fallback only when dated history is unavailable', () => {
    expect(longestReadingStreak({ streak: 8 }, null)).toBe(8)
    expect(longestReadingStreak({ streak: 8 }, { reading_days: [] })).toBe(0)
    expect(longestReadingStreak({ ...summary('2026-09-30', 0), streak: 8 })).toBe(0)
    expect(longestReadingStreak(null, null)).toBe(0)
  })

  it('uses calendar dates across daylight saving time changes', () => {
    vi.setSystemTime(new Date(2026, 10, 2, 0, 30))
    expect(longestReadingStreak(null, { reading_days: ['2026-10-31', '2026-11-01', '2026-11-02'] })).toBe(3)
  })
})

describe('shade levels from the median day', () => {
  const days = (n, v, from = 1) => Array.from({ length: n }, (_, i) => [localDay(new Date(2026, 8, from + i)), v])

  it('uses the fallback with no data', () => {
    expect(shadeLevels([], { fallback: 30 }).baseline).toBe(30)
    expect(shadeLevels(days(3, 0), { fallback: 30 }).baseline).toBe(30)
  })

  it('blends the fallback with the median as history grows', () => {
    expect(shadeLevels(days(14, 60), { fallback: 30 }).baseline).toBe(45)
    expect(shadeLevels(days(14, 60), { fallback: 30 }).baseline).toBeLessThan(shadeLevels(days(28, 60), { fallback: 30 }).baseline)
  })

  it('resists outliers', () => {
    const { baseline } = shadeLevels([...days(14, 30), ...days(2, 5000, 20)], { fallback: 30 })
    expect(baseline).toBe(30)
  })

  it('maps ratios to levels at the boundaries', () => {
    const { level } = shadeLevels([], { fallback: 100 })
    expect([49, 50, 124, 125, 199, 200].map(level)).toEqual([1, 2, 2, 3, 3, 4])
  })

  it('shades unknown amounts as the median and zero as the lightest', () => {
    const { level } = shadeLevels([], { fallback: 100 })
    expect(level(undefined)).toBe(2)
    expect(level(null)).toBe(2)
    expect(level(0)).toBe(1)
  })

  it('ignores values older than 90 days', () => {
    const old = [[localDay(new Date(2026, 5, 1)), 600], [localDay(new Date(2026, 5, 2)), 600]]
    expect(shadeLevels(old, { fallback: 30 }).baseline).toBe(30)
    expect(shadeLevels([...old, ...days(14, 60)], { fallback: 30 }).baseline).toBe(45)
  })
})

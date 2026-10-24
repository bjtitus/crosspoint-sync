// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { LoadCacheProvider, useLoad } from './ui.jsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const pending = () => new Promise(() => {})
function Screen({ load }) {
  const [data] = useLoad(load, [], 'shared-book')
  return <div>{data ?? 'Loading'}</div>
}

describe('screen caches', () => {
  it('reuses data when revisiting a screen within the same sign-in', async () => {
    const { rerender } = render(<LoadCacheProvider><Screen load={async () => 'uxj4 data'} /></LoadCacheProvider>)
    await screen.findByText('uxj4 data')
    rerender(<LoadCacheProvider><div>Other screen</div></LoadCacheProvider>)
    rerender(<LoadCacheProvider><Screen load={pending} /></LoadCacheProvider>)
    expect(screen.getByText('uxj4 data')).toBeTruthy()
  })

  it('does not reuse a shared book key after switching accounts or servers', async () => {
    const { rerender } = render(<LoadCacheProvider key="uxj4@one"><Screen load={async () => 'uxj4 data'} /></LoadCacheProvider>)
    await screen.findByText('uxj4 data')
    rerender(<LoadCacheProvider key="uxj3@one"><Screen load={pending} /></LoadCacheProvider>)
    expect(screen.queryByText('uxj4 data')).toBeNull()
    expect(screen.getByText('Loading')).toBeTruthy()
    rerender(<LoadCacheProvider key="uxj4@two"><Screen load={pending} /></LoadCacheProvider>)
    expect(screen.getByText('Loading')).toBeTruthy()
  })

  it('ignores responses from a screen that has already unmounted', async () => {
    let resolve
    const { rerender } = render(<LoadCacheProvider><Screen load={() => new Promise((r) => { resolve = r })} /></LoadCacheProvider>)
    rerender(<LoadCacheProvider><div>Other screen</div></LoadCacheProvider>)
    await act(async () => resolve('stale data'))
    rerender(<LoadCacheProvider><Screen load={pending} /></LoadCacheProvider>)
    expect(screen.getByText('Loading')).toBeTruthy()
  })
})

describe('activity refresh recovery', () => {
  const options = { retries: 2, reportRefreshErrors: true }
  const flush = () => act(async () => {})

  it('reports stale data immediately, retries, and clears the error on success', async () => {
    vi.useFakeTimers()
    const error = new Error('Server unavailable')
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('fresh')
    const savedAt = Date.now() - 86400000
    const { result } = renderHook(() => useLoad(load, [], undefined, () => 'saved', { ...options, initialUpdatedAt: () => savedAt }))
    await flush()
    expect(result.current[0]).toBe('saved')
    expect(result.current[1]).toBe(error)
    expect(result.current[3]).toBe(true)
    expect(result.current[4]).toBe(savedAt)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(load).toHaveBeenCalledTimes(2)
    expect(result.current[0]).toBe('fresh')
    expect(result.current[1]).toBeNull()
    expect(result.current[3]).toBe(false)
    expect(result.current[4]).toBe(Date.now())
  })

  it('stops after two retries and supports a new manual attempt without cached data', async () => {
    vi.useFakeTimers()
    const error = new Error('Network unavailable')
    const load = vi.fn().mockRejectedValue(error)
    const { result } = renderHook(() => useLoad(load, [], undefined, undefined, options))
    await flush()
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(load).toHaveBeenCalledTimes(3)
    expect(result.current[0]).toBeNull()
    expect(result.current[1]).toBe(error)
    expect(result.current[3]).toBe(false)
    load.mockResolvedValue('recovered')
    await act(async () => result.current[2]())
    expect(result.current[0]).toBe('recovered')
    expect(result.current[1]).toBeNull()
  })

  it('cancels a scheduled retry when unmounted', async () => {
    vi.useFakeTimers()
    const load = vi.fn().mockRejectedValue(new Error('offline'))
    const { unmount } = renderHook(() => useLoad(load, [], undefined, undefined, options))
    await flush()
    unmount()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('cancels the previous retry when dependencies change', async () => {
    vi.useFakeTimers()
    const oldLoad = vi.fn().mockRejectedValue(new Error('offline'))
    const newLoad = vi.fn().mockResolvedValue('new account')
    const { result, rerender } = renderHook(({ load, account }) => useLoad(load, [account], undefined, undefined, options), {
      initialProps: { load: oldLoad, account: 'old' },
    })
    await flush()
    rerender({ load: newLoad, account: 'new' })
    await flush()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(oldLoad).toHaveBeenCalledTimes(1)
    expect(newLoad).toHaveBeenCalledTimes(1)
    expect(result.current[0]).toBe('new account')
  })

  it('does not retry authentication errors', async () => {
    vi.useFakeTimers()
    const error = Object.assign(new Error('Signed out'), { status: 401 })
    const load = vi.fn().mockRejectedValue(error)
    const { result } = renderHook(() => useLoad(load, [], undefined, () => 'saved', options))
    await flush()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(load).toHaveBeenCalledTimes(1)
    expect(result.current[1]).toBe(error)
    expect(result.current[3]).toBe(false)
  })
})

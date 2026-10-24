// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ isApp: true }))
vi.mock('./api.js', () => ({ get isApp() { return env.isApp } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('native-chrome')
})

it.each([
  ['older iPhone', true, 'iPhone OS 18_6', false, false],
  ['iOS 26 with compatibility user agent', true, 'iPhone OS 18_6', true, true],
  ['iPhone browser', false, 'iPhone OS 26_0', true, false],
  ['Android app', true, 'Android', true, false],
  ['iPad app', true, 'iPad OS 26_0', true, false],
])('%s chooses the appropriate navigation', async (_, isApp, ua, supported, expected) => {
  vi.resetModules()
  env.isApp = isApp
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  invoke.mockResolvedValue(supported)
  const nav = await import('./tabbar.js')
  await nav.initializeNavigation()
  expect(nav.nativeTabBar).toBe(expected)
  expect(document.documentElement.classList.contains('native-chrome')).toBe(expected)
  if (isApp && ua.includes('iPhone')) expect(invoke).toHaveBeenCalledWith('supports_native_chrome')
  else expect(invoke).not.toHaveBeenCalled()
})

it('keeps HTML controls visible when native capability detection fails', async () => {
  vi.resetModules()
  env.isApp = true
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone OS 26_0')
  invoke.mockRejectedValue(new Error('Native command unavailable'))
  const nav = await import('./tabbar.js')
  await nav.initializeNavigation()
  expect(nav.nativeTabBar).toBe(false)
  expect(document.documentElement.classList.contains('native-chrome')).toBe(false)
})

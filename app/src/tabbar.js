import { useEffect, useRef } from 'react'
import {
  configureTabBar,
  createComponent,
  hideTabBar,
  onComponentEvent,
  onTabSelected,
  removeComponent,
  removeTabBar,
  selectTab,
  showTabBar,
} from '@sosweetham/tauri-plugin-system-components-api'
import { invoke } from '@tauri-apps/api/core'
import { isApp } from './api.js'

// Resolve before React mounts; older iPhones keep the same HTML controls as Android.
export let nativeTabBar = false
let wide
export async function initializeNavigation() {
  if (isApp && /iPhone/.test(navigator.userAgent)) {
    nativeTabBar = await invoke('supports_native_chrome').catch(() => false)
  }
  wide = nativeTabBar ? matchMedia('(min-width: 768px)') : null
  document.documentElement.classList.toggle('native-chrome', nativeTabBar)
  // Shows the top scroll edge effect (index.css) once content is under the buttons.
  if (nativeTabBar) {
    const on = () => document.documentElement.classList.toggle('scrolled', scrollY > 0)
    addEventListener('scroll', on, { passive: true })
    on()
  }
}

let sheets = 0
const sync = () => {
  // The page behind an open sheet stays put: CSS for the web and Android's scroll,
  // the native scroll view on iOS (its bounce and pull-to-refresh ignore the CSS),
  // and Android's pull-to-refresh (see MainActivity).
  const open = sheets > 0
  document.documentElement.style.overflow = open ? 'hidden' : ''
  if (isApp) invoke('set_page_scroll', { enabled: !open }).catch(() => {})
  window.CrossPointRefresh?.setEnabled(!open)
  if (!nativeTabBar) return
  const hidden = wide.matches || sheets > 0
  ;(hidden ? hideTabBar() : showTabBar()).catch(() => {})
  syncButtons(!hidden)
}

// Glass buttons pinned to the top corners (gear, back, a page's ⋯ menu), iOS 26
// style. Components have no hide, so they're removed and recreated around sheets.
const buttons = new Map() // id -> { sfSymbol, anchor, click, shown }
let listening = false
function syncButtons(show) {
  for (const [id, b] of buttons) {
    if (show && !b.shown) {
      b.shown = true
      // No `label`: the plugin renders it as visible title text beside the symbol.
      // The button is already glass on iOS 26; `glass` would wrap it in a second capsule.
      const props = { sfSymbol: b.sfSymbol, width: 44, height: 44 }
      createComponent({ id, kind: 'button', anchor: b.anchor, dx: 12, dy: 8, props }).catch(() => {})
    } else if (!show && b.shown) {
      b.shown = false
      removeComponent(id).catch(() => {})
    }
  }
}

export function useNativeButton(id, { sfSymbol, anchor }, onClick) {
  const click = useRef(onClick)
  click.current = onClick
  useEffect(() => {
    if (!nativeTabBar) return
    if (!listening) {
      listening = true
      onComponentEvent((e) => e.event === 'click' && buttons.get(e.id)?.click()).catch(() => {})
    }
    buttons.set(id, { sfSymbol, anchor, click: () => click.current(), shown: false })
    syncButtons(!(wide.matches || sheets > 0))
    return () => {
      if (buttons.get(id)?.shown) removeComponent(id).catch(() => {})
      buttons.delete(id)
    }
  }, [id, sfSymbol, anchor])
}

// to: a hash, or a function (e.g. history.back).
export const useNativeBack = (to) =>
  useNativeButton('back', { sfSymbol: 'chevron.left', anchor: 'topLeading' }, () =>
    typeof to === 'function' ? to() : (location.hash = to)
  )

// items: [{ id, title, sfSymbol }]; ids are hashes. Returns the unmount cleanup.
export function mountTabBar(items, selectedId) {
  let live = true
  let listener
  configureTabBar({ items, selectedId, tint: '#4a7a62' }).then(sync, () => {})
  // replace, not push: switching tabs isn't a step the back swipe should undo.
  onTabSelected(({ id }) => location.replace(id)).then((l) => (live ? (listener = l) : l.unregister()), () => {})
  wide.addEventListener('change', sync)
  return () => {
    live = false
    listener?.unregister()
    wide.removeEventListener('change', sync)
    removeTabBar().catch(() => {})
  }
}

export const selectNativeTab = (id) => selectTab(id).catch(() => {})

// Call in any full-screen sheet: the native bar and buttons step aside, and
// pull-to-refresh pauses.
export function useSheet() {
  useEffect(() => {
    sheets++
    sync()
    return () => {
      sheets--
      sync()
    }
  }, [])
}

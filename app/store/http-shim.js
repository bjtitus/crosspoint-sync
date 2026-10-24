// The browser has no Tauri, so the app's http plugin falls back to plain fetch.
export const fetch = (...args) => window.fetch(...args)

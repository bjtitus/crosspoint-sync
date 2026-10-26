import { readerFor, refreshReaders } from '../readers.js'

// Match the reader web UI's normal mode. Advanced crop/split/rotation stay off.
export const DEFAULT_QUALITY = 85

// Avoid inflating several books and allocating their canvases at once on phones.
let pending = Promise.resolve()

export function optimizeEpub(file, { device, quality = DEFAULT_QUALITY, onProgress = () => {}, signal } = {}) {
  const run = pending.then(async () => {
    signal?.throwIfAborted()
    const { convertEpub } = await import('./vendor/optimizer.js')
    await refreshReaders()
    const { width, height } = readerFor(device)
    const value = Number(quality)
    const options = { width, height, quality: Number.isFinite(value) ? Math.max(1, Math.min(95, Math.round(value))) : DEFAULT_QUALITY }
    onProgress({ stage: 'optimizing', done: 0, total: 100 })
    const blob = await convertEpub(file, options, (done) => onProgress({ stage: 'optimizing', done, total: 100 }), signal,
      (log) => onProgress({ stage: 'optimizing', log }))
    return new File([blob], file.name, { type: 'application/epub+zip', lastModified: file.lastModified })
  })
  pending = run.catch(() => {})
  return run
}

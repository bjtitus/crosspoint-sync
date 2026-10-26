import { http } from './api.js'

// Reader models and screen sizes, from crosspointreader.com/api/devices (the
// site's flasher list, crosspoint-tools src/lib/devices.ts). BUNDLED is a copy
// for first launch and offline; the last good fetch is kept in localStorage.
const URL = 'https://crosspointreader.com/api/devices'
const KEY = 'crosspoint-readers'
const BUNDLED = [
  { id: 'x4', name: 'Xteink X4', width: 480, height: 800, board: 'xteink_x4' },
  { id: 'x4pro', name: 'Xteink X4 Pro', width: 480, height: 800, board: 'xteink_x4_pro' },
  { id: 'x4c', name: 'Xteink X4C', width: 480, height: 800, board: 'xteink_x4_classic' },
  { id: 'x3', name: 'Xteink X3', width: 528, height: 792, board: 'xteink_x3' },
  { id: 'sticky', name: 'Seeed Sticky', width: 480, height: 800, board: 'sticky' },
  { id: 'm5paper', name: 'M5Paper v1.1', width: 540, height: 960, board: 'm5paper_v11' },
  { id: 'm5papers3', name: 'M5Paper S3', width: 540, height: 960, board: 'm5paper_s3' },
  { id: 'papermono', name: 'M5PaperMono', width: 480, height: 800, board: 'm5stack_paper_mono' },
  { id: 'lilygo', name: 'LilyGo T5', width: 540, height: 960, board: 'lilygo_t5s3' },
  { id: 'metalio', name: 'Metalio E-INK4', width: 480, height: 800, board: 'metalio_eink4' },
  { id: 'eego_a4', name: 'EEGO Reader A4', width: 552, height: 768, board: 'eego_a4' },
  { id: 'picco', name: 'BOOX Picco', width: 480, height: 800, board: 'picco' },
]
export const DEFAULT_READER = 'x4'

const size = (n) => Number.isInteger(n) && n > 0 && n <= 4096
export function valid(list) {
  const ok = Array.isArray(list) ? list.filter((d) => typeof d?.id === 'string' && typeof d.name === 'string' && size(d.width) && size(d.height)) : []
  return ok.some((d) => d.id === DEFAULT_READER) ? ok : null
}

let list = BUNDLED
try {
  list = valid(JSON.parse(localStorage.getItem(KEY))) ?? BUNDLED
} catch {
  // keep BUNDLED
}
export const readers = () => list

// Once per session; on failure the cached or bundled list stays.
let refreshing
export function refreshReaders() {
  refreshing ??= http(URL, { signal: AbortSignal.timeout(5000) })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const fresh = valid(data)
      if (fresh) {
        list = fresh
        try {
          localStorage.setItem(KEY, JSON.stringify(fresh))
        } catch {
          // per-device cache only
        }
      }
      return list
    })
    .catch(() => list)
  return refreshing
}

// A model by our id or by what the reader reports in /api/status ("X4", "X3",
// or its BoardConfig name like "m5paper_v11").
export function findReader(device) {
  const key = String(device ?? '').toLowerCase()
  return list.find((d) => d.id === key || d.board === key)
}
export const readerFor = (device) => findReader(device) ?? findReader(DEFAULT_READER)

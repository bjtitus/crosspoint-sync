// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ isApp: false, api: {} }))
vi.hoisted(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
const { firstDuplicate, looksLikeSame } = await import('./Book.jsx')

// The rule firstDuplicate must match: the first book with any other book that looks the same.
const pairwise = (books) => books.find((b) => books.some((o) => looksLikeSame(b, o)))

it('finds the same first duplicate as comparing every pair', () => {
  const titles = ['Dune', 'dune!', 'Emma', '変な家２', '変な家2', '', null]
  const authors = ['Frank Herbert', 'frank  herbert', 'Jane Austen', '', null, '—', '–']
  let seed = 7
  const pick = (list) => list[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % list.length]
  for (let round = 0; round < 2000; round++) {
    const books = Array.from({ length: 1 + (round % 7) }, (_, i) => ({ document: `d${i}`, title: pick(titles), author: pick(authors) }))
    expect(firstDuplicate(books), JSON.stringify(books)).toBe(pairwise(books))
  }
})

it('stays fast when thousands of books share a title', () => {
  const books = Array.from({ length: 5000 }, (_, i) => ({ document: `d${i}`, title: 'Notes', author: `Author ${i}` }))
  books.push({ document: 'last', title: 'notes', author: 'author 4999' })
  const t = performance.now()
  expect(firstDuplicate(books)?.document).toBe('d4999')
  expect(performance.now() - t).toBeLessThan(500)
})

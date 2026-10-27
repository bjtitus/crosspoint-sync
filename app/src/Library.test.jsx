// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import Library from './Library.jsx'
import { localDay } from './readingHistory.js'

vi.mock('./api.js', () => ({ isApp: false, api: { cover: vi.fn() } }))
vi.hoisted(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

const session = {}
const finished = { document: 'finished', title: 'Finished on CrossInk', status: 'finished', percentage: 0.6, cover_url: '/finished.jpg' }
const reading = { document: 'reading', title: 'Still reading', status: 'reading', percentage: 0.3, cover_url: '/reading.jpg' }

afterEach(cleanup)

describe('Library completion updates', () => {
  it('shows the grid-derived streak and uses the device total until dated history loads', () => {
    const summary = { devices: [{ device: 'CrossInk' }], current_streak: 8, seconds: 0, completed: 0 }
    const { getByText, rerender } = render(<Library session={session} books={[]} summary={summary} />)
    expect(getByText('day streak').previousElementSibling.textContent).toBe('8')
    const activity = { books: [], reading_days: [localDay(new Date())] }
    rerender(<Library session={session} books={[]} summary={summary} activity={activity} />)
    expect(getByText('day streak').previousElementSibling.textContent).toBe('1')
  })

  it('counts finished books from the library, not a device counter that missed them', () => {
    const summary = { devices: [{ device: 'KOReader' }], current_streak: 0, seconds: 0, completed: 0 }
    const { getByText } = render(<Library session={session} books={[finished, reading]} summary={summary} />)
    expect(getByText('finished').previousElementSibling.textContent).toBe('1')
  })

  it('shows every in-progress book as a reading card and removes completed books', () => {
    const { container, getByRole, getByText, getAllByText, rerender } = render(
      <Library session={session} books={[{ ...finished, status: 'reading' }, reading]} />,
    )
    expect(getAllByText('Continue reading').map((label) => label.closest('a').getAttribute('href'))).toEqual(['#/book/finished', '#/book/reading'])

    rerender(<Library session={session} books={[finished, reading]} />)
    expect(getByText('Continue reading').closest('a').getAttribute('href')).toBe('#/book/reading')
    expect(container.querySelector('a[href="#/book/finished"]')).toBeNull()

    fireEvent.click(getByRole('button', { name: /Finished 1/ }))
    expect(container.querySelector('a[href="#/book/finished"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Continue reading')
  })

  it('shows the empty Reading shelf when every book is finished', () => {
    const { getByText, queryByText } = render(<Library session={session} books={[finished]} />)
    expect(getByText('Nothing in progress')).toBeTruthy()
    expect(queryByText('Continue reading')).toBeNull()
  })
})

describe('duplicate notice', () => {
  const book = (document, title) => ({ document, title, author: 'Unknown Author', status: 'finished', percentage: 1 })

  it('tells different Japanese titles apart', () => {
    const books = [
      book('grammar', '小学1年生 言葉と文法にぐーんと強くなる (くもんの国語集中学習)'),
      book('kanji', '小学1年生 漢字にぐーんと強くなる (くもんの国語集中学習)'),
    ]
    const { container } = render(<Library session={session} books={books} />)
    expect(container.textContent).not.toContain('appears more than once')
  })

  it('tells Thai titles apart that differ only in a tone mark', () => {
    const books = [book('forest', 'ป่า'), book('aunt', 'ป้า')]
    const { container } = render(<Library session={session} books={books} />)
    expect(container.textContent).not.toContain('appears more than once')
  })

  it('finds one duplicate among thousands of books quickly', () => {
    const books = Array.from({ length: 5000 }, (_, i) => book(`d${i}`, `Some Book ${i}`))
    // Same title, other author: not a copy. The only real copy is the last book.
    books.push({ ...book('x', 'Some Book 4998'), author: 'Another Author' }, book('y', 'some book 4999'))
    const t = performance.now()
    const { container } = render(<Library session={session} books={books} />)
    expect(container.textContent).toContain('appears more than once')
    expect(performance.now() - t).toBeLessThan(3000)
  })

  it('still finds a Japanese title synced twice, full-width forms included', () => {
    const books = [book('a', '変な家２　～11の間取り図～'), book('b', '変な家2 ~11の間取り図~')]
    const { container } = render(<Library session={session} books={books} />)
    expect(container.textContent).toContain('appears more than once')
  })
})

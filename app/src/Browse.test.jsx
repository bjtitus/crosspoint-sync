// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { JSDOM } from 'jsdom'
vi.hoisted(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
vi.mock('./api.js', () => ({ isApp: true, api: {} }))
vi.mock('./tabbar.js', () => ({ useNativeBack() {}, useNativeButton() {}, useSheet() {} }))
vi.mock('./catalogs.js', async (orig) => ({ ...await orig(), loadCatalogs: vi.fn(), search: vi.fn() }))
import Browse from './Browse.jsx'
import { loadCatalogs, search } from './catalogs.js'
// Node's experimental storage can shadow jsdom's localStorage.
vi.stubGlobal('localStorage', new JSDOM('', { url: 'https://app.test' }).window.localStorage)
const catalogs = [{ id: 'a', name: 'First catalog', url: 'https://first.example/opds' }, { id: 'b', name: 'Second catalog', url: 'https://second.example/opds' }]
const entry = (title) => ({ id: 'shared-id', title, authors: ['Author'], thumbnail: '/cover.jpg', navigation: [], acquisitions: [] })
const feed = (entries = [], extra = {}) => ({ entries, groups: [], navigation: [], facets: [], ...extra })
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); localStorage.clear(); location.hash = '' })

it('removes only the confirmed catalog without using the WebView confirm dialog, and keeps it removed after reopening', () => {
  localStorage.setItem('crosspoint-catalogs', JSON.stringify(catalogs))
  loadCatalogs.mockImplementation(() => JSON.parse(localStorage.getItem('crosspoint-catalogs')))
  const browserConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const { unmount } = render(<Browse parts={['browse', 'manage']} />)

  fireEvent.click(screen.getByRole('button', { name: 'Remove First catalog' }))
  const dialog = screen.getByRole('dialog', { name: 'Remove First catalog?' })
  expect(screen.getByRole('link', { name: /First catalog/ })).toBeTruthy()
  expect(JSON.parse(localStorage.getItem('crosspoint-catalogs'))).toEqual(catalogs)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('link', { name: /First catalog/ })).toBeNull()
  expect(screen.getByRole('link', { name: /Second catalog/ })).toBeTruthy()
  expect(JSON.parse(localStorage.getItem('crosspoint-catalogs'))).toEqual([catalogs[1]])
  expect(browserConfirm).not.toHaveBeenCalled()

  unmount()
  render(<Browse parts={['browse', 'manage']} />)
  expect(screen.queryByRole('button', { name: 'Remove First catalog' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Remove Second catalog' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Remove Second catalog' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
  expect(JSON.parse(localStorage.getItem('crosspoint-catalogs'))).toEqual([])
  cleanup()
  render(<Browse parts={['browse', 'manage']} />)
  expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Add a catalog' })).toBeTruthy()
})

it('keeps catalogs when removal is cancelled or closed', () => {
  loadCatalogs.mockReturnValue(catalogs)
  localStorage.setItem('crosspoint-catalogs', JSON.stringify(catalogs))
  render(<Browse parts={['browse', 'manage']} />)
  for (const action of ['Cancel', 'Close']) {
    fireEvent.click(screen.getByRole('button', { name: 'Remove First catalog' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: action }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove First catalog' })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('crosspoint-catalogs'))).toEqual(catalogs)
  }
})

it('combines catalogs and grouped results in one grid with the correct book destinations', async () => {
  loadCatalogs.mockReturnValue(catalogs)
  search.mockImplementation((cat) => Promise.resolve(cat.id === 'a'
    ? feed([entry('First book')], { next: '/next' })
    : feed([], { groups: [{ title: 'A section', entries: [entry('Second book')] }] })))
  render(<Browse parts={['browse', 'search', 'books']} />)
  const results = await screen.findByRole('list', { name: 'Search results' })
  expect(within(results).getAllByRole('listitem')).toHaveLength(2)
  expect(screen.queryByRole('heading', { name: 'A section' })).toBeNull()
  fireEvent.click(within(results).getByRole('button', { name: /First book/ }))
  expect(location.hash).toBe('#/browse/a/b/shared-id')
  fireEvent.click(within(results).getByRole('button', { name: /Second book/ }))
  expect(location.hash).toBe('#/browse/b/b/shared-id')
  expect(screen.getByRole('link', { name: 'More results from First catalog' }).getAttribute('href')).toBe('#/browse/a/s/books')
})

it('keeps successful results while another catalog loads or fails', async () => {
  loadCatalogs.mockReturnValue(catalogs)
  let reject
  search.mockImplementation((cat) => cat.id === 'a' ? Promise.resolve(feed([entry('First book')])) : new Promise((_, fail) => { reject = fail }))
  render(<Browse parts={['browse', 'search', 'books']} />)
  expect(await screen.findByRole('button', { name: /First book/ })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('Searching catalogs…')
  await act(async () => reject(new Error('Connection failed')))
  expect(screen.getByRole('alert').textContent).toContain('Second catalog: Error: Connection failed')
  expect(screen.getByRole('button', { name: /First book/ })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByText('No matches')).toBeNull()
})

it('shows one empty state after all catalogs return no matches', async () => {
  loadCatalogs.mockReturnValue(catalogs)
  search.mockResolvedValue(feed())
  render(<Browse parts={['browse', 'search', 'nothing']} />)
  expect(await screen.findByText('No matches')).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull()
})

it('uses the cover grid for grouped single-catalog searches too', async () => {
  loadCatalogs.mockReturnValue(catalogs)
  const book = entry('Grouped book')
  search.mockResolvedValue(feed([book], { groups: [{ title: 'A section', entries: [book] }] }))
  render(<Browse parts={['browse', 'a', 's', 'books']} />)
  expect(await screen.findByRole('button', { name: /Grouped book/ })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'A section' })).toBeNull()
  expect(screen.getAllByRole('button', { name: /Grouped book/ })).toHaveLength(1)
})

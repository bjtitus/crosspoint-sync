// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { findReader, readerFor, valid } from './readers.js'

it('maps what the reader reports to a screen size', () => {
  expect(readerFor('X3')).toMatchObject({ id: 'x3', width: 528, height: 792 })
  expect(readerFor('m5paper_v11')).toMatchObject({ id: 'm5paper', width: 540, height: 960 })
  expect(readerFor('something-new').id).toBe('x4')
  expect(readerFor(undefined).id).toBe('x4')
  expect(findReader('something-new')).toBeUndefined()
})

it('rejects a fetched list it cannot use', () => {
  expect(valid({ error: 'nope' })).toBeNull()
  expect(valid([{ id: 'x3', name: 'Xteink X3', width: 528, height: 792 }])).toBeNull() // no X4 fallback
  expect(valid([{ id: 'x4', name: 'Xteink X4', width: 480, height: 800 }, { id: 'bad', name: 'Bad', width: '1e9', height: 1 }])).toHaveLength(1)
})

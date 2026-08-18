import { describe, it, expect } from 'vitest'
import { cellKey, getCell, setCell } from '../src/data/cellStore'
describe('cellStore', () => {
  it('round-trips a cell', () => {
    const m = {}
    setCell(m, 'mtx', '1min', 'tank2', '480')
    expect(getCell(m, 'mtx', '1min', 'tank2')).toBe('480')
    expect(cellKey('mtx', '1min', 'tank2')).toBe('mtx.1min.tank2')
  })
  it('missing cell is empty string', () => {
    expect(getCell({}, 'a', 'b', 'c')).toBe('')
  })
})

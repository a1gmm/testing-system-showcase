import { afterEach, expect, test } from 'vitest'
import { clearDirty, hasDirty, markDirty } from '../src/utils/dirty'

const keys = [
  'sheet:ROUND-A:HJ-TC-136',
  'sheet:ROUND-B:HJ-TC-146',
]

afterEach(() => keys.forEach(clearDirty))

test('可按期次前缀判断未保存表单，不让其他期次误伤当前操作', () => {
  keys.forEach(markDirty)

  expect(hasDirty('sheet:ROUND-A:')).toBe(true)
  clearDirty(keys[0])

  expect(hasDirty()).toBe(true)
  expect(hasDirty('sheet:ROUND-A:')).toBe(false)
  expect(hasDirty('sheet:ROUND-B:')).toBe(true)
})

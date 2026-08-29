import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRecord: vi.fn(async () => null),
  saveRecord: vi.fn(async () => ({ id: 'record-1', status: 'draft', updated_at: '2026-08-26T00:00:00.000Z' })),
  listInstruments: vi.fn(async () => []),
  listRefMaterials: vi.fn(async () => []),
  listReagents: vi.fn(async () => []),
}))

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'analyst', name: '分析员', roles: ['analyst'], status: 'active', created_at: '' }),
  api: mocks,
}))

import StructuredSheet from '../src/components/StructuredSheet.vue'

test('逐样实验室记录自动带入样品编号并禁止手工改成别的编号', async () => {
  const wrapper = mount(StructuredSheet, {
    props: {
      sampleId: 'W260826-20', analyte: '化学需氧量', method: '重铬酸盐法', matrix: '废水',
      code: 'HJ-TC-103', sheetType: '原始记录', templateName: 'COD 原始记录',
    },
    global: {
      stubs: {
        ElIcon: true,
        ElButton: { template: '<button><slot /></button>' },
        ElSelect: true,
        ElOption: true,
        RecordAttachments: true,
      },
    },
  })
  await flushPromises()

  const identity = wrapper.get('[data-fixed-sample-id]')
  expect(identity.text()).toBe('W260826-20')
  expect(wrapper.find('input[data-sample-id-input]').exists()).toBe(false)
})

test('历史错误编号会按当前样品纠正，并以正确编号保存', async () => {
  mocks.getRecord.mockResolvedValueOnce({
    id: 'record-old', status: 'draft', updated_at: '2026-08-25T00:00:00.000Z',
    data: { rows: [{ id: 'WRONG-SAMPLE', volume: 50 }], meta: {}, cells: {} },
  })
  const wrapper = mount(StructuredSheet, {
    props: {
      sampleId: 'W260826-20', analyte: '化学需氧量', method: '重铬酸盐法', matrix: '废水',
      code: 'HJ-TC-103', sheetType: '原始记录', templateName: 'COD 原始记录',
    },
    global: {
      stubs: {
        ElIcon: true,
        ElButton: { template: '<button><slot /></button>' },
        ElSelect: true,
        ElOption: true,
        RecordAttachments: true,
      },
    },
  })
  await flushPromises()

  expect(wrapper.get('[data-fixed-sample-id]').text()).toBe('W260826-20')
  const save = wrapper.findAll('button').find(button => button.text().includes('保存草稿'))!
  await save.trigger('click')
  await flushPromises()
  expect(mocks.saveRecord).toHaveBeenCalledWith(expect.objectContaining({
    sampleId: 'W260826-20',
    data: expect.objectContaining({ rows: expect.arrayContaining([expect.objectContaining({ id: 'W260826-20' })]) }),
  }))
})

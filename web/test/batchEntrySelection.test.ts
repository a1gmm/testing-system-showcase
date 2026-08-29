import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, expect, test, vi } from 'vitest'

const dirtyMocks = vi.hoisted(() => ({
  confirmIfDirty: vi.fn(async () => true),
  markDirty: vi.fn(),
  saveRecordsBatch: vi.fn(async () => [{ id: 'record-1' }, { id: 'record-2' }]),
}))

vi.mock('../src/data/templates.json', () => ({ default: [{
  code: 'HJ-TC-103', name: '批量表', raw: '化学需氧量批量原始记录', analyte: '化学需氧量', matrix: '',
  method: '重铬酸盐法', sheetType: '原始记录', file: 'batch.pdf', phase: '实验室', meta: { detectionLimit: '4mg/L' },
}] }))
vi.mock('../src/data/phase', () => ({ templatePhase: () => '实验室' }))
vi.mock('../src/data/schemas', () => ({ resolveTemplateSchema: () => ({
  id: 'codTitration', columns: [{ key: 'no', label: '样品编号', kind: 'id' }, { key: 'value', label: '结果', kind: 'input' }],
  regression: true,
}) }))
vi.mock('../src/data/resultProjection', () => ({ schemaColumns: (schema: any) => schema.columns, projectResultSummary: () => null }))
vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'demo_admin', name: '林工程师', roles: ['analyst'], status: 'active', created_at: '' }),
  hasRole: (...roles: string[]) => roles.includes('analyst'), api: { saveRecordsBatch: dirtyMocks.saveRecordsBatch },
}))
vi.mock('../src/utils/dirty', () => ({ markDirty: dirtyMocks.markDirty, clearDirty: vi.fn(), confirmIfDirty: dirtyMocks.confirmIfDirty }))

import BatchEntry from '../src/components/BatchEntry.vue'

const samples = ['W260826-0', 'W260826-1'].map(id => ({
  id, client: '盲样', matrix: '废水', items: ['化学需氧量'], status: 'testing', note: '', contract_id: null,
  round_id: null, source: 'field', point_name: null, created_at: '',
}))
const myTasks = samples.map((sample, index) => ({
  id: index + 1, sample_id: sample.id, analyte: '化学需氧量', assignee: '林工程师', assignee_username: 'demo_admin',
  assigned_by: '质控员', assigned_at: '', record_status: 'none',
}))

beforeEach(() => {
  dirtyMocks.confirmIfDirty.mockReset()
  dirtyMocks.confirmIfDirty.mockResolvedValue(true)
  dirtyMocks.markDirty.mockReset()
  dirtyMocks.saveRecordsBatch.mockClear()
})

test('批量录入兼容正式开放但未标基质的实验室模板，并能一键全选本人匹配样品', async () => {
  const wrapper = mount(BatchEntry, {
    props: { samples: samples as any, myTasks: myTasks as any },
    global: { stubs: { 'el-button': { template: '<button><slot /></button>' } } },
  })
  await wrapper.get('.titem').trigger('click')
  await flushPromises()

  expect(wrapper.findAll('[data-batch-sample]')).toHaveLength(2)
  const selectAll = wrapper.get('[data-select-all-batch]')
  expect(selectAll.text()).toContain('全选 2 个')
  await selectAll.trigger('click')
  expect(wrapper.text()).toContain('本批样品（2/2）')
  expect(wrapper.findAll('tbody tr')).toHaveLength(2)
  expect(wrapper.find('th').text()).toContain('样品编号 / 委托')
  expect(wrapper.findAll('thead th').map(node => node.text())).not.toContain('样品编号')

  const save = wrapper.findAll('button').find(button => button.text().includes('保存草稿'))!
  await save.trigger('click')
  expect(dirtyMocks.saveRecordsBatch).toHaveBeenCalledWith(expect.objectContaining({
    entries: [
      expect.objectContaining({ sampleId: 'W260826-0', row: expect.objectContaining({ no: 'W260826-0' }) }),
      expect.objectContaining({ sampleId: 'W260826-1', row: expect.objectContaining({ no: 'W260826-1' }) }),
    ],
  }))
})

test('有未保存批量数据时，取消换表会保留已选样品', async () => {
  dirtyMocks.confirmIfDirty.mockResolvedValueOnce(false)
  const wrapper = mount(BatchEntry, {
    props: { samples: samples as any, myTasks: myTasks as any },
    global: { stubs: { 'el-button': { template: '<button><slot /></button>' } } },
  })
  await wrapper.get('.titem').trigger('click')
  await wrapper.get('[data-select-all-batch]').trigger('click')
  await wrapper.get('.back').trigger('click')
  await flushPromises()

  expect(dirtyMocks.confirmIfDirty).toHaveBeenCalled()
  expect(wrapper.text()).toContain('本批样品（2/2）')
  expect(wrapper.findAll('tbody tr')).toHaveLength(2)
})

test('回归系数、检测日期和检验人修改都会登记未保存状态', async () => {
  const wrapper = mount(BatchEntry, {
    props: { samples: samples as any, myTasks: myTasks as any },
    global: { stubs: { 'el-button': { template: '<button><slot /></button>' } } },
  })
  await wrapper.get('.titem').trigger('click')
  await wrapper.get('[data-select-all-batch]').trigger('click')
  dirtyMocks.markDirty.mockClear()

  const regression = wrapper.findAll('.regbar input')
  await regression[0].setValue('1.2')
  await regression[1].setValue('0.3')
  const metadata = wrapper.findAll('.foot input')
  await metadata[0].setValue('2026-08-27')
  await metadata[1].setValue('新检验人')

  expect(dirtyMocks.markDirty).toHaveBeenCalledTimes(4)
  expect(dirtyMocks.markDirty).toHaveBeenCalledWith('batch-entry')
})

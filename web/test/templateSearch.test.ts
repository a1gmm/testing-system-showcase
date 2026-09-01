import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'

const sample = {
  id: 'W260824-0', client: '搜索测试单位', matrix: '废水', items: ['COD'], status: 'testing', note: '',
  contract_id: 'WT2026-0003', round_id: 'WT2026-0003-R02', source: 'field', point_name: null,
  created_at: '2026-08-24T00:00:00.000Z',
}

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'viewer', name: '查看员', roles: [], status: 'active', created_at: '' }),
  hasRole: () => false,
  HANDOVER_ACTIONS: [],
  PRETREAT_METHODS: [],
  api: {
    listSamples: vi.fn(async () => [sample]),
    listTasks: vi.fn(async () => []),
    getSample: vi.fn(async () => sample),
    listHandovers: vi.fn(async () => []),
    listPretreatments: vi.fn(async () => []),
    getRetention: vi.fn(async () => null),
  },
}))
vi.mock('../src/permissions', () => ({ can: () => false }))
vi.mock('../src/utils/dirty', () => ({ confirmIfDirty: vi.fn(async () => true) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

import Samples from '../src/pages/Samples.vue'

test('废水样品可搜索到未标注基质的 COD 原始记录表', async () => {
  const wrapper = mount(Samples, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' },
        'el-pagination': { template: '<div />' },
        'el-icon': { template: '<i><slot /></i>' },
        'el-tag': { template: '<span><slot /></span>' },
        'el-input': { template: '<input />' },
        ArrowRight: { template: '<i />' },
        RecordAttachments: true,
        BatchEntry: true,
        SymbolInput: true,
        StructuredSheet: {
          props: ['matrix'],
          template: '<div data-structured-sheet :data-matrix="matrix" />',
        },
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  await wrapper.get('.item').trigger('click')
  await flushPromises()

  expect(wrapper.get('.pk-list').text()).toContain('HJ-TC-103')
  await wrapper.get('.pk-search').setValue('HJ-TC-726')
  expect(wrapper.get('.pk-list').text()).toContain('HJ-TC-726')
  await wrapper.get('.pk-search').setValue('HJ-TC-355')
  expect(wrapper.get('.pk-list').text()).toContain('该基质下暂无匹配记录表')
  await wrapper.get('.pk-search').setValue('COD')

  expect(wrapper.get('.pk-list').text()).toContain('HJ-TC-103')
  await wrapper.get('.pk-item').trigger('click')
  expect(wrapper.get('[data-structured-sheet]').attributes('data-matrix')).toBe('废水')
})

test('废水样品不会把正式开放的废气镉表或已停用空气镉表当成可选原始记录', async () => {
  const wastewaterCadmiumSample = { ...sample, items: ['镉'] }
  const { api } = await import('../src/api')
  vi.mocked(api.listSamples).mockResolvedValueOnce([wastewaterCadmiumSample])
  vi.mocked(api.getSample).mockResolvedValueOnce(wastewaterCadmiumSample)

  const wrapper = mount(Samples, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' },
        'el-pagination': { template: '<div />' },
        'el-icon': { template: '<i><slot /></i>' },
        'el-tag': { template: '<span><slot /></span>' },
        'el-input': { template: '<input />' },
        ArrowRight: { template: '<i />' },
        RecordAttachments: true,
        BatchEntry: true,
        SymbolInput: true,
        StructuredSheet: true,
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  await wrapper.get('.item').trigger('click')
  await flushPromises()
  await wrapper.get('.pk-search').setValue('镉')

  const choices = wrapper.get('.pk-list').text()
  expect(choices).toContain('HJ-TC-727')
  expect(choices).not.toContain('HJ-TC-222')
  expect(choices).not.toContain('HJ-TC-700')
})

test('已完成修订对照的模板可以进入正式样品录入', async () => {
  const wastewaterZincSample = { ...sample, items: ['锌'] }
  const { api } = await import('../src/api')
  vi.mocked(api.listSamples).mockResolvedValueOnce([wastewaterZincSample])
  vi.mocked(api.getSample).mockResolvedValueOnce(wastewaterZincSample)

  const wrapper = mount(Samples, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' },
        'el-pagination': { template: '<div />' },
        'el-icon': { template: '<i><slot /></i>' },
        'el-tag': { template: '<span><slot /></span>' },
        'el-input': { template: '<input />' },
        ArrowRight: { template: '<i />' },
        RecordAttachments: true,
        BatchEntry: true,
        SymbolInput: true,
        StructuredSheet: true,
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  await wrapper.get('.item').trigger('click')
  await flushPromises()
  await wrapper.get('.pk-search').setValue('HJ-TC-003')

  expect(wrapper.get('.pk-list').text()).toContain('HJ-TC-003')
})

test('废水样品同时有氨氮和化学需氧量时显示两张测量原始记录表', async () => {
  const wastewaterSample = { ...sample, items: ['氨氮', '化学需氧量'] }
  const { api } = await import('../src/api')
  vi.mocked(api.listSamples).mockResolvedValueOnce([wastewaterSample])
  vi.mocked(api.getSample).mockResolvedValueOnce(wastewaterSample)

  const wrapper = mount(Samples, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' },
        'el-pagination': { template: '<div />' },
        'el-icon': { template: '<i><slot /></i>' },
        'el-tag': { template: '<span><slot /></span>' },
        'el-input': { template: '<input />' },
        ArrowRight: { template: '<i />' },
        RecordAttachments: true,
        BatchEntry: true,
        SymbolInput: true,
        StructuredSheet: true,
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  await wrapper.get('.item').trigger('click')
  await flushPromises()

  const choices = wrapper.get('.pk-list').text()
  expect(choices).toContain('HJ-TC-092')
  expect(choices).toContain('HJ-TC-103')
  expect(wrapper.get('.pk-scope').text()).toContain('项目覆盖 2/2 可录')
})

test('完全没有适用表的检测项目会明确提示且默认不铺无关记录表', async () => {
  const unknownItemSample = { ...sample, items: ['完全不存在项目'] }
  const { api } = await import('../src/api')
  vi.mocked(api.listSamples).mockResolvedValueOnce([unknownItemSample])
  vi.mocked(api.getSample).mockResolvedValueOnce(unknownItemSample)

  const wrapper = mount(Samples, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' },
        'el-pagination': { template: '<div />' },
        'el-icon': { template: '<i><slot /></i>' },
        'el-tag': { template: '<span><slot /></span>' },
        'el-input': { template: '<input />' },
        ArrowRight: { template: '<i />' },
        RecordAttachments: true,
        BatchEntry: true,
        SymbolInput: true,
        StructuredSheet: true,
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  await wrapper.get('.item').trigger('click')
  await flushPromises()

  const warning = wrapper.get('[data-template-coverage-warning]').text()
  expect(warning).toContain('完全不存在项目')
  expect(warning).toContain('未找到该基质下的实验室原始记录表')
  expect(wrapper.findAll('.pk-list .pk-item')).toHaveLength(0)
})

test('名称有包含关系的检测项目不会互相串表', async () => {
  const soilChromiumSample = { ...sample, matrix: '土壤', items: ['六价铬'] }
  const { api } = await import('../src/api')
  vi.mocked(api.listSamples).mockResolvedValueOnce([soilChromiumSample])
  vi.mocked(api.getSample).mockResolvedValueOnce(soilChromiumSample)

  const wrapper = mount(Samples, {
    global: {
      stubs: {
        'el-button': { template: '<button><slot /></button>' },
        'el-pagination': { template: '<div />' },
        'el-icon': { template: '<i><slot /></i>' },
        'el-tag': { template: '<span><slot /></span>' },
        'el-input': { template: '<input />' },
        ArrowRight: { template: '<i />' },
        RecordAttachments: true,
        BatchEntry: true,
        SymbolInput: true,
        StructuredSheet: true,
      },
      directives: { loading: () => undefined },
    },
  })
  await flushPromises()

  await wrapper.get('.item').trigger('click')
  await flushPromises()

  const choices = wrapper.get('.pk-list').text()
  expect(choices).toContain('HJ-TC-581')
  expect(choices).not.toContain('HJ-TC-029')
})

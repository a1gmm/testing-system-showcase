import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'

vi.mock('../src/api', () => ({
  currentUser: ref({ username: 'tech', name: '技术负责人', roles: ['tech'], status: 'active', created_at: '' }),
  hasRole: (...roles: string[]) => roles.includes('tech'),
  api: { saveRecordsBatch: vi.fn() },
}))

import BatchEntry from '../src/components/BatchEntry.vue'

const wastewaterSample = {
  id: 'W260828-1', client: '批量测试单位', matrix: '废水', items: ['COD'], status: 'testing', note: '',
  contract_id: 'WT2026-0008', round_id: 'WT2026-0008-R01', source: 'field', point_name: null,
  created_at: '2026-08-28T00:00:00.000Z',
}

test('跨合同批量录入显示已完成修订对照的模板', async () => {
  const wrapper = mount(BatchEntry, {
    props: { samples: [wastewaterSample], myTasks: [] },
    global: { stubs: { 'el-button': { template: '<button><slot /></button>' } } },
  })

  await wrapper.get('.search').setValue('HJ-TC-003')

  expect(wrapper.get('.tlist').text()).toContain('HJ-TC-003')
})

test('跨合同批量录入能用证据明确但未标基质的模板匹配真实样品', async () => {
  const wrapper = mount(BatchEntry, {
    props: { samples: [wastewaterSample], myTasks: [] },
    global: { stubs: { 'el-button': { template: '<button><slot /></button>' } } },
  })

  await wrapper.get('.search').setValue('化学需氧量')
  expect(wrapper.get('.tlist').text()).toContain('HJ-TC-103')

  await wrapper.get('.titem').trigger('click')
  expect(wrapper.get('.pick-samples').text()).toContain(wastewaterSample.id)
})

test('跨合同批量录入不把名称包含的另一个项目样品带进来', async () => {
  const chromiumSample = { ...wastewaterSample, id: 'S260830-1', matrix: '土壤', items: ['铬'] }
  const wrapper = mount(BatchEntry, {
    props: { samples: [chromiumSample], myTasks: [] },
    global: { stubs: { 'el-button': { template: '<button><slot /></button>' } } },
  })

  await wrapper.get('.search').setValue('HJ-TC-581')
  await wrapper.get('.titem').trigger('click')

  expect(wrapper.get('.pick-samples').text()).not.toContain(chromiumSample.id)
  expect(wrapper.get('.pick-samples').text()).toContain('没有待检的匹配样品')
})

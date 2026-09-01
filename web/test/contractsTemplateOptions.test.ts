import { flushPromises, mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  api: {
    listProjects: vi.fn(async () => []),
    listRounds: vi.fn(async () => []),
    contractDocUrl: vi.fn(),
  },
}))

vi.mock('../src/api', () => ({ api: mocks.api, UNIT_OPTS: [] }))
vi.mock('../src/permissions', () => ({ can: () => true }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { stage: 'contract', queue: 'write' } }),
  useRouter: () => ({ push: vi.fn(), resolve: (to: any) => ({ path: to.path || '/', query: to.query || {} }) }),
}))

import Contracts from '../src/pages/Contracts.vue'

test('建项项目下拉按当前基质收窄，废水能选氨氮且废气不混入氨氮', async () => {
  const wrapper = mount(Contracts, {
    global: {
      directives: { loading: () => undefined },
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        'el-button': { template: '<button><slot /></button>' },
        'el-icon': { template: '<span><slot /></span>' },
        'el-select': { template: '<div data-project-item-select><slot /></div>' },
        'el-select-v2': true,
        'el-option': { props: ['label', 'value'], template: '<span data-project-item-option>{{ label }}</span>' },
        'el-dialog': true,
        RecordAttachments: true,
        Folder: true,
        Document: true,
      },
    },
  })
  await flushPromises()

  const createButton = wrapper.findAll('button').find(button => button.text().includes('新建委托'))
  expect(createButton).toBeTruthy()
  await createButton!.trigger('click')

  const quoteRow = wrapper.get('.qf-qt-row')
  expect(quoteRow.get('[data-project-item-select]').text()).not.toContain('氨氮')

  await quoteRow.get('select').setValue('废水')
  const options = quoteRow.get('[data-project-item-select]').text()
  expect(options).toContain('氨氮')
  expect(options).toContain('化学需氧量')
})

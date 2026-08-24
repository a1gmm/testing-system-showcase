import { mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'

vi.mock('vue-router', () => ({ useRoute: () => ({ query: { stage: 'sampling' } }) }))
import StageQueueNav from '../src/components/StageQueueNav.vue'

test('阶段页提供五个 query-backed 聚焦队列并保留阶段参数', () => {
  const wrapper = mount(StageQueueNav, {
    props: { active: 'review' },
    global: { stubs: { RouterLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' } } },
  })
  expect(wrapper.findAll('a').map(link => link.text())).toEqual(['待我填写', '待我复核', '待我审核', '已退回', '已定稿'])
  expect(wrapper.findAll('a')[1].attributes('data-to')).toContain('"stage":"sampling"')
  expect(wrapper.findAll('a')[1].attributes('data-to')).toContain('"queue":"review"')
  expect(wrapper.findAll('a')[1].classes()).toContain('active')
})

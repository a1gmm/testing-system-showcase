import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { acceptContract, createContract, getProjectPipeline } from '../src/handlers.ts'

const TEN_STAGE_LABELS = [
  '① 编制委托合同', '② 合同评审', '③ 编制监测方案', '④ 采样指派', '⑤ 现场采样',
  '⑥ 样品交接', '⑦ 质控', '⑧ 实验室分析', '⑨ 1–8 档案归档', '⑩ 出具报告',
]

test('真实项目 pipeline 只返回十阶段并提供当前直接阻塞原因', () => {
  const db = openDb(':memory:')
  const contract = createContract(db, { client: '十阶段测试厂' }, 2026)

  let pipeline = getProjectPipeline(db, contract.id)
  assert.deepEqual(pipeline.stages.map(stage => stage.label), TEN_STAGE_LABELS)
  assert.equal(pipeline.activeIndex, 0)
  assert.deepEqual(pipeline.blockers, ['委托合同尚未确认受理'])
  assert.equal(pipeline.stages.some(stage => stage.label.includes('三级审核')), false)

  acceptContract(db, contract.id, '业务员')
  pipeline = getProjectPipeline(db, contract.id)
  assert.equal(pipeline.stages[pipeline.activeIndex].key, 'contract-review')
  assert.deepEqual(pipeline.blockers, ['合同评审尚未通过'])
})

// 权限矩阵回归测试：钉住 PRD §2.2 的关键分工，防止将来改路由时又散掉
import { test } from 'node:test'
import assert from 'node:assert'
import { PERM } from '../src/permissions.ts'
import { hasRole, type User } from '../src/handlers.ts'

function u(...roles: string[]): User {
  return { username: 'u', name: '测试人', roles, status: 'active', created_at: '', must_change_pw: false }
}
const can = (roles: string[], action: keyof typeof PERM) => hasRole(u(...roles), ...PERM[action])

test('业务员、计划员、报告编制人员按职责分工，不能审核方案', () => {
  assert.ok(can(['sales'], 'contract_edit'))
  assert.ok(can(['planner'], 'scheme_edit'))
  assert.ok(can(['planner'], 'round_assign'))
  assert.ok(can(['report_editor'], 'report_generate'))
  assert.ok(!can(['planner'], 'scheme_review'))
})

test('样品管理员签收交接；质控员派工和记录质控', () => {
  assert.ok(can(['sample_manager'], 'handover_confirm'))
  assert.ok(!can(['qc'], 'round_assign'))
  assert.ok(can(['qc'], 'qc_add'))
  assert.ok(can(['qc'], 'attach_upload'))
  assert.ok(!can(['analyst'], 'handover_confirm'))
  assert.ok(!can(['sales'], 'handover_confirm'))
})

test('采样员：能领设备/现场采样/交样，不能录检测记录', () => {
  assert.ok(can(['sampler'], 'instrument_checkout'))
  assert.ok(can(['sampler'], 'round_field'))
  assert.ok(can(['sampler'], 'handover_send'))
  assert.ok(!can(['sampler'], 'record_save'))
})

test('实验室分析人员录入、复核和审核仍须由后续资格与项目指派收口', () => {
  assert.ok(can(['analyst'], 'record_save'))
  assert.ok(can(['analyst'], 'record_review'))
  assert.ok(can(['analyst'], 'record_approve'))
  assert.ok(!can(['sampler'], 'record_save'))
})

test('报告线：报告编制人员编审、授权签字人签，分析人员/签字人不能编', () => {
  assert.ok(can(['report_editor'], 'report_generate'))
  assert.ok(!can(['analyst'], 'report_generate'))
  assert.ok(!can(['signer'], 'report_generate'))
  assert.ok(can(['report_editor'], 'report_check'))
  assert.ok(!can(['signer'], 'report_check'))
  assert.ok(can(['signer'], 'report_issue'))
  assert.ok(!can(['approver'], 'report_issue'))
})

test('tech 通用兜底但不能绕过实验室分析员录入资格', () => {
  for (const action of Object.keys(PERM) as (keyof typeof PERM)[]) {
    if (action === 'record_save') {
      assert.ok(!can(['tech'], action), 'tech 未兼任分析员时不能录入实验室记录')
      continue
    }
    assert.ok(can(['tech'], action), `tech 应能执行 ${action}`)
  }
})

test('admin 万能；无角色者一律不行', () => {
  for (const action of Object.keys(PERM) as (keyof typeof PERM)[]) {
    assert.ok(can(['admin'], action), `admin 应能执行 ${action}`)
    assert.ok(!can([], action), `无角色不应能执行 ${action}`)
  }
})

test('留痕查看限报告编制人员/技术负责人', () => {
  assert.ok(can(['report_editor'], 'audit_view'))
  assert.ok(!can(['sampler'], 'audit_view'))
  assert.ok(!can(['analyst'], 'audit_view'))
})

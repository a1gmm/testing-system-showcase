// 权限矩阵回归测试：钉住 PRD §2.2 的关键分工，防止将来改路由时又散掉
import { test } from 'node:test'
import assert from 'node:assert'
import { PERM } from '../src/permissions.ts'
import { hasRole, type User } from '../src/handlers.ts'

function u(...roles: string[]): User {
  return { username: 'u', name: '测试人', roles, status: 'active', created_at: '', must_change_pw: false }
}
const can = (roles: string[], action: keyof typeof PERM) => hasRole(u(...roles), ...PERM[action])

test('登记员：能录合同/建方案/派工/编报告，不能审方案', () => {
  assert.ok(can(['registrar'], 'contract_edit'))
  assert.ok(can(['registrar'], 'scheme_edit'))
  assert.ok(can(['registrar'], 'round_assign'))
  assert.ok(can(['registrar'], 'report_generate'))
  assert.ok(!can(['registrar'], 'scheme_review'))
})

test('质控员：能签收交接/派工/记质控/传附件，检测员不能签收', () => {
  assert.ok(can(['qc'], 'handover_confirm'))
  assert.ok(can(['qc'], 'round_assign'))
  assert.ok(can(['qc'], 'qc_add'))
  assert.ok(can(['qc'], 'attach_upload'))
  assert.ok(!can(['tester'], 'handover_confirm'))
  assert.ok(!can(['registrar'], 'handover_confirm'))
})

test('采样员：能领设备/现场采样/交样，不能录检测记录', () => {
  assert.ok(can(['sampler'], 'instrument_checkout'))
  assert.ok(can(['sampler'], 'round_field'))
  assert.ok(can(['sampler'], 'handover_send'))
  assert.ok(!can(['sampler'], 'record_save'))
})

test('三级审核分工：tester 录、reviewer 复核、approver 终审，互不越级', () => {
  assert.ok(can(['tester'], 'record_save'))
  assert.ok(!can(['tester'], 'record_review'))
  assert.ok(can(['reviewer'], 'record_review'))
  assert.ok(!can(['reviewer'], 'record_approve'))
  assert.ok(can(['approver'], 'record_approve'))
  assert.ok(!can(['approver'], 'record_save'))
})

test('报告线：registrar 编、reviewer/approver 审、signer 签，tester/signer 不能编', () => {
  assert.ok(can(['registrar'], 'report_generate'))
  assert.ok(!can(['tester'], 'report_generate'))
  assert.ok(!can(['signer'], 'report_generate'))
  assert.ok(can(['reviewer'], 'report_check'))
  assert.ok(can(['approver'], 'report_check'))
  assert.ok(!can(['signer'], 'report_check'))
  assert.ok(can(['signer'], 'report_issue'))
  assert.ok(!can(['approver'], 'report_issue'))
})

test('tech 全程兜底：每个动作都能干', () => {
  for (const action of Object.keys(PERM) as (keyof typeof PERM)[]) {
    assert.ok(can(['tech'], action), `tech 应能执行 ${action}`)
  }
})

test('admin 万能；无角色者一律不行', () => {
  for (const action of Object.keys(PERM) as (keyof typeof PERM)[]) {
    assert.ok(can(['admin'], action), `admin 应能执行 ${action}`)
    assert.ok(!can([], action), `无角色不应能执行 ${action}`)
  }
})

test('留痕查看限 reviewer/approver/tech', () => {
  assert.ok(can(['reviewer'], 'audit_view'))
  assert.ok(!can(['sampler'], 'audit_view'))
  assert.ok(!can(['tester'], 'audit_view'))
})

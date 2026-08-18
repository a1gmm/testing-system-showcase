import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { validateFrozenSubmission, setOfflineRuleStatus } from '../src/offlineRules.ts'

const payload = {
  formCode: 'HJ-TC-136', draftRevision: 2,
  global: { org: '检测机构', orgSign: '张三', samplingDate: '2026-08-17' },
  rows: [{ sampleSlotId: 'round-1:水:1', sampleNo: '临-001', point: '排口', time: '09:30', item: 'COD', volume: '500mL', preserve: '冷藏', waterColor: '无色', smell: '无', oil: '无', floating: '无', anomaly: '', note: '' }],
}

test('fixed rule version rebuilds and validates the frozen HJ-TC-136 payload', () => {
  const db = openDb(':memory:')
  assert.deepEqual(validateFrozenSubmission(db, 'HJ-TC-136@provisional-v1', payload, { sampleSlotIds: ['round-1:水:1'], samplingDate: '2026-08-17' }), { ruleVersion: 'HJ-TC-136@provisional-v1' })
  assert.throws(() => validateFrozenSubmission(db, 'HJ-TC-136@provisional-v1', { ...payload, rows: [{ ...payload.rows[0], point: '' }] }, { sampleSlotIds: ['round-1:水:1'], samplingDate: '2026-08-17' }), (error: any) => error.code === 'RULE_VALIDATION_FAILED')
})

test('retired safety rule version is rejected with a stable recovery code', () => {
  const db = openDb(':memory:')
  setOfflineRuleStatus(db, 'HJ-TC-136@provisional-v1', 'retired', '质控撤销')
  assert.throws(() => validateFrozenSubmission(db, 'HJ-TC-136@provisional-v1', payload, { sampleSlotIds: ['round-1:水:1'], samplingDate: '2026-08-17' }), (error: any) => error.code === 'RULE_VERSION_RETIRED')
})

test('slot set, frozen date and exact schema are authoritative server checks', () => {
  const db = openDb(':memory:')
  assert.throws(() => validateFrozenSubmission(db, 'HJ-TC-136@provisional-v1', payload, { sampleSlotIds: ['round-1:水:2'], samplingDate: '2026-08-17' }), (error: any) => error.code === 'TASK_VERSION_CONFLICT')
  assert.throws(() => validateFrozenSubmission(db, 'HJ-TC-136@provisional-v1', { ...payload, global: { ...payload.global, samplingDate: '2026-08-18' } }, { sampleSlotIds: ['round-1:水:1'], samplingDate: '2026-08-17' }), (error: any) => error.code === 'RULE_VALIDATION_FAILED')
})

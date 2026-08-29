import test from 'node:test'
import assert from 'node:assert/strict'
import { DomainError, publicErrorResponse } from '../src/domainError.ts'

test('DomainError carries stable protocol semantics separately from human wording', () => {
  const error = new DomainError(409, 'WORKFLOW_STALE_REVISION', '内容已有新版本，请刷新', { revision: 3 })
  assert.equal(error.httpCode, 409)
  assert.equal(error.errorCode, 'WORKFLOW_STALE_REVISION')
  assert.deepEqual(publicErrorResponse(error), {
    status: 409,
    body: { error: '内容已有新版本，请刷新', error_code: 'WORKFLOW_STALE_REVISION', details: { revision: 3 } },
  })
})

test('unknown exceptions are internal failures and do not leak their message', () => {
  assert.deepEqual(publicErrorResponse(new Error('database path and secret detail')), {
    status: 500,
    body: { error: '服务器错误', error_code: 'INTERNAL_ERROR' },
  })
})

test('legacy shaped application errors remain compatible during migration', () => {
  const error: any = new Error('旧业务校验')
  error.httpCode = 400
  error.errorCode = 'LEGACY_VALIDATION'
  assert.deepEqual(publicErrorResponse(error), {
    status: 400,
    body: { error: '旧业务校验', error_code: 'LEGACY_VALIDATION' },
  })
})

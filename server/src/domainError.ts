export type ErrorDetails = Record<string, unknown>

export class DomainError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: ErrorDetails

  constructor(status: number, code: string, message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DomainError'
    this.status = status
    this.code = code
    this.details = details
  }

  // Transitional aliases for callers that still read the historical fields.
  get httpCode() { return this.status }
  get errorCode() { return this.code }
}

export type PublicError = {
  status: number
  body: { error: string; error_code: string; details?: ErrorDetails }
}

export function publicErrorResponse(error: unknown): PublicError {
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: { error: error.message, error_code: error.code, ...(error.details ? { details: error.details } : {}) },
    }
  }

  const legacy = error as { message?: unknown; httpCode?: unknown; errorCode?: unknown }
  if (Number.isInteger(legacy?.httpCode) && typeof legacy?.errorCode === 'string') {
    return {
      status: Number(legacy.httpCode),
      body: { error: String(legacy.message || '请求失败'), error_code: legacy.errorCode },
    }
  }

  return { status: 500, body: { error: '服务器错误', error_code: 'INTERNAL_ERROR' } }
}

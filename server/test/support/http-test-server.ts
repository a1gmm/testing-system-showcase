const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const ATTEMPT_TIMEOUT_MS = 5_000
const RETRY_INTERVAL_MS = 100

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function loginToTestServer(
  baseUrl: string,
  username: string,
  password: string,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs
  let lastStatus: number | undefined
  let lastError: unknown

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(ATTEMPT_TIMEOUT_MS, remainingMs))
    try {
      const response = await fetch(baseUrl + '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: controller.signal,
      })
      if (response.ok) {
        const body = await response.json() as { token?: unknown }
        if (typeof body.token !== 'string' || !body.token) throw new Error('登录响应缺少 token')
        const token = body.token
        return token
      }
      lastStatus = response.status
      await response.body?.cancel()
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
    await delay(Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())))
  }

  const detail = lastStatus === undefined
    ? (lastError instanceof Error ? lastError.message : '没有收到 HTTP 响应')
    : `最后一次 HTTP 状态为 ${lastStatus}`
  throw new Error(`测试服务器在 ${timeoutMs}ms 内未就绪，${username} 无法登录：${detail}`)
}

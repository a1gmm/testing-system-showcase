import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = String(process.env.E2E_PORT || (40_000 + Math.floor(Math.random() * 10_000)))
const databasePath = `/tmp/lims-e2e-${process.pid}.db`
rmSync(databasePath, { force: true })

const server = spawn(process.execPath, ['src/server.ts'], {
  cwd: serverRoot,
  env: { ...process.env, DB_PATH: databasePath, PORT: port },
  stdio: 'inherit',
})

async function waitUntilReady() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`E2E 服务提前退出：${server.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/me`)
      if (response.status === 401) return
    } catch { /* 服务还在启动 */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('E2E 服务 10 秒内未就绪')
}

async function stopServer() {
  if (server.exitCode !== null) return
  server.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
}

let exitCode = 1
try {
  await waitUntilReady()
  exitCode = await new Promise((resolve, reject) => {
    const test = spawn(process.execPath, ['e2e/mainflow.mjs'], {
      cwd: serverRoot,
      env: { ...process.env, E2E_PORT: port },
      stdio: 'inherit',
    })
    test.once('error', reject)
    test.once('exit', code => resolve(code ?? 1))
  })
} catch (error) {
  console.error(error)
} finally {
  await stopServer()
  rmSync(databasePath, { force: true })
}

process.exitCode = exitCode

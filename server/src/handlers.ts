// 业务逻辑：纯函数，接收 db 实例，方便单测（测试用内存库）。
import { randomUUID, scryptSync, randomBytes, createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import type { DB } from './db.ts'
import { rmbUpper } from './rmb.ts'
import { roundGB, decimalsOf } from './gbround.ts'
import { PERM, REPORT_READ_ROLES } from './permissions.ts'
import { activeOfflineRuleVersion } from './offlineRules.ts'
import { ensureSampleSlots } from './mobileSampleSlots.ts'

// ============ 人员 · 登录 · 权限 ============
export const ROLE_LABEL: Record<string, string> = {
  admin: '系统管理员', registrar: '登记员', sampler: '采样员', tester: '检测员',
  reviewer: '复核员', approver: '审核员', signer: '授权签字人', tech: '技术负责人',
  qc: '质控员',
}
export type User = { username: string; name: string; roles: string[]; status: string; created_at: string; must_change_pw: boolean }

// 会话空闲超时：最后活动起算，默认 12 小时无操作即失效（可用 SESSION_IDLE_HOURS 覆盖）
export const SESSION_IDLE_MS = (Number(process.env.SESSION_IDLE_HOURS) || 12) * 3600_000
// 会话绝对有效期：签发起算，默认 7 天必过期——再活跃也得重新登录（可用 SESSION_MAX_DAYS 覆盖）
export const SESSION_ABS_MS = (Number(process.env.SESSION_MAX_DAYS) || 7) * 24 * 3600_000

// —— 输入清洗：脏日期/脏数字进库会让排期算出 NaN、提醒漏报、金额变 null ——
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export function cleanDate(v: unknown, field: string): string | null {
  if (v == null || v === '') return null
  const s = String(v).trim().replace(/[/.]/g, '-')   // 2026/07/25 → 2026-07-25
  if (!DATE_RE.test(s) || isNaN(Date.parse(s + 'T00:00:00'))) throw new Error(`${field} 日期格式应为 YYYY-MM-DD（收到「${v}」）`)
  return s
}
export function cleanNum(v: unknown, field: string, opts: { min?: number; int?: boolean } = {}): number {
  if (v === '' || v == null) return 0
  const n = Number(v)
  if (!isFinite(n)) throw new Error(`${field} 应为数字（收到「${v}」）`)
  if (opts.min != null && n < opts.min) throw new Error(`${field} 不能小于 ${opts.min}（收到 ${n}）`)
  return opts.int ? Math.floor(n) : n
}

// 业务层带状态码的错误：server.ts 会读 httpCode（登录锁定 429 / 越权 403 等），普通 Error 仍按 400 处理
export function httpError(code: number, msg: string, errorCode?: string): Error {
  const e: any = new Error(msg)
  e.httpCode = code
  if (errorCode) e.errorCode = errorCode
  return e
}

// 同人判定：双方登录名都有 → 严格按登录名（重名不互串、改名不绕过）；任一方缺（历史数据）→ 回退姓名比对
export function samePerson(
  a: { name?: string | null; username?: string | null },
  b: { name?: string | null; username?: string | null },
): boolean {
  if (a.username && b.username) return a.username === b.username
  return !!a.name && a.name === b.name
}

// 事务包裹：多步写库要么全成要么全不成。用 SAVEPOINT 而非 BEGIN——可安全嵌套（方案保存里套同步计划等）。
let __spSeq = 0
export function inTx<T>(db: DB, fn: () => T): T {
  const sp = `sp_${++__spSeq}`
  db.exec(`SAVEPOINT ${sp}`)
  try { const r = fn(); db.exec(`RELEASE ${sp}`); return r }
  catch (e) { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); throw e }
}

function hashPw(pw: string, salt: string) { return scryptSync(pw, salt, 32).toString('hex') }
// roles 必须是数组：脏数据（存成字符串）会让 hasRole 的 includes 走字符串语义，
// "xadminx".includes('admin') 就被当成管理员——安全上不能容忍，脏就当无角色
function rowToUser(r: any): User {
  let roles: string[] = []
  try { const v = JSON.parse(r.roles); if (Array.isArray(v)) roles = v.filter(x => typeof x === 'string') } catch { /* 脏数据 → 无角色 */ }
  return { username: r.username, name: r.name, roles, status: r.status, created_at: r.created_at, must_change_pw: !!r.must_change_pw }
}

export const ROLE_CODES = Object.keys(ROLE_LABEL)
function validRoles(roles: unknown): string[] {
  if (!Array.isArray(roles)) throw new Error('岗位必须是列表')
  const out = roles.map(r => String(r).trim()).filter(Boolean)
  const bad = out.filter(r => !ROLE_CODES.includes(r))
  if (bad.length) throw new Error(`不认识的岗位：${bad.join('、')}`)
  return out
}
export function createUser(db: DB, input: { username: string; name: string; roles: string[]; password: string }): User {
  if (!input.username || !input.name) throw new Error('用户名和姓名必填')
  const roles = validRoles(input.roles ?? [])
  if (getUser(db, input.username)) throw new Error(`用户名「${input.username}」已存在；如需修改请用编辑`)  // 防误覆盖他人账号
  const salt = randomBytes(12).toString('hex')
  // 管理员建账号只是给个初始密码，用户首次登录必须自己改（must_change_pw=1）
  db.prepare(`INSERT INTO users (username, name, roles, pass_salt, pass_hash, status, must_change_pw, created_at)
    VALUES (?,?,?,?,?,'active',1,?)`)
    .run(input.username, input.name, JSON.stringify(roles), salt, hashPw(input.password || '123456', salt), new Date().toISOString())
  return getUser(db, input.username)!
}
// 编辑人员：改姓名/岗位/在岗状态（不含密码）
export function updateUser(db: DB, username: string, patch: { name?: string; roles?: string[]; status?: string; certName?: string | null; certUntil?: string | null }): User {
  if (!getUser(db, username)) throw new Error('用户不存在')
  const roles = patch.roles ? validRoles(patch.roles) : null
  db.prepare(`UPDATE users SET name=COALESCE(?,name), roles=COALESCE(?,roles), status=COALESCE(?,status) WHERE username=?`)
    .run(patch.name ?? null, roles ? JSON.stringify(roles) : null, patch.status ?? null, username)
  // 授权效期（2026新规"先授权后上岗"）：证书名+有效期；传空串=清除
  if (patch.certName !== undefined || patch.certUntil !== undefined) {
    db.prepare(`UPDATE users SET cert_name=COALESCE(?,cert_name), cert_until=COALESCE(?,cert_until) WHERE username=?`)
      .run(patch.certName ?? null, patch.certUntil ?? null, username)
    if (patch.certName === '') db.prepare(`UPDATE users SET cert_name=NULL WHERE username=?`).run(username)
    if (patch.certUntil === '') db.prepare(`UPDATE users SET cert_until=NULL WHERE username=?`).run(username)
  }
  // 停用即踢下线：不能等空闲超时（辞退的人手机上还登着照样能改数据）
  if (patch.status && patch.status !== 'active') revokeSessions(db, username)
  return getUser(db, username)!
}
// 吊销某人全部会话（停用/改密/重置密码后调用）
export function revokeSessions(db: DB, username: string) {
  db.prepare(`DELETE FROM sessions WHERE username=?`).run(username)
}
// 管理员重置某人密码
export function resetPassword(db: DB, username: string, newPassword: string) {
  if (!getUser(db, username)) throw new Error('用户不存在')
  if (!newPassword || newPassword.length < 6) throw new Error('密码至少 6 位')
  const salt = randomBytes(12).toString('hex')
  // 重置成的还是"别人设的密码"，用户下次登录仍须自己改
  db.prepare(`UPDATE users SET pass_salt=?, pass_hash=?, must_change_pw=1 WHERE username=?`).run(salt, hashPw(newPassword, salt), username)
  revokeSessions(db, username)   // 密码换了，旧会话必须失效
}
// 本人改密码：先验原密码
export function changeOwnPassword(db: DB, username: string, oldPassword: string, newPassword: string) {
  const r = db.prepare(`SELECT * FROM users WHERE username=?`).get(username) as any
  if (!r) throw new Error('用户不存在')
  if (hashPw(oldPassword, r.pass_salt) !== r.pass_hash) throw new Error('原密码不正确')
  if (!newPassword || newPassword.length < 6) throw new Error('新密码至少 6 位')
  const salt = randomBytes(12).toString('hex')
  // 本人亲自改的密码 → 清除强制改密标记
  db.prepare(`UPDATE users SET pass_salt=?, pass_hash=?, must_change_pw=0 WHERE username=?`).run(salt, hashPw(newPassword, salt), username)
}
// 会话垃圾清理：超过空闲期 / 超过绝对有效期的会话批量删（登录时顺手做，不需要定时任务）
export function purgeStaleSessions(db: DB, now = Date.now()) {
  db.prepare(`DELETE FROM sessions WHERE COALESCE(last_seen, created_at) < ? OR created_at < ?`)
    .run(new Date(now - SESSION_IDLE_MS).toISOString(), new Date(now - SESSION_ABS_MS).toISOString())
}
export function getUser(db: DB, username: string): User | null {
  const r = db.prepare(`SELECT * FROM users WHERE username=?`).get(username) as any
  return r ? rowToUser(r) : null
}
export function listUsers(db: DB): User[] {
  return (db.prepare(`SELECT * FROM users ORDER BY created_at`).all() as any[]).map(rowToUser)
}
// 派工下拉选人：在职且带采样员角色的（tech 技术负责人兜底也可采样），只暴露必要字段（登录即可查，不限管理员）
export function listSamplers(db: DB): { username: string; name: string }[] {
  return listUsers(db)
    .filter(u => u.status === 'active' && (u.roles.includes('sampler') || u.roles.includes('tech')))
    .map(u => ({ username: u.username, name: u.name }))
}
// 派检测任务下拉选人：在职且带检测员角色的（tech 兜底也能测）
export function listTesters(db: DB): { username: string; name: string }[] {
  return listUsers(db)
    .filter(u => u.status === 'active' && (u.roles.includes('tester') || u.roles.includes('tech')))
    .map(u => ({ username: u.username, name: u.name }))
}
// —— 登录防爆破：进程内计数（零依赖，重启清零可接受）。连续失败 5 次锁 15 分钟，期间一律 429 ——
const LOGIN_MAX_FAILS = 5
const LOGIN_LOCK_MS = 15 * 60_000
const loginFails = new Map<string, { fails: number; lockedUntil: number }>()
export function login(db: DB, username: string, password: string, nowMs = Date.now()): { token: string; user: User } {
  if (!username || !password) throw new Error('请输入用户名和密码')
  const key = String(username)
  const st = loginFails.get(key)
  if (st) {
    if (st.lockedUntil > nowMs) {
      const mins = Math.ceil((st.lockedUntil - nowMs) / 60_000)
      throw httpError(429, `密码连续错了 ${LOGIN_MAX_FAILS} 次，该账号已临时锁定，请 ${mins} 分钟后再试`)
    }
    if (st.lockedUntil > 0) loginFails.delete(key)   // 锁已到期：重新从零计数
  }
  // 失败一次记一笔；攒够 5 次直接上锁并回 429
  const fail = (): never => {
    const cur = loginFails.get(key) ?? { fails: 0, lockedUntil: 0 }
    cur.fails++
    if (cur.fails >= LOGIN_MAX_FAILS) cur.lockedUntil = nowMs + LOGIN_LOCK_MS
    loginFails.set(key, cur)
    if (cur.lockedUntil > nowMs) {
      throw httpError(429, `密码连续错了 ${LOGIN_MAX_FAILS} 次，该账号已临时锁定，请 ${Math.ceil(LOGIN_LOCK_MS / 60_000)} 分钟后再试`)
    }
    // 统一错误文案：不区分「账号不存在」和「密码不对」，避免被拿来枚举用户名
    throw new Error('用户名或密码不正确')
  }
  const r = db.prepare(`SELECT * FROM users WHERE username=?`).get(key) as any
  if (!r || r.status !== 'active') fail()
  if (hashPw(String(password), r.pass_salt) !== r.pass_hash) fail()
  loginFails.delete(key)   // 登录成功清零
  purgeStaleSessions(db)   // 顺手清过期会话，别让会话表长垃圾
  const token = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO sessions (token, username, created_at, last_seen) VALUES (?,?,?,?)`).run(token, username, now, now)
  return { token, user: rowToUser(r) }
}
export function reauthenticate(db:DB,username:string,password:string,nowMs=Date.now()){const result=login(db,username,password,nowMs);db.prepare(`DELETE FROM sessions WHERE token=?`).run(result.token);return result.user}
// token 换用户：空闲超过 SESSION_IDLE_MS 即失效并清理，否则续期 last_seen。now 便于单测注入。
export function sessionUser(db: DB, token: string, now: number = Date.now()): User | null {
  if (!token) return null
  const s = db.prepare(`SELECT username, last_seen, created_at FROM sessions WHERE token=?`).get(token) as any
  if (!s) return null
  const last = Date.parse(s.last_seen || s.created_at)
  const born = Date.parse(s.created_at)
  // fail closed：时间戳不可解析(脏数据)当作已过期，安全超时宁可误杀不放行；
  // 绝对有效期：签发起超 7 天必过期——token 泄露的风险窗口不能靠"一直活跃"无限续
  if (!Number.isFinite(last) || now - last > SESSION_IDLE_MS ||
      !Number.isFinite(born) || now - born > SESSION_ABS_MS) {
    db.prepare(`DELETE FROM sessions WHERE token=?`).run(token)   // 过期即清理，别留垃圾会话
    return null
  }
  const user = getUser(db, s.username)
  // 停用的账号带着旧 token 也不放行（停用时已踢会话，这里兜底：直接改库/竞态也进不来）
  if (!user || user.status !== 'active') {
    db.prepare(`DELETE FROM sessions WHERE token=?`).run(token)
    return null
  }
  // 续期节流：仅当 last_seen 超过 60s 才写，省掉每个 GET 都写库的放大（大量并行请求下也降低锁冲突）
  if (now - last > 60_000) {
    db.prepare(`UPDATE sessions SET last_seen=? WHERE token=?`).run(new Date(now).toISOString(), token)
  }
  return user
}
export function logout(db: DB, token: string) { db.prepare(`DELETE FROM sessions WHERE token=?`).run(token) }

// —— 强制改初始密码：未改密的用户，除白名单接口外一律拦截 ——
const PW_CHANGE_ALLOW = new Set(['/api/me', '/api/change-password', '/api/logout', '/api/login'])
export function needsPasswordChange(user: User | null, path: string): boolean {
  return !!user?.must_change_pw && !PW_CHANGE_ALLOW.has(path)
}

// —— CORS 收紧：默认不发 Access-Control-Allow-Origin（同源部署无需跨域）——
// ALLOWED_ORIGIN 为空→null(不发)；为 '*'→放开；为逗号分隔白名单→命中来源才回显。
export function corsHeaderValue(allowed: string, requestOrigin: string): string | null {
  if (!allowed) return null
  if (allowed === '*') return '*'
  const list = allowed.split(',').map(s => s.trim()).filter(Boolean)
  return list.includes(requestOrigin) ? requestOrigin : null
}
// admin 万能；其余角色命中任一即可
export function hasRole(user: User | null, ...roles: string[]): boolean {
  if (!user) return false
  if (user.roles.includes('admin')) return true
  return roles.some(r => user.roles.includes(r))
}

// —— 读权限收口（体检8）——
// 合同/项目对采样员·检测员不能整门拦（登记自送样要选合同），但报价/评审/开票是商务数据，
// 只有 登记员/技术负责人/授权签字人（admin 恒真）能看全量；其他角色响应里剥掉商务字段。
export function canSeeCommercial(user: User | null): boolean {
  return hasRole(user, 'registrar', 'tech', 'signer')
}
export function stripCommercial<T extends { quote?: any; review_info?: any }>(c: T | null): T | null {
  if (!c) return c
  const out: any = { ...c }
  delete out.quote        // 报价单：明细行/折扣/合计/开票信息全在里面
  delete out.review_info  // 合同评审：能力/风险/分包评估
  return out
}
export function contractForUser<T extends { quote?: any; review_info?: any }>(user: User | null, c: T | null): T | null {
  return canSeeCommercial(user) ? c : stripCommercial(c)
}

// —— 记录留痕可见性（体检9）：编制人本人（录入页看自己记录的留痕）或有 audit_view 权限 ——
export function canSeeRecordAudit(user: User, rec: { author?: string | null; author_username?: string | null }): boolean {
  if (hasRole(user, ...PERM.audit_view)) return true
  return samePerson({ name: rec.author, username: rec.author_username }, { name: user.name, username: user.username })
}

// —— URL token 白名单（体检22）：只有 img/iframe/新标签带不了鉴权头的 GET 下载路径认 ?token=，
// 其余接口一律只认 Authorization 头——token 进 URL 会落访问日志/浏览器历史/Referer
const URL_TOKEN_PATHS = [
  /^\/api\/attachments\/file\/[^/]+$/,   // 附件直链（img/iframe 预览）
  /^\/api\/contracts\/[^/]+\/doc$/,      // 合同原件（iframe 预览/新标签下载）
]
export function urlTokenAllowed(method: string, path: string): boolean {
  return method === 'GET' && URL_TOKEN_PATHS.some(re => re.test(path))
}

// —— 人员名单脱敏（体检40）：下拉选人只需要姓名；username 是登录名（撞库素材），
// 只发给真正要用它派工的人（round_assign / task_assign），其他登录者只给姓名
export function maskUserList(rows: { username: string; name: string }[], full: boolean): ({ username: string; name: string } | { name: string })[] {
  return full ? rows : rows.map(r => ({ name: r.name }))
}
export function seedUsers(db: DB) {
  if ((db.prepare(`SELECT COUNT(*) n FROM users`).get() as any).n > 0) return
  const seed: [string, string, string[]][] = [
    ['demo_admin', '林工程师', ['admin', 'signer']],
    ['demo_registrar', '周登记', ['registrar']],
    ['demo_sampler', '赵采样', ['sampler']],
    ['demo_tester', '陈检测', ['tester']],
    ['demo_qc', '吴质控', ['qc']],
    ['demo_reviewer', '郑复核', ['reviewer']],
    ['demo_approver', '孙审核', ['approver']],
    ['demo_tech', '许技术', ['tech']],
  ]
  for (const [username, name, roles] of seed) createUser(db, { username, name, roles, password: '123456' })
}

export type Sample = {
  id: string; client: string; matrix: string
  items: string[]; status: string; note: string; contract_id: string | null; round_id: string | null; source: string
  qc_type: string | null   // S4：质控样类型（全程序空白/运输空白/现场平行），普通样为 null
  point_name: string | null; point_code: string | null   // 决策1：样品来自哪个点位
  created_at: string
}
export type ContractSample = { id: number; contract_id: string; matrix: string; items: string[]; qty: number; cycle_months: number; note: string; point?: string; per_year?: number | null }
export type SchemePoint = { element: string; point: string; items: string[]; freq: string; standard: string }
// 批次二地基2：限值结构化——结论要写《标准全名》（标准号）表N+级别，光一个 standard 字符串不够
export type LimitRule = {
  analyte: string; op: '≤' | '≥' | 'range'; value: number | null; value2?: number | null; unit: string
  standard?: string          // 旧字段：标准号简写（兼容存量）
  stdName?: string           // 标准全名（如"纺织染整工业水污染物排放标准"）
  stdNo?: string             // 标准号（如"GB 4287-2012"）
  tableNo?: string           // 表号（如"表2"）
  level?: string             // 级别/类别（如"一级"/"重点控制区"）
}
export type Scheme = {
  id: string; contract_id: string; points: SchemePoint[]; limits: LimitRule[]
  cycle_months: number; period_start: string | null; period_end: string | null
  status: string; reviewer: string | null; reviewed_at: string | null; reject_reason: string | null; created_at: string
}

// 达标判定：拿检测结果值对执行标准限值，返回 达标/超标/—（无限值或非数值）
export function judgeResult(value: any, rule?: LimitRule): { verdict: '达标' | '超标' | ''; limitText: string } {
  if (!rule || rule.value == null) return { verdict: '', limitText: '' }
  // GB/T 8170：先把结果修约到与限值相同的位数再比（评审口径按报告显示值判定；
  // 原来拿未修约原值直接比，卡在限值边上的数"达标/超标"会和纸面数字对不上）
  const rawV = Number(value)
  const v = isFinite(rawV) ? roundGB(rawV, Math.max(decimalsOf(rule.value), rule.value2 != null ? decimalsOf(rule.value2) : 0)) : rawV
  const unit = rule.unit || ''
  if (rule.op === 'range') {
    const lo = rule.value, hi = rule.value2 ?? rule.value
    const text = `${lo}~${hi}${unit}`
    if (!isFinite(v)) return { verdict: '', limitText: text }
    return { verdict: v >= lo && v <= (hi as number) ? '达标' : '超标', limitText: text }
  }
  const text = `${rule.op}${rule.value}${unit}`
  if (!isFinite(v)) return { verdict: '', limitText: text }
  const ok = rule.op === '≤' ? v <= rule.value : v >= rule.value
  return { verdict: ok ? '达标' : '超标', limitText: text }
}
// ============ 公司主数据（批次二地基1）：报告抬头/地址/证书号，全站取用 ============
export type OrgProfile = { id: number; name: string; name_en: string | null; address: string | null; postcode: string | null; phone: string | null; fax: string | null; cma_no: string | null; note: string | null }
export function getOrgProfile(db: DB): OrgProfile {
  let r = db.prepare(`SELECT * FROM org_profile WHERE id=1`).get() as OrgProfile | undefined
  if (!r) {
    // 首次读时落默认值（取自现行纸质报告的公司信息），之后管理员可在系统里改
    db.prepare(`INSERT INTO org_profile (id, name, name_en, address, postcode, phone, fax, cma_no, note)
      VALUES (1,'示例环境检测技术服务有限公司','Example Environmental Testing','示例市高新区创新路100号','265600','010-55550000','010-55550000','','')`).run()
    r = db.prepare(`SELECT * FROM org_profile WHERE id=1`).get() as OrgProfile
  }
  return r
}
export function updateOrgProfile(db: DB, patch: Partial<Omit<OrgProfile, 'id'>>, actor: { name: string; username?: string }): OrgProfile {
  const cur = getOrgProfile(db)
  db.prepare(`UPDATE org_profile SET name=?, name_en=?, address=?, postcode=?, phone=?, fax=?, cma_no=?, note=? WHERE id=1`)
    .run(patch.name ?? cur.name, patch.name_en ?? cur.name_en, patch.address ?? cur.address, patch.postcode ?? cur.postcode,
      patch.phone ?? cur.phone, patch.fax ?? cur.fax, patch.cma_no ?? cur.cma_no, patch.note ?? cur.note)
  logAction(db, 'org-profile', actor as User, 'org_profile_update', { patch: Object.keys(patch) })
  return getOrgProfile(db)
}
function limitFor(limits: LimitRule[], analyte: string): LimitRule | undefined {
  return limits.find(l => l.analyte === analyte)
}
// 结论草稿生成器（拍板3：自动草稿+人工确认，翻案决策15）。句式库照21份报告拆解：
// ① 全符合单标准 ② 无限值不予判定 ③ 项目组×标准分组分号串联 ④ 超标句 ⑤ 豁免句前置（如水温<12℃→BOD5）
export function buildConclusionDraft(
  results: { analyte: string; verdict: string }[],
  limits: LimitRule[],
  opts: { exemptions?: { analyte: string; reason?: string }[] } = {},
): string {
  const exempts = opts.exemptions ?? []
  const exemptSet = new Set(exempts.map(e => e.analyte))
  const rest = results.filter(r => !exemptSet.has(r.analyte))
  const prefix = exempts.length ? exempts.map(e => `${e.analyte}不予判定`).join('、') + '；' : ''
  const stdKey = (l?: LimitRule) =>
    l?.stdNo ? `《${l.stdName || l.stdNo}》（${l.stdNo}）${l.tableNo || ''}${l.level || ''}` : (l?.standard ? `《${l.standard}》` : '')
  const groups = new Map<string, { ok: string[]; over: string[] }>()
  for (const r of rest) {
    if (!r.verdict) continue
    const key = stdKey(limitFor(limits, r.analyte))
    if (!key) continue
    const g = groups.get(key) ?? { ok: [], over: [] }
    ;(r.verdict === '超标' ? g.over : g.ok).push(r.analyte)
    groups.set(key, g)
  }
  if (!groups.size) return prefix ? prefix.replace(/；$/, '。') : '以上检测项目检测结果不予判定。'
  const judged = rest.filter(r => r.verdict).length
  const parts: string[] = []
  const single = groups.size === 1
  for (const [key, g] of groups) {
    if (g.ok.length && !g.over.length) {
      // 单标准且覆盖全部项目 → "以上检测项目"；有豁免时照 0106 原文用"以上其它检测项目"
      const subj = single && g.ok.length === judged ? (prefix ? '以上其它检测项目' : '以上检测项目') : g.ok.join('、')
      parts.push(`${subj}检测结果符合${key}限值要求`)
    } else {
      if (g.ok.length) parts.push(`${g.ok.join('、')}检测结果符合${key}限值要求`)
      if (g.over.length) parts.push(`${g.over.join('、')}检测结果超出${key}限值要求`)
    }
  }
  return prefix + parts.join('；') + '。'
}
// 报告「编制人」真值：取该记录的实际录入/提交人（从留痕里读，不再写死）
function recordAuthor(db: DB, recordId: string): string {
  const a = getAudit(db, recordId)
  return (a.find(x => x.action === 'submit') || a.find(x => x.action === 'create'))?.who || ''
}
export type Round = {
  id: string; contract_id: string; round_no: number; due_date: string; status: string
  items: { matrix: string; items: string[]; qty: number }[]
  plan_id: string | null; sampler: string | null; sampler_ids: string[]; assignment_status: string
  assignment_updated_at: string | null; plan_date: string | null; sampled_at: string | null; field_info: any; created_at: string
  fail_reason: string | null; orig_due_date: string | null   // 采不成/改期留痕
}
export type Contract = {
  id: string; client: string; contact: string; phone: string | null; project: string; note: string
  status: string; doc_name: string | null; doc_path: string | null
  accepted_at: string | null; accepted_by: string | null; review_info: any
  cycle_months: number; period_start: string | null; period_end: string | null; created_at: string
  plan: ContractSample[]        // 约定的样品计划
  samples: Sample[]             // 已生成的真实样品
  scheme: Scheme | null         // 监测方案（受理后编制）
  quote: Quote | null           // 合同报价单（按纸质模板在线填写）
}

// ============ 合同报价单（按示例纸质合同模板附件1） ============
export type QuoteRow = {
  category: string              // 类别：有组织废气/无组织废气/废水/噪声…
  point: string                 // 点位名称
  items: string[]               // 检测项目（字典勾选）
  extraItems?: string           // 手写补充项目（顿号/逗号分隔）
  price: number                 // 单价（报价）
  points: number                // 点位数
  perDay: number                // 频次 次/天
  perYear: number               // 频次 次/年（0=单次）
  subtotal?: number             // 小计（服务端算）
  note?: string
}
// 甲方开票信息：打印合同「委托单位（盖章）」栏自动带出，全部选填，不填留白手写
export type QuoteBuyer = { addr?: string; bank?: string; account?: string; taxNo?: string; bankNo?: string; legal?: string }
export type Quote = {
  extNo?: string; signDate?: string; invoice?: string
  buyer?: QuoteBuyer
  rows: QuoteRow[]
  total: number; discount: number; discountUpper: string
}

export function setContractDoc(db: DB, id: string, name: string, path: string) {
  db.prepare(`UPDATE contracts SET doc_name=?, doc_path=? WHERE id=?`).run(name, path, id)
}
export function getContractRow(db: DB, id: string): { doc_path: string; doc_name: string } | null {
  return (db.prepare(`SELECT doc_path, doc_name FROM contracts WHERE id=?`).get(id) as any) ?? null
}
export type RecordRow = {
  id: string; serial: string | null; sample_id: string; template_code: string; template_name: string
  sheet_type: string; method: string; analyte: string; matrix: string
  instrument_id: string | null; data: any; status: string
  reviewer: string | null; reviewed_at: string | null
  approver: string | null; approved_at: string | null; reject_reason: string | null
  recheck: number; recheck_reason: string | null   // 超标复检标记
  updated_at: string
}

const now = () => new Date().toISOString()

// 台账/效期用的是本地日历日（北京日），不是 UTC 日。
// toISOString() 取的是 UTC，在东八区凌晨 0–8 点会退回昨天，导致效期少算一天、到期提醒漏报。
export function todayLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// —— 样品编号生成：<基质字母><年>-<四位序号>，如 W2026-0001 —— //
const MATRIX_LETTER: Record<string, string> = {
  废水: 'W', 地表水: 'S', 地下水: 'D', 海水: 'H', 土壤: 'T',
  固废: 'G', 环境空气: 'A', 废气: 'Q', 有组织废气: 'Q', 无组织废气: 'Q', 生活饮用水: 'Y', 大气降水: 'R', 噪声: 'N',
}
// 取同前缀的最大序号：必须按数值比，不能靠字符串排序
// （'W2026-9999' > 'W2026-10000'，破万后会取错 max 生成重号 → 主键冲突 500）
function maxSeq(db: DB, table: string, col: string, prefix: string): number {
  const rows = db.prepare(`SELECT ${col} v FROM ${table} WHERE ${col} LIKE ?`).all(prefix + '%') as { v: string }[]
  return rows.reduce((m, r) => Math.max(m, parseInt(String(r.v).slice(prefix.length), 10) || 0), 0)
}
// 2026-07-31 拍板（替代决策9）：统一盲样编号 = 介质码+YYMMDD-序号（如 W260731-1）。
// 编号不含合同段/点位段（真盲不泄底，归属靠 samples 表反查）；质控样与普通样连续不可区分；
// 空白样序号用 0（沿纸质习惯，如 F260114-0），同日多个空白 0/00 递增；序号不补零，数值比较取末号。
export function nextBlindSampleId(db: DB, matrix: string, date: string, kind: 'normal' | 'blank' = 'normal'): string {
  const letter = MATRIX_LETTER[matrix] || 'X'
  const prefix = `${letter}${date.replaceAll('-', '').slice(2)}-`
  const tails = (db.prepare(`SELECT id FROM samples WHERE id LIKE ?`).all(prefix + '%') as { id: string }[])
    .map(r => r.id.slice(prefix.length))
  if (kind === 'blank') return prefix + '0'.repeat(tails.filter(t => /^0+$/.test(t)).length + 1)
  const last = tails.reduce((m, t) => (/^0+$/.test(t) ? m : Math.max(m, parseInt(t, 10) || 0)), 0)
  return prefix + String(last + 1)
}

export function createSample(
  db: DB,
  input: { client?: string; matrix: string; items?: string[]; note?: string; contractId?: string; roundId?: string; qcType?: string; pointName?: string; pointCode?: string },
  year = new Date().getFullYear(),
): Sample {
  const created_at = now()
  // 编号：一律走盲样新规（介质码+YYMMDD-序号）；空白样（qc_type 含"空白"）序号取 0
  const id = nextBlindSampleId(db, input.matrix, todayLocal(new Date(created_at)), input.qcType?.includes('空白') ? 'blank' : 'normal')
  const items = JSON.stringify(input.items ?? [])
  // 来源留痕：走委托/期次的是受托采样(field)，检测录入凭空登记的是自送样(self)，评审时能区分
  const source = (input.contractId || input.roundId) ? 'field' : 'self'
  db.prepare(
    `INSERT INTO samples (id, client, matrix, items, status, note, contract_id, round_id, source, qc_type, point_name, point_code, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.client ?? '', input.matrix, items, input.note ?? '', input.contractId ?? null, input.roundId ?? null, source, input.qcType ?? null, input.pointName ?? null, input.pointCode ?? null, created_at)
  return getSample(db, id)!
}

export function getSample(db: DB, id: string): Sample | null {
  const r = db.prepare(`SELECT * FROM samples WHERE id = ?`).get(id) as any
  if (!r) return null
  return { ...r, items: safeJson(r.items, []) }
}

// ============ 前处理记录（6.1.5）：消解 / 萃取 / 浓缩 / 定容 ============
export type Pretreatment = { id: number; sample_id: string; method: string; reagent: string | null; condition: string | null; vol_final: string | null; note: string | null; who: string; username: string | null; at: string }
export const PRETREAT_METHODS = ['微波消解', '电热板消解', '萃取', '浓缩', '过滤', '定容', '其他']
export function addPretreatment(
  db: DB, sampleId: string,
  ev: { method: string; reagent?: string; condition?: string; volFinal?: string; note?: string },
  actor: { name: string; username?: string },
): Pretreatment {
  if (!getSample(db, sampleId)) throw new Error('样品不存在')
  if (!ev.method) throw new Error('前处理方法必填')
  const info = db.prepare(`INSERT INTO pretreatments (sample_id, method, reagent, condition, vol_final, note, who, username, at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sampleId, ev.method, ev.reagent ?? null, ev.condition ?? null, ev.volFinal ?? null, ev.note ?? null, actor.name, actor.username ?? null, now())
  return db.prepare(`SELECT * FROM pretreatments WHERE id=?`).get(info.lastInsertRowid) as Pretreatment
}
export function listPretreatments(db: DB, sampleId: string): Pretreatment[] {
  return db.prepare(`SELECT * FROM pretreatments WHERE sample_id=? ORDER BY id`).all(sampleId) as Pretreatment[]
}

// ============ 质量体系运行记录（管理体系）：内审 / 管评 / 培训 / 文件受控 ============
export type SystemRecord = { id: number; category: string; title: string; rec_date: string | null; owner: string | null; status: string; content: string | null; result: string | null; note: string | null; who: string; username: string | null; at: string; updated_at: string | null }
export const SYSREC_CATEGORIES = ['内部审核', '管理评审', '人员培训', '文件受控', '监督检查', '期间核查', '检定校准计划', '能力验证', '供应商评价', '不符合与纠正', '其他']
export function addSystemRecord(
  db: DB,
  input: { category: string; title: string; recDate?: string; owner?: string; status?: string; content?: string; result?: string; note?: string },
  actor: { name: string; username?: string },
): SystemRecord {
  if (!input.category || !SYSREC_CATEGORIES.includes(input.category)) throw new Error('体系记录分类必填且须为预设分类')
  if (!input.title) throw new Error('记录标题必填')
  const info = db.prepare(`INSERT INTO system_records (category, title, rec_date, owner, status, content, result, note, who, username, at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.category, input.title, input.recDate ?? null, input.owner ?? null, input.status || '计划中', input.content ?? null, input.result ?? null, input.note ?? null, actor.name, actor.username ?? null, now(), null)
  return db.prepare(`SELECT * FROM system_records WHERE id=?`).get(info.lastInsertRowid) as SystemRecord
}
export function listSystemRecords(db: DB, filter: { category?: string } = {}): SystemRecord[] {
  const where: string[] = [], args: any[] = []
  if (filter.category) { where.push('category=?'); args.push(filter.category) }
  const sql = `SELECT * FROM system_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`
  return db.prepare(sql).all(...args) as SystemRecord[]
}
export function updateSystemRecord(
  db: DB, id: number,
  patch: { title?: string; recDate?: string; owner?: string; status?: string; content?: string; result?: string; note?: string },
  actor: { name: string; username?: string },
): SystemRecord {
  const cur = db.prepare(`SELECT * FROM system_records WHERE id=?`).get(id) as SystemRecord | undefined
  if (!cur) throw new Error('体系记录不存在')
  const v = {
    title: patch.title ?? cur.title,
    rec_date: patch.recDate ?? cur.rec_date,
    owner: patch.owner ?? cur.owner,
    status: patch.status ?? cur.status,
    content: patch.content ?? cur.content,
    result: patch.result ?? cur.result,
    note: patch.note ?? cur.note,
  }
  db.prepare(`UPDATE system_records SET title=?, rec_date=?, owner=?, status=?, content=?, result=?, note=?, updated_at=? WHERE id=?`)
    .run(v.title, v.rec_date, v.owner, v.status, v.content, v.result, v.note, now(), id)
  // 留痕记变更字段的 from→to（体检45）：只记状态查不出改了啥
  const changes = Object.entries(v)
    .filter(([k, to]) => String((cur as any)[k] ?? '') !== String(to ?? ''))
    .map(([k, to]) => ({ col: k, from: (cur as any)[k] ?? '', to: to ?? '' }))
  logAction(db, String(id), actor as User, 'sysrecord_update', { changes })
  return db.prepare(`SELECT * FROM system_records WHERE id=?`).get(id) as SystemRecord
}

// ============ 分包管理（6.1.2）：分包方资质 + 委托方同意 + 结果核验 ============
export type Subcontract = { id: number; contract_id: string | null; items: string | null; subcontractor: string; qualification: string | null; reason: string | null; consent: number; status: string; result_note: string | null; note: string | null; who: string; username: string | null; at: string; updated_at: string | null }
export const SUBCONTRACT_STATUS = ['计划中', '已分包', '结果已核']
export function addSubcontract(
  db: DB,
  input: { contractId?: string; items?: string; subcontractor: string; qualification?: string; reason?: string; consent?: boolean; status?: string; note?: string },
  actor: { name: string; username?: string },
): Subcontract {
  if (!input.subcontractor) throw new Error('分包方（承接实验室）必填')
  const info = db.prepare(`INSERT INTO subcontracts (contract_id, items, subcontractor, qualification, reason, consent, status, result_note, note, who, username, at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.contractId ?? null, input.items ?? null, input.subcontractor, input.qualification ?? null, input.reason ?? null, input.consent ? 1 : 0, input.status || '计划中', null, input.note ?? null, actor.name, actor.username ?? null, now(), null)
  return db.prepare(`SELECT * FROM subcontracts WHERE id=?`).get(info.lastInsertRowid) as Subcontract
}
export function listSubcontracts(db: DB, filter: { contractId?: string } = {}): Subcontract[] {
  const where: string[] = [], args: any[] = []
  if (filter.contractId) { where.push('contract_id=?'); args.push(filter.contractId) }
  const sql = `SELECT * FROM subcontracts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`
  return db.prepare(sql).all(...args) as Subcontract[]
}
export function updateSubcontract(
  db: DB, id: number,
  patch: { items?: string; subcontractor?: string; qualification?: string; reason?: string; consent?: boolean; status?: string; resultNote?: string; note?: string },
  actor: { name: string; username?: string },
): Subcontract {
  const cur = db.prepare(`SELECT * FROM subcontracts WHERE id=?`).get(id) as Subcontract | undefined
  if (!cur) throw new Error('分包记录不存在')
  const v = {
    items: patch.items ?? cur.items,
    subcontractor: patch.subcontractor ?? cur.subcontractor,
    qualification: patch.qualification ?? cur.qualification,
    reason: patch.reason ?? cur.reason,
    consent: patch.consent == null ? cur.consent : (patch.consent ? 1 : 0),
    status: patch.status ?? cur.status,
    result_note: patch.resultNote ?? cur.result_note,
    note: patch.note ?? cur.note,
  }
  db.prepare(`UPDATE subcontracts SET items=?, subcontractor=?, qualification=?, reason=?, consent=?, status=?, result_note=?, note=?, updated_at=? WHERE id=?`)
    .run(v.items, v.subcontractor, v.qualification, v.reason, v.consent, v.status, v.result_note, v.note, now(), id)
  // 留痕记变更字段的 from→to（体检45）
  const changes = Object.entries(v)
    .filter(([k, to]) => String((cur as any)[k] ?? '') !== String(to ?? ''))
    .map(([k, to]) => ({ col: k, from: (cur as any)[k] ?? '', to: to ?? '' }))
  logAction(db, String(id), actor as User, 'subcontract_update', { changes })
  return db.prepare(`SELECT * FROM subcontracts WHERE id=?`).get(id) as Subcontract
}

// ============ 质量控制（6.1.5）：密码样 / 平行样 / 加标回收 / 空白，自动判合格 ============
export type QcInput =
  | { type: '平行样'; v1: number; v2: number; limit?: number }
  | { type: '加标回收'; background: number; spikedMeasured: number; spikeAdded: number; low?: number; high?: number }
  | { type: '密码样'; measured: number; assigned: number; limit?: number }
  | { type: '空白'; measured: number; limit: number }
export type QcJudge = { result: number | null; verdict: '合格' | '不合格' | ''; criterion: string }
const round2 = (n: number) => Math.round(n * 100) / 100
export function judgeQc(q: any): QcJudge {
  const num = (x: any) => { const n = Number(x); return isFinite(n) ? n : NaN }
  if (q.type === '平行样') {
    const v1 = num(q.v1), v2 = num(q.v2), lim = q.limit ?? 10
    const criterion = `相对偏差 ≤ ${lim}%`
    if (!isFinite(v1) || !isFinite(v2) || v1 + v2 === 0) return { result: null, verdict: '', criterion }
    const rd = Math.abs(v1 - v2) / (v1 + v2) * 100
    return { result: round2(rd), verdict: rd <= lim ? '合格' : '不合格', criterion }
  }
  if (q.type === '加标回收') {
    const bg = num(q.background), sm = num(q.spikedMeasured), add = num(q.spikeAdded)
    const low = q.low ?? 90, high = q.high ?? 110
    const criterion = `回收率 ${low}~${high}%`
    if (!isFinite(bg) || !isFinite(sm) || !isFinite(add) || add === 0) return { result: null, verdict: '', criterion }
    const rec = (sm - bg) / add * 100
    return { result: round2(rec), verdict: rec >= low && rec <= high ? '合格' : '不合格', criterion }
  }
  if (q.type === '密码样') {
    const m = num(q.measured), a = num(q.assigned), lim = q.limit ?? 10
    const criterion = `相对误差 ±${lim}%`
    if (!isFinite(m) || !isFinite(a) || a === 0) return { result: null, verdict: '', criterion }
    const re = (m - a) / a * 100
    return { result: round2(re), verdict: Math.abs(re) <= lim ? '合格' : '不合格', criterion }
  }
  if (q.type === '空白') {
    const m = num(q.measured), lim = num(q.limit)
    const criterion = `≤ 检出限 ${isFinite(lim) ? lim : ''}`
    if (!isFinite(m) || !isFinite(lim)) return { result: isFinite(m) ? m : null, verdict: '', criterion }
    return { result: round2(m), verdict: m <= lim ? '合格' : '不合格', criterion }
  }
  return { result: null, verdict: '', criterion: '' }
}

export type QcRecord = {
  id: number; qc_type: string; round_id: string | null; sample_id: string | null; analyte: string | null
  data: any; unit: string | null; result: number | null; verdict: string | null; criterion: string | null
  note: string | null; who: string; username: string | null; at: string
}
export function addQc(
  db: DB,
  input: { qcType: string; roundId?: string; sampleId?: string; analyte?: string; unit?: string; note?: string } & Record<string, any>,
  actor: { name: string; username?: string },
): QcRecord {
  if (!input.qcType) throw new Error('质控类型必填')
  if (input.roundId && !getRound(db, input.roundId)) {
    throw httpError(404, '监测期次不存在', 'ROUND_NOT_FOUND')
  }
  // 没填任何测定数据的空记录不许提交（列表里会显示 undefined 又删不掉）
  const hasData = ['v1', 'v2', 'background', 'spikedMeasured', 'spikeAdded', 'measured', 'assigned']
    .some(k => input[k] !== undefined && input[k] !== null && String(input[k]).trim() !== '')
  if (!hasData) throw new Error('请先填测定数据再记质控（一个数都没填）')
  const j = judgeQc({ type: input.qcType, ...input })
  const data = JSON.stringify({ v1: input.v1, v2: input.v2, background: input.background, spikedMeasured: input.spikedMeasured, spikeAdded: input.spikeAdded, measured: input.measured, assigned: input.assigned, limit: input.limit, low: input.low, high: input.high })
  const info = db.prepare(`INSERT INTO qc_records (qc_type, round_id, sample_id, analyte, data, unit, result, verdict, criterion, note, who, username, at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.qcType, input.roundId ?? null, input.sampleId ?? null, input.analyte ?? null, data, input.unit ?? null, j.result, j.verdict, j.criterion, input.note ?? null, actor.name, actor.username ?? null, now())
  return db.prepare(`SELECT * FROM qc_records WHERE id=?`).get(info.lastInsertRowid) as QcRecord
}
export function listQc(db: DB, filter: { roundId?: string; sampleId?: string } = {}): QcRecord[] {
  const where: string[] = [], args: any[] = []
  if (filter.roundId) { where.push('round_id=?'); args.push(filter.roundId) }
  if (filter.sampleId) { where.push('sample_id=?'); args.push(filter.sampleId) }
  const sql = `SELECT * FROM qc_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`
  return (db.prepare(sql).all(...args) as any[]).map(r => ({ ...r, data: safeJson(r.data, {}) }))
}

// ============ 样品交接 / 流转 / 留样 / 处置（6.1.4）============
export type Handover = {
  id: number; sample_id: string; action: string
  from_person: string | null; to_person: string | null; condition: string | null; note: string | null
  who: string; username: string | null; at: string
  confirmed_by: string | null; confirmed_at: string | null   // 双签：接收方确认签收
}
export const HANDOVER_ACTIONS = ['采样交接', '接样入库', '流转领用', '归还', '留样', '处置']
export function addHandover(
  db: DB, sampleId: string,
  ev: { action: string; fromPerson?: string; toPerson?: string; condition?: string; note?: string },
  actor: { name: string; username?: string },
): Handover {
  if (!getSample(db, sampleId)) throw new Error('样品不存在')
  if (!ev.action) throw new Error('交接类型必填')
  db.prepare(`INSERT INTO sample_handovers (sample_id, action, from_person, to_person, condition, note, who, username, at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sampleId, ev.action, ev.fromPerson ?? null, ev.toPerson ?? null, ev.condition ?? null, ev.note ?? null, actor.name, actor.username ?? null, now())
  const list = listHandovers(db, sampleId)
  return list[list.length - 1]
}
export function listHandovers(db: DB, sampleId: string): Handover[] {
  return db.prepare(`SELECT * FROM sample_handovers WHERE sample_id=? ORDER BY id`).all(sampleId) as Handover[]
}
// ============ 检测任务派工（PRD 步骤5：质控员按样品×项目派给检测员） ============
export type TestTask = {
  id: number; sample_id: string; analyte: string
  assignee: string; assignee_username: string | null
  assigned_by: string; assigned_at: string
}
function hasConfirmedHandover(db: DB, sampleId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sample_handovers WHERE sample_id=? AND confirmed_at IS NOT NULL LIMIT 1`).get(sampleId)
}
// 交接闸：主流程样品必须完成交接签收才能往下走；自送样（客户直送）没有现场交接线，放行
// 报错文案要能指路（体检10）：一键生成的样品也会撞到这道闸，得告诉人下一步去哪点什么
export function requireHandoverConfirmed(db: DB, s: Sample) {
  if (s.source === 'self') return
  if (!hasConfirmedHandover(db, s.id)) {
    throw new Error('这个样品还没交接签收——先在样品页记一条交接，再由质控员签收，然后才能录数据')
  }
}
export function assignTestTasks(
  db: DB, sampleId: string,
  items: { analyte: string; assignee: string; assigneeUsername?: string }[],
  actor: { name: string; username?: string },
): (TestTask & { record_status: string })[] {
  const s = getSample(db, sampleId)
  if (!s) throw new Error('样品不存在')
  if ((s as any).status === 'rejected') throw new Error(`样品 ${sampleId} 已被拒收，不能派任务——请采样员补采后对新样派任务`)
  if (!items?.length) throw new Error('至少要派一个检测项目')
  requireHandoverConfirmed(db, s)   // 决策13：未确认签收的样品不允许派任务
  const at = now()
  for (const it of items) {
    if (!it.analyte?.trim() || !it.assignee?.trim()) throw new Error('检测项目和检测员都必填')
    // 决策：派任务的项目须来自方案——样品的项目清单就是方案落到这只样品上的项目
    if (s.items.length && !s.items.includes(it.analyte)) {
      throw new Error(`项目「${it.analyte}」不在该样品的检测项目里（${s.items.join('、')}）`)
    }
    db.prepare(`INSERT INTO test_tasks (sample_id, analyte, assignee, assignee_username, assigned_by, assigned_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(sample_id, analyte) DO UPDATE SET assignee=excluded.assignee,
        assignee_username=excluded.assignee_username, assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at`)
      .run(sampleId, it.analyte, it.assignee, it.assigneeUsername ?? null, actor.name, at)
  }
  return listTestTasks(db, { sampleId })
}
// 任务列表（带记录进度：none 没动 / draft / submitted / reviewed / approved / rejected）
export function listTestTasks(db: DB, f: { sampleId?: string; assignee?: string; unclaimed?: boolean } = {}): (TestTask & { record_status: string })[] {
  const where: string[] = [], args: any[] = []
  if (f.sampleId) { where.push('t.sample_id=?'); args.push(f.sampleId) }
  if (f.assignee) { where.push('t.assignee=?'); args.push(f.assignee) }
  if (f.unclaimed) where.push(`t.assignee=''`)
  const rows = db.prepare(`
    SELECT t.*, COALESCE(r.status, 'none') AS record_status
    FROM test_tasks t
    LEFT JOIN records r ON r.sample_id = t.sample_id AND r.analyte = t.analyte
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.id DESC`).all(...args) as any[]
  return rows
}

// 待签收清单：发起了但接收方还没确认的交接——质控员工作台的活
export function listPendingHandovers(db: DB): (Handover & { client: string | null })[] {
  return db.prepare(`SELECT h.*, s.client FROM sample_handovers h LEFT JOIN samples s ON s.id = h.sample_id
    WHERE h.confirmed_at IS NULL ORDER BY h.id DESC`).all() as any
}
// 交接双签：接收方确认签收。发起时未确认(待接收)，接收方在系统里确认后才算交接完成。
export function confirmHandover(db: DB, handoverId: number, actor: { name: string; username?: string }): Handover {
  const h = db.prepare(`SELECT * FROM sample_handovers WHERE id=?`).get(handoverId) as Handover | undefined
  if (!h) throw new Error('交接记录不存在')
  if (h.confirmed_at) throw new Error('该交接已确认，不能重复确认')
  // 双签的意义在双方：交样人不能自己点确认（按登录名比对，兜底比姓名）
  if ((h.username && actor.username && h.username === actor.username) || (!h.username && h.who === actor.name)) {
    throw new Error('交样人不能自己确认签收，须由接收方（质控员）确认')
  }
  db.prepare(`UPDATE sample_handovers SET confirmed_by=?, confirmed_at=? WHERE id=?`).run(actor.name, now(), handoverId)
  return db.prepare(`SELECT * FROM sample_handovers WHERE id=?`).get(handoverId) as Handover
}

// ============ 交接单（2026-07-31 批次一）：一期样品聚成一张单，自动草稿→可改→整单签收/拒收 ============
export type HandoverSheetRow = {
  sampleId: string; items: string[]; condition?: string; container?: string
  rejected?: boolean; rejectReason?: string
}
export type HandoverSheet = {
  id: string; round_id: string; contract_id: string; source: string
  sample_ids: string[]; detail: HandoverSheetRow[]
  from_person: string | null; from_at: string | null
  to_person: string | null; to_at: string | null
  storage: string | null; status: 'draft' | 'sent' | 'confirmed'; note: string | null; created_at: string
}
function parseSheet(r: any): HandoverSheet {
  return { ...r, sample_ids: JSON.parse(r.sample_ids || '[]'), detail: JSON.parse(r.detail || '[]') }
}
export function getHandoverSheet(db: DB, id: string): HandoverSheet | null {
  const r = db.prepare(`SELECT * FROM handover_sheets WHERE id=?`).get(id) as any
  return r ? parseSheet(r) : null
}
export function listHandoverSheets(db: DB, f: { roundId?: string; status?: string } = {}): HandoverSheet[] {
  const where: string[] = [], args: any[] = []
  if (f.roundId) { where.push('round_id=?'); args.push(f.roundId) }
  if (f.status) { where.push('status=?'); args.push(f.status) }
  // 带出委托单位/项目名：质控页列表要能看出"哪单是哪家"，不能只有一排 JJ 号
  const rows = db.prepare(`SELECT h.*, c.client AS client, c.project AS project FROM handover_sheets h
    LEFT JOIN contracts c ON c.id = h.contract_id
    ${where.length ? 'WHERE ' + where.map(w => 'h.' + w).join(' AND ') : ''} ORDER BY h.created_at DESC, h.id DESC`).all(...args) as any[]
  return rows.map(parseSheet)
}
// 收样入库时自动建草稿（sampleRound 事务内调用）：明细按样品带出项目，交样人=本期采样员
export function createHandoverSheetForRound(
  db: DB, round: { id: string; contract_id: string; sampler: string | null }, samples: Sample[],
  year = new Date().getFullYear(),
): HandoverSheet {
  const id = nextSeqId(db, 'handover_sheets', `JJ${year}-`)
  const detail: HandoverSheetRow[] = samples.map(s => ({ sampleId: s.id, items: s.items, condition: '完好' }))
  db.prepare(`INSERT INTO handover_sheets (id, round_id, contract_id, source, sample_ids, detail, from_person, from_at, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,'draft',?)`)
    .run(id, round.id, round.contract_id, 'field', JSON.stringify(samples.map(s => s.id)), JSON.stringify(detail), round.sampler ?? null, now(), now())
  return getHandoverSheet(db, id)!
}
export function updateHandoverSheet(
  db: DB, id: string,
  patch: { detail?: HandoverSheetRow[]; storage?: string; note?: string; fromPerson?: string },
  actor: { name: string; username?: string },
): HandoverSheet {
  const sh = getHandoverSheet(db, id)
  if (!sh) throw new Error('交接单不存在')
  if (sh.status === 'confirmed') throw new Error('交接单已签收，不能再改')
  db.prepare(`UPDATE handover_sheets SET detail=?, storage=?, note=?, from_person=? WHERE id=?`)
    .run(JSON.stringify(patch.detail ?? sh.detail), patch.storage ?? sh.storage, patch.note ?? sh.note, patch.fromPerson ?? sh.from_person, id)
  logAction(db, id, actor as User, 'handover_sheet_update', { patch: Object.keys(patch) })
  return getHandoverSheet(db, id)!
}
export function sendHandoverSheet(db: DB, id: string, actor: { name: string; username?: string }): HandoverSheet {
  const sh = getHandoverSheet(db, id)
  if (!sh) throw new Error('交接单不存在')
  if (sh.status !== 'draft') throw new Error('只有草稿能发出')
  db.prepare(`UPDATE handover_sheets SET status='sent' WHERE id=?`).run(id)
  logAction(db, id, actor as User, 'handover_sheet_send', {})
  return getHandoverSheet(db, id)!
}
// 整单签收：双签在"单"级校验（交样人不能自签）；成员样品的逐条交接一次性确认，
// 拒收的样品不确认（交接闸继续拦），并在该样品的交接流水里写"拒收+原因"留痕
export function confirmHandoverSheet(
  db: DB, id: string, actor: { name: string; username?: string },
  opts: { rejects?: { sampleId: string; reason: string }[] } = {},
): HandoverSheet {
  const sh = getHandoverSheet(db, id)
  if (!sh) throw new Error('交接单不存在')
  if (sh.status === 'confirmed') throw new Error('该交接单已签收，不能重复签收')
  if (sh.status === 'draft') throw new Error('交接单还是草稿，采样员发出后才能签收')
  const senders = (sh.from_person || '').split('、').filter(Boolean)
  if (senders.includes(actor.name)) throw new Error('交样人不能自己签收，须由质控员确认')
  const rejects = opts.rejects ?? []
  for (const rj of rejects) {
    if (!sh.sample_ids.includes(rj.sampleId)) throw new Error(`拒收的样品 ${rj.sampleId} 不在本交接单里`)
    if (!rj.reason?.trim()) throw new Error('拒收必须写原因')
  }
  const rejectedIds = new Set(rejects.map(r => r.sampleId))
  return inTx(db, () => {
    const at = now()
    // 未拒收成员：把该样品所有待确认的逐条交接一次性确认（沿用逐条闸的口径）
    for (const sid of sh.sample_ids.filter(s => !rejectedIds.has(s))) {
      db.prepare(`UPDATE sample_handovers SET confirmed_by=?, confirmed_at=? WHERE sample_id=? AND confirmed_at IS NULL`)
        .run(actor.name, at, sid)
    }
    // 拒收成员：样品打终态 + 流水留痕后整体关闭（不然永远挂在"待签收"清单里）。
    // 拦录入不再靠交接闸，靠 status='rejected'（saveRecord 拦）；补采走 resampleSample。
    for (const rj of rejects) {
      addHandover(db, rj.sampleId, { action: '拒收', fromPerson: sh.from_person ?? undefined, toPerson: actor.name, condition: '拒收', note: `交接单${id}拒收：${rj.reason}` }, actor)
      db.prepare(`UPDATE samples SET status='rejected' WHERE id=?`).run(rj.sampleId)
      db.prepare(`UPDATE sample_handovers SET confirmed_by=?, confirmed_at=? WHERE sample_id=? AND confirmed_at IS NULL`).run(actor.name, at, rj.sampleId)
    }
    const detail = sh.detail.map(d => rejectedIds.has(d.sampleId)
      ? { ...d, rejected: true, rejectReason: rejects.find(r => r.sampleId === d.sampleId)!.reason }
      : d)
    db.prepare(`UPDATE handover_sheets SET status='confirmed', to_person=?, to_at=?, detail=? WHERE id=?`)
      .run(actor.name, at, JSON.stringify(detail), id)
    logAction(db, id, actor as User, 'handover_sheet_confirm', { rejects })
    return getHandoverSheet(db, id)!
  })
}

// ============ 检测任务通知单 HJ-TC-137（批次一切片2）============
export type TestNotice = {
  id: string; sheet_id: string; round_id: string | null; contract_id: string | null
  category: string | null; nature: string | null; source: string | null; sample_desc: string | null
  groups: { sampleId: string; analytes: string[] }[]
  received_at: string | null; due_at: string | null; dept: string | null
  issuer: string | null; issuer_username: string | null
  status: 'draft' | 'issued'; issued_at: string | null; note: string | null; created_at: string
}
// 介质 → 通知单"任务类别"勾选项（样张 HJ-TC-137 的选项口径）
const NOTICE_CATEGORY: Record<string, string> = {
  废水: '污水', 地表水: '地表水', 地下水: '地下水', 生活饮用水: '生活饮用水',
  废气: '废气', 有组织废气: '废气', 无组织废气: '废气', 环境空气: '环境空气', 土壤: '土壤', 固废: '固废', 海水: '其他（海水）',
}
function parseNotice(r: any): TestNotice {
  const { groups_json, ...rest } = r
  return { ...rest, groups: JSON.parse(groups_json || '[]') }
}
export function getTestNotice(db: DB, id: string): TestNotice | null {
  const r = db.prepare(`SELECT * FROM test_notices WHERE id=?`).get(id) as any
  return r ? parseNotice(r) : null
}
export function listTestNotices(db: DB, f: { status?: string; roundId?: string } = {}): TestNotice[] {
  const where: string[] = [], args: any[] = []
  if (f.status) { where.push('status=?'); args.push(f.status) }
  if (f.roundId) { where.push('round_id=?'); args.push(f.roundId) }
  // 同 listHandoverSheets：列表带委托单位/项目名（通知单表没有 contract_id，经交接单转一道）
  const rows = db.prepare(`SELECT n.*, c.client AS client, c.project AS project FROM test_notices n
    LEFT JOIN handover_sheets h ON h.id = n.sheet_id
    LEFT JOIN contracts c ON c.id = h.contract_id
    ${where.length ? 'WHERE ' + where.map(w => 'n.' + w).join(' AND ') : ''} ORDER BY n.created_at DESC, n.id DESC`).all(...args) as any[]
  return rows.map(parseNotice)
}
// 从已签收的交接单一键生成（拒收样品不进单）；一张交接单只出一张通知单
export function createNoticeFromSheet(db: DB, sheetId: string, actor: { name: string; username?: string }, year = new Date().getFullYear()): TestNotice {
  const sh = getHandoverSheet(db, sheetId)
  if (!sh) throw new Error('交接单不存在')
  if (sh.status !== 'confirmed') throw new Error('交接单还没签收，签收后才能生成任务通知单')
  if (db.prepare(`SELECT 1 FROM test_notices WHERE sheet_id=?`).get(sheetId)) throw new Error('该交接单已生成过任务通知单')
  const rows = sh.detail.filter(d => !d.rejected)
  if (!rows.length) throw new Error('交接单里没有可检测的样品（全部被拒收）')
  const groups = rows.map(d => ({ sampleId: d.sampleId, analytes: d.items || [] }))
  // 任务类别按介质映射；样品份数/状态从明细汇总
  const samples = rows.map(d => getSample(db, d.sampleId)).filter(Boolean) as Sample[]
  const cats = [...new Set(samples.map(s => NOTICE_CATEGORY[s.matrix] || '其他'))]
  const conds = [...new Set(rows.map(d => d.condition || '完好'))]
  const id = nextSeqId(db, 'test_notices', `TZ${year}-`)
  db.prepare(`INSERT INTO test_notices (id, sheet_id, round_id, contract_id, category, sample_desc, groups_json, received_at, issuer, issuer_username, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?)`)
    .run(id, sheetId, sh.round_id, sh.contract_id, cats.join('、'), `${rows.length}份（${conds.join('、')}）`,
      JSON.stringify(groups), sh.to_at, actor.name, actor.username ?? null, now())
  logAction(db, id, actor as User, 'notice_create', { sheet: sheetId })
  return getTestNotice(db, id)!
}
export function updateTestNotice(
  db: DB, id: string,
  patch: { dueAt?: string; note?: string; nature?: string; source?: string; dept?: string; category?: string },
  actor: { name: string; username?: string },
): TestNotice {
  const n = getTestNotice(db, id)
  if (!n) throw new Error('任务通知单不存在')
  if (n.status !== 'draft') throw new Error('通知单已下达，不能再改')
  db.prepare(`UPDATE test_notices SET due_at=?, note=?, nature=?, source=?, dept=?, category=? WHERE id=?`)
    .run(patch.dueAt ?? n.due_at, patch.note ?? n.note, patch.nature ?? n.nature, patch.source ?? n.source, patch.dept ?? n.dept, patch.category ?? n.category, id)
  logAction(db, id, actor as User, 'notice_update', { patch: Object.keys(patch) })
  return getTestNotice(db, id)!
}
// 下达：状态 issued + 按样品×项目建"待认领"任务（assignee=''）。已有任务（含已派）不覆盖。
export function issueTestNotice(db: DB, id: string, actor: { name: string; username?: string }): TestNotice {
  const n = getTestNotice(db, id)
  if (!n) throw new Error('任务通知单不存在')
  if (n.status === 'issued') throw new Error('通知单已下达，不能重复下达')
  return inTx(db, () => {
    const at = now()
    for (const g of n.groups) for (const analyte of g.analytes) {
      db.prepare(`INSERT INTO test_tasks (sample_id, analyte, assignee, assignee_username, assigned_by, assigned_at)
        VALUES (?,?,'',NULL,?,?) ON CONFLICT(sample_id, analyte) DO NOTHING`)
        .run(g.sampleId, analyte, actor.name, at)
      // 完成时限随任务下发（检测员在认领池/我的任务里能看到轻重缓急）
      if (n.due_at) db.prepare(`UPDATE test_tasks SET due_at=? WHERE sample_id=? AND analyte=?`).run(n.due_at, g.sampleId, analyte)
    }
    db.prepare(`UPDATE test_notices SET status='issued', issued_at=? WHERE id=?`).run(at, id)
    logAction(db, id, actor as User, 'notice_issue', { groups: n.groups.length })
    return getTestNotice(db, id)!
  })
}
// 通知单撤回（质控专用）：下达后发现下错了（多勾项目/选错单）——只要还没人认领、没有记录，
// 就能整单撤回：删掉本次建的任务、通知单回草稿可改可再下达。有人认领了就走任务取消/打回线。
export function revokeTestNotice(db: DB, id: string, reason: string, actor: { name: string; username?: string }): TestNotice {
  if (!reason?.trim()) throw new Error('撤回必须写原因（记入留痕）')
  const n = getTestNotice(db, id)
  if (!n) throw new Error('任务通知单不存在')
  if (n.status !== 'issued') throw new Error('通知单还是草稿，直接修改即可，不用撤回')
  return inTx(db, () => {
    for (const g of n.groups) {
      const tasks = listTestTasks(db, { sampleId: g.sampleId }).filter(t => g.analytes.includes(t.analyte))
      for (const t of tasks) {
        if (t.assignee) throw new Error(`样品 ${g.sampleId} 的「${t.analyte}」已被 ${t.assignee} 认领，不能整单撤回——请改走任务取消或打回`)
        const rec = listRecords(db, { sampleId: g.sampleId }).find(r => r.analyte === t.analyte)
        if (rec) throw new Error(`样品 ${g.sampleId} 的「${t.analyte}」已有检测记录，不能撤回`)
      }
      for (const t of tasks) db.prepare(`DELETE FROM test_tasks WHERE id=?`).run((t as any).id)
    }
    db.prepare(`UPDATE test_notices SET status='draft', issued_at=NULL WHERE id=?`).run(id)
    logAction(db, id, actor as User, 'notice_revoke', { reason: reason.trim() })
    return getTestNotice(db, id)!
  })
}
// 全部记录定稿 → 样品落 done（原来 done 态永远达不到，统计里"待检样品"越攒越多）
function settleSampleDone(db: DB, sampleId: string) {
  const recs = listRecords(db, { sampleId })
  if (recs.length && recs.every(r => r.status === 'approved')) {
    db.prepare(`UPDATE samples SET status='done' WHERE id=? AND status NOT IN ('rejected')`).run(sampleId)
  } else {
    db.prepare(`UPDATE samples SET status='testing' WHERE id=? AND status='done'`).run(sampleId)   // 打回/撤销回退
  }
}
// 提交后本人撤回（发现录错不用等复核员打回）：submitted → draft，只限编制人本人
export function withdrawRecord(db: DB, recordId: string, actor: { name: string; username?: string }): RecordRow {
  const rec = getRecordById(db, recordId)
  if (!rec) throw new Error('记录不存在')
  if (rec.status !== 'submitted') throw new Error('只有「已提交待复核」的记录能撤回；复核开始后请走打回')
  const own = samePerson({ name: (rec as any).author, username: (rec as any).author_username }, { name: actor.name, username: actor.username })
  if (!own) throw new Error('只有编制人本人能撤回自己的提交')
  db.prepare(`UPDATE records SET status='draft' WHERE id=?`).run(recordId)
  writeAudit(db, recordId, actor.name, 'withdraw', {}, now(), actor.username ?? null)
  return getRecordById(db, recordId)!
}
// 认领错了本人退回认领池：没动手（无记录）才能退；退回后其他检测员可再认领
export function unclaimTask(db: DB, taskId: number, actor: { name: string; username?: string }): void {
  const t = db.prepare(`SELECT * FROM test_tasks WHERE id=?`).get(taskId) as TestTask | undefined
  if (!t) throw new Error('任务不存在')
  if (!t.assignee) throw new Error('该任务还没被认领')
  const own = samePerson({ name: t.assignee, username: (t as any).assignee_username }, { name: actor.name, username: actor.username })
  if (!own) throw new Error('只有认领人本人能退回；改派请找质控员')
  const rec = listRecords(db, { sampleId: t.sample_id }).find(r => r.analyte === t.analyte)
  if (rec) throw new Error('该项目已开始录入，不能退回——请走打回或找质控改派')
  db.prepare(`UPDATE test_tasks SET assignee='', assignee_username=NULL WHERE id=?`).run(taskId)
  logAction(db, t.sample_id, actor as User, 'task_unclaim', { analyte: t.analyte })
}
// 检测员认领待认领任务（拍板1：认领为主+质控可指派/改派）
export function claimTestTask(db: DB, taskId: number, actor: { name: string; username?: string }): TestTask & { record_status: string } {
  const t = db.prepare(`SELECT * FROM test_tasks WHERE id=?`).get(taskId) as TestTask | undefined
  if (!t) throw new Error('任务不存在')
  if (t.assignee) throw new Error(`该任务已被 ${t.assignee} 认领`)
  db.prepare(`UPDATE test_tasks SET assignee=?, assignee_username=?, assigned_at=? WHERE id=? AND assignee=''`)
    .run(actor.name, actor.username ?? null, now(), taskId)
  const after = db.prepare(`SELECT * FROM test_tasks WHERE id=?`).get(taskId) as TestTask
  if (after.assignee !== actor.name) throw new Error(`该任务已被 ${after.assignee} 认领`)
  logAction(db, t.sample_id, actor as User, 'task_claim', { task: taskId, analyte: t.analyte })
  return { ...after, record_status: 'none' }
}
// 保存条件按样品反查（交接单 storage）：检测员（含盲样视角）要知道 4℃冷藏/加酸这类要求才好干活；
// 保存条件不含单位/点位信息，不破盲。
export function sampleStorage(db: DB, sampleId: string): string | null {
  const row = db.prepare(`SELECT storage FROM handover_sheets WHERE sample_ids LIKE ? ORDER BY created_at DESC LIMIT 1`)
    .get(`%"${sampleId}"%`) as any
  return row?.storage ?? null
}
// 任务取消（质控专用）：通知单下错项目/样品量不足缺测的正路出口——原来任务一旦建了就删不掉，
// 会把整期报告永远卡在"已派任务但还没有检测记录"。有记录的项目不能取消（走打回/作废线）。
export function cancelTestTask(db: DB, taskId: number, reason: string, actor: { name: string; username?: string }): void {
  if (!reason?.trim()) throw new Error('取消任务必须写原因（缺测/派错等，会记入留痕）')
  const t = db.prepare(`SELECT * FROM test_tasks WHERE id=?`).get(taskId) as TestTask | undefined
  if (!t) throw new Error('任务不存在')
  const rec = listRecords(db, { sampleId: t.sample_id }).find(r => r.analyte === t.analyte)
  if (rec) throw new Error(`项目「${t.analyte}」已有检测记录（${rec.serial || rec.id}），不能取消任务；要作废数据请走打回/报告作废线`)
  db.prepare(`DELETE FROM test_tasks WHERE id=?`).run(taskId)
  logAction(db, t.sample_id, actor as User, 'task_cancel', { analyte: t.analyte, assignee: t.assignee || '（未认领）', reason: reason.trim() })
}
// 补采（采样员专用）：拒收样一键在原期次重建新样（继承点位/项目），生成新交接单草稿，
// 走 发出→签收→通知单 的正规链；旧样 replaced_by 指向新样，留痕闭环。
export function resampleSample(db: DB, sampleId: string, actor: { name: string; username?: string }, year = new Date().getFullYear()): { sample: Sample; sheet: HandoverSheet } {
  const orig = getSample(db, sampleId) as any
  if (!orig) throw new Error('样品不存在')
  if (orig.status !== 'rejected') throw new Error('只有被拒收的样品才需要补采')
  if (orig.replaced_by) throw new Error(`该样品已补采为 ${orig.replaced_by}，不要重复补采`)
  if (!orig.round_id) throw new Error('散样（无期次）被拒收请直接重新登记送样')
  const round = getRound(db, orig.round_id)
  if (!round) throw new Error('原期次不存在')
  assertContractNotTerminated(db, orig.contract_id, '补采')
  return inTx(db, () => {
    const ns = createSample(db, {
      client: orig.client, matrix: orig.matrix, items: orig.items, note: `补采，替代 ${sampleId}`,
      contractId: orig.contract_id, roundId: orig.round_id, pointName: orig.point_name || undefined, pointCode: orig.point_code || undefined,
      qcType: orig.qc_type || undefined,
    }, year)
    addHandover(db, ns.id, { action: '采样交接', fromPerson: actor.name, condition: '完好', note: `第${round.round_no}期补采（替代 ${sampleId}）` }, actor)
    const sheet = createHandoverSheetForRound(db, { id: round.id, contract_id: round.contract_id, sampler: actor.name }, [ns], year)
    db.prepare(`UPDATE samples SET replaced_by=? WHERE id=?`).run(ns.id, sampleId)
    logAction(db, sampleId, actor as User, 'sample_resample', { newSample: ns.id, sheet: sheet.id })
    return { sample: ns, sheet }
  })
}

// ============ 批次三：报告发放登记 / 留样处置 / 归档清单 ============
export function addReportDelivery(
  db: DB, reportId: string,
  input: { copies?: number; method?: string; receiver?: string; note?: string },
  actor: { name: string; username?: string },
) {
  const r = getReport(db, reportId)
  if (!r) throw new Error('报告不存在')
  // 已签发可发放；已作废可登记"收回"（错版报告收回销毁/收回改正本，评审查作废管理必问）
  if (r.status !== 'issued' && !r.voided) throw new Error('报告还没签发，不能发放登记')
  const info = db.prepare(`INSERT INTO report_deliveries (report_id, copies, method, receiver, deliverer, deliverer_username, at, note)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(reportId, input.copies ?? 1, input.method || '自取', input.receiver ?? null, actor.name, actor.username ?? null, now(), input.note ?? null)
  logAction(db, reportId, actor as User, 'report_deliver', { copies: input.copies ?? 1, method: input.method || '自取', receiver: input.receiver })
  return db.prepare(`SELECT * FROM report_deliveries WHERE id=?`).get(info.lastInsertRowid) as any
}
export function listReportDeliveries(db: DB, reportId: string) {
  return db.prepare(`SELECT * FROM report_deliveries WHERE report_id=? ORDER BY id DESC`).all(reportId) as any[]
}
export function getRetention(db: DB, sampleId: string) {
  return (db.prepare(`SELECT * FROM sample_retention WHERE sample_id=?`).get(sampleId) as any) || null
}
export function setRetention(db: DB, sampleId: string, input: { location: string; until?: string; note?: string }, actor: { name: string; username?: string }) {
  if (!getSample(db, sampleId)) throw new Error('样品不存在')
  if (!input.location?.trim()) throw new Error('留样位置必填')
  const cur = getRetention(db, sampleId)
  if (cur?.disposed_at) throw new Error('该样品留样已处置，不能再改')
  if (cur) db.prepare(`UPDATE sample_retention SET location=?, until_date=?, note=? WHERE sample_id=?`).run(input.location.trim(), input.until ?? cur.until_date, input.note ?? cur.note, sampleId)
  else db.prepare(`INSERT INTO sample_retention (sample_id, location, until_date, registered_by, registered_at, note) VALUES (?,?,?,?,?,?)`)
    .run(sampleId, input.location.trim(), input.until ?? null, actor.name, now(), input.note ?? null)
  logAction(db, sampleId, actor as User, 'retention_set', { location: input.location, until: input.until })
  return getRetention(db, sampleId)!
}
export function disposeRetention(db: DB, sampleId: string, input: { method: string; note?: string }, actor: { name: string; username?: string }) {
  const cur = getRetention(db, sampleId)
  if (!cur) throw new Error('该样品没有留样登记')
  if (cur.disposed_at) throw new Error('该样品留样已处置过，不能重复处置')
  if (!input.method?.trim()) throw new Error('处置方式必填')
  db.prepare(`UPDATE sample_retention SET disposed_at=?, disposed_by=?, dispose_method=?, note=COALESCE(?,note) WHERE sample_id=?`)
    .run(now(), actor.name, input.method.trim(), input.note ?? null, sampleId)
  logAction(db, sampleId, actor as User, 'retention_dispose', { method: input.method })
  return getRetention(db, sampleId)!
}
// 归档清单：照三个扫描包实证的装订顺序出索引（正文→方案→137→149→现场→交接→照片→记录）
export function archiveIndex(db: DB, reportId: string, actor?: User): { section: string; items: { type: string; id: string; label: string }[] }[] {
  const r = actor ? assertReportReadAccess(db, reportId, actor) : getReport(db, reportId)
  if (!r) throw httpError(404, '报告不存在', 'REPORT_NOT_FOUND')
  const roundId = (r as any).round_id as string | null
  const contractId = r.contract_id as string | null
  const scheme = contractId ? getScheme(db, contractId) : null
  const notices = roundId ? listTestNotices(db, { roundId }) : []
  const sheets = roundId ? listHandoverSheets(db, { roundId }) : []
  const rsheets = roundId ? (db.prepare(`SELECT template_code FROM round_sheets WHERE round_id=?`).all(roundId) as any[]) : []
  const atts = roundId ? (db.prepare(`SELECT id, orig_name FROM attachments WHERE entity_type='round' AND entity_id=? AND deleted_at IS NULL`).all(roundId) as any[]) : []
  const sampleIds: string[] = roundId
    ? (db.prepare(`SELECT id FROM samples WHERE round_id=?`).all(roundId) as any[]).map(x => x.id)
    : (r.sample_id ? [r.sample_id] : [])
  const recs: any[] = []
  for (const sid of sampleIds) for (const rec of listRecords(db, { sampleId: sid })) recs.push(rec)
  // 补环（2026-08-01）：合同评审是证据链第一环；质控/前处理/发放/留样评审现场都会被抽
  const qcs = roundId ? (db.prepare(`SELECT id, qc_type, analyte, verdict FROM qc_records WHERE round_id=?`).all(roundId) as any[]) : []
  const pres: any[] = []
  for (const sid of sampleIds) for (const pt of db.prepare(`SELECT id, method FROM pretreatments WHERE sample_id=?`).all(sid) as any[]) pres.push({ ...pt, sid })
  const dels = db.prepare(`SELECT id, method, copies, receiver, at FROM report_deliveries WHERE report_id=? ORDER BY id`).all(r.id) as any[]
  const rets: any[] = []
  for (const sid of sampleIds) { const rt = db.prepare(`SELECT sample_id, location, disposed_at FROM sample_retention WHERE sample_id=?`).get(sid) as any; if (rt) rets.push(rt) }
  return [
    { section: '报告正文', items: [{ type: 'report', id: r.id, label: r.title || r.id }] },
    { section: '委托合同及评审', items: contractId ? [{ type: 'contract', id: contractId, label: `委托合同 ${contractId}（含评审记录表）` }] : [] },
    { section: '监测方案', items: scheme ? [{ type: 'scheme', id: scheme.id, label: `监测方案 ${scheme.id}` }] : [] },
    { section: '检测任务通知单', items: notices.map(n => ({ type: 'notice', id: n.id, label: `HJ-TC-137 ${n.id}` })) },
    { section: '样品解密单', items: notices.map(n => ({ type: 'decode', id: n.id, label: `HJ-TC-149（随 ${n.id}）` })) },
    { section: '现场采样记录', items: rsheets.map(x => ({ type: 'round_sheet', id: x.template_code, label: x.template_code })) },
    { section: '样品交接单', items: sheets.map(s => ({ type: 'handover_sheet', id: s.id, label: s.id })) },
    { section: '现场照片及附件', items: atts.map(a => ({ type: 'attachment', id: String(a.id), label: a.orig_name })) },
    { section: '检测原始记录', items: recs.map(rc => ({ type: 'record', id: rc.id, label: `${rc.template_code} ${rc.serial || ''}（${rc.analyte || ''}）` })) },
    { section: '质控记录', items: qcs.map(q => ({ type: 'qc', id: String(q.id), label: `${q.qc_type} ${q.analyte || ''} · ${q.verdict || '未判定'}` })) },
    { section: '前处理记录', items: pres.map(pt => ({ type: 'pretreatment', id: String(pt.id), label: `${pt.sid} · ${pt.method}` })) },
    { section: '发放与收回登记', items: dels.map(d0 => ({ type: 'delivery', id: String(d0.id), label: `${d0.method || '发放'} ${d0.copies || 1}份 ${d0.receiver || ''} ${String(d0.at || '').slice(0, 10)}` })) },
    { section: '留样处置', items: rets.map(rt => ({ type: 'retention', id: rt.sample_id, label: `${rt.sample_id} · ${rt.location}${rt.disposed_at ? ' · 已处置' : ''}` })) },
  ]
}

// ============ 比对判定引擎（批次二·比对插槽，HJ 355 口径，规则照6份比对报告实证） ============
export type ComparePair = { time?: string; online: number; lab: number }
export type CompareGroup = { type: 'conc' | 'pH' | 'qc' | 'flow' | 'level'; analyte: string; pairs: ComparePair[]; stdValue?: number }
// 浓度类分档（按实验室均值取档）：[下限, 误差类型, 限值, 限值文案]
const CONC_BANDS: Record<string, [number, 'rel' | 'abs', number][]> = {
  COD: [[100, 'rel', 15], [60, 'rel', 20], [30, 'rel', 30], [0, 'abs', 5]],
  氨氮: [[2, 'rel', 15], [0, 'abs', 0.3]],
  总磷: [[0.4, 'rel', 15], [0, 'abs', 0.04]],
  总氮: [[2, 'rel', 15], [0, 'abs', 0.3]],
}
// n对取m对：3取2 / 4取3 / ≥5取4（HJ 355 原文规则）
function needPass(n: number): number { return n <= 3 ? 2 : n === 4 ? 3 : 4 }
export function judgeCompareGroup(g: CompareGroup): {
  errType: '绝对误差' | '相对误差'; errs: number[]; err: number; limitText: string
  perPass: boolean[]; pass: boolean; need: number
} {
  const rel = (p: ComparePair) => +(((p.online - p.lab) / p.lab) * 100).toFixed(2)
  const abs = (p: ComparePair) => +(p.online - p.lab).toFixed(3)
  if (g.type === 'pH') {
    const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1)
    const err = +(avg(g.pairs.map(p => p.online)) - avg(g.pairs.map(p => p.lab))).toFixed(2)
    return { errType: '绝对误差', errs: g.pairs.map(abs), err, limitText: 'pH绝对误差不超过±0.5', perPass: [Math.abs(err) <= 0.5], pass: Math.abs(err) <= 0.5, need: 1 }
  }
  if (g.type === 'flow') {
    const err = Math.abs(rel(g.pairs[0]))
    return { errType: '相对误差', errs: g.pairs.map(rel), err, limitText: '10分钟累计流量比对误差±10%', perPass: [err <= 10], pass: err <= 10, need: 1 }
  }
  if (g.type === 'level') {
    const errs = g.pairs.map(abs)
    const err = +Math.max(...errs.map(Math.abs)).toFixed(2)
    return { errType: '绝对误差', errs, err, limitText: '液位比对误差12mm', perPass: [err <= 12], pass: err <= 12, need: 1 }
  }
  if (g.type === 'qc') {
    const base = g.stdValue ?? g.pairs[0].lab
    const err = +(((g.pairs[0].online - base) / base) * 100).toFixed(2)
    return { errType: '相对误差', errs: [err], err, limitText: '质控样相对误差≤±10%', perPass: [Math.abs(err) <= 10], pass: Math.abs(err) <= 10, need: 1 }
  }
  // conc：按实验室均值取档
  const labAvg = g.pairs.reduce((s, p) => s + p.lab, 0) / (g.pairs.length || 1)
  const bands = CONC_BANDS[g.analyte] || [[0, 'rel', 15] as [number, 'rel' | 'abs', number]]
  const band = bands.find(b => labAvg >= b[0]) || bands[bands.length - 1]
  const [, kind, lim] = band
  const errs = g.pairs.map(kind === 'rel' ? rel : abs)
  const perPass = errs.map(e => Math.abs(e) <= lim)
  const need = needPass(g.pairs.length)
  const okCount = perPass.filter(Boolean).length
  return {
    errType: kind === 'rel' ? '相对误差' : '绝对误差', errs,
    err: +Math.max(...errs.map(Math.abs)).toFixed(2),
    limitText: kind === 'rel' ? `${g.analyte}相对误差不超过±${lim}%` : `${g.analyte}绝对误差不超过±${lim}mg/L`,
    perPass, pass: okCount >= need, need,
  }
}

// ============ 真盲（拍板2）：纯检测员看不到样品对应的受检单位与点位，只见编号 ============
// 盲的对象是"编号↔点位/单位"的映射，不是编号本身（编号已按盲样新规不含点位段）。
// 兼 qc/采样/登记/管理/tech/签字岗的不盲（各自业务需要真实信息）；检测员兼复核/审核仍盲（核数不需点位）。
const BLIND_EXEMPT_ROLES = ['admin', 'tech', 'qc', 'registrar', 'sampler', 'signer']
export function isBlindViewer(u: { roles?: string[] } | null | undefined): boolean {
  const roles = u?.roles || []
  return roles.includes('tester') && !roles.some(r => BLIND_EXEMPT_ROLES.includes(r))
}
export function maskSampleForUser<T extends Partial<Sample>>(u: { roles?: string[] } | null | undefined, s: T): T {
  if (!isBlindViewer(u)) return s
  // 委托号/期次号也要脱：工作台项目列表能按委托号反查单位名，留着等于没盲
  return { ...s, client: '', point_name: null, point_code: null, contract_id: null, round_id: null }
}
// 交接单/通知单列表同口径脱敏：这两个接口登录即可拉，纯检测员不能借它反查 编号↔单位/委托 映射
export function maskSheetForUser<T extends { client?: any; project?: any; contract_id?: any; round_id?: any }>(u: { roles?: string[] } | null | undefined, x: T): T {
  if (!isBlindViewer(u)) return x
  return { ...x, client: '', project: null, contract_id: null, round_id: null }
}
// 解密单 HJ-TC-149：样号↔点位↔受检单位对照（质控员专管，出报告时反查）
export function decodeNotice(db: DB, noticeId: string): { sampleId: string; pointName: string | null; client: string; matrix: string; qcType: string | null }[] {
  const n = getTestNotice(db, noticeId)
  if (!n) throw new Error('任务通知单不存在')
  return n.groups.map(g => {
    const s = getSample(db, g.sampleId)
    return { sampleId: g.sampleId, pointName: s?.point_name ?? null, client: s?.client ?? '', matrix: s?.matrix ?? '', qcType: s?.qc_type ?? null }
  })
}

// ============ 记录附件（照片/小票，选传不强制） ============
// 通用附件：任意记录类型都能挂。合规语义——只增、软删留痕、记录定稿后冻结。
export type AttachEntityType = 'record' | 'handover' | 'pretreatment' | 'qc' | 'system_record' | 'round' | 'round_sheet' | 'report' | 'delivery'
const ATTACH_TARGET: Record<AttachEntityType, { table: string; idCol: string }> = {
  record:        { table: 'records',          idCol: 'id' },
  handover:      { table: 'sample_handovers', idCol: 'id' },
  pretreatment:  { table: 'pretreatments',    idCol: 'id' },
  qc:            { table: 'qc_records',        idCol: 'id' },
  system_record: { table: 'system_records',   idCol: 'id' },
  round:         { table: 'rounds',           idCol: 'id' },   // 期次：现场照片/交接单扫描件，采样员在派工页传
  round_sheet:   { table: 'rounds',           idCol: 'id' },   // 期次+表号的合成目标：每张采样单独立挂照片
  report:        { table: 'reports',          idCol: 'id' },   // 报告：盖章扫描件等，签发后冻结
  delivery:      { table: 'report_deliveries', idCol: 'id' },   // 发放/收回登记：客户签收回执照片（签发后照传）
}
export const ATTACH_ENTITY_TYPES = Object.keys(ATTACH_TARGET) as AttachEntityType[]

// 按实体的附件角色白名单（体检17）：attach_upload 的大名单对报告/体系记录太宽——
// 采样员没理由动报告附件，体系记录只有技术负责人管；而签字人传报告盖章扫描件是正当需求。
// 不改 PERM 矩阵（前后端镜像被测试钉住），在这里做实体级第二道闸。
const ATTACH_ENTITY_ROLES: Partial<Record<AttachEntityType, { roles: string[]; label: string }>> = {
  round_sheet:   { roles: ['sampler', 'tech'], label: '采样单附件需要 采样员/技术负责人 权限' },
  report:        { roles: ['registrar', 'reviewer', 'approver', 'signer', 'tech'], label: '报告附件需要 登记员/复核员/审核员/授权签字人/技术负责人 权限' },
  system_record: { roles: ['tech'], label: '体系记录附件需要 技术负责人 权限' },
  delivery:      { roles: ['registrar', 'signer', 'qc', 'tech'], label: '发放回执需要 登记员/授权签字人/质控员/技术负责人 权限' },
}
// 某人能否增删某类实体的附件：特殊实体按白名单，其余维持 attach_upload 现状
export function canManageAttachment(user: User | null, entityType: string): boolean {
  const special = ATTACH_ENTITY_ROLES[entityType as AttachEntityType]
  if (special) return hasRole(user, ...special.roles)
  return hasRole(user, ...PERM.attach_upload)
}
export function attachRoleErrorText(entityType: string): string {
  return ATTACH_ENTITY_ROLES[entityType as AttachEntityType]?.label ?? '此操作需要采样/检测/质控/技术/登记权限'
}
export type Attachment = {
  id: string; entity_type: string; entity_id: string
  orig_name: string; stored_name: string; mime: string | null; size: number | null
  who: string; username: string | null; at: string
  deleted_at: string | null; deleted_by: string | null
}

// 校验目标记录存在；不存在则抛错
function assertAttachTarget(db: DB, entityType: AttachEntityType, entityId: string) {
  const t = ATTACH_TARGET[entityType]
  const targetId = entityType === 'round_sheet' ? roundSheetTarget(entityId).roundId : entityId
  const row = db.prepare(`SELECT 1 FROM ${t.table} WHERE ${t.idCol}=?`).get(targetId)
  if (!row) throw new Error('目标记录不存在')
}
function roundSheetTarget(entityId: string) {
  const marker = entityId.lastIndexOf('::')
  const roundId = marker > 0 ? entityId.slice(0, marker) : ''
  const code = marker > 0 ? entityId.slice(marker + 2) : ''
  if (!roundId || !code) throw new Error('采样单附件目标格式错误')
  return { roundId, code }
}
function attachmentRoundId(entityType: string, entityId: string) {
  return entityType === 'round_sheet' ? roundSheetTarget(entityId).roundId : entityId
}
// 定稿即冻结（泛化到全部有终态的实体）：定稿/签收/签发之后附件不能再增删——现场证据链不许事后换照片
function attachTargetFrozen(db: DB, entityType: AttachEntityType, entityId: string): boolean {
  if (entityType === 'record') {
    const r = db.prepare(`SELECT status FROM records WHERE id=?`).get(entityId) as any
    return r?.status === 'approved'
  }
  if (entityType === 'handover') {
    const h = db.prepare(`SELECT confirmed_at FROM sample_handovers WHERE id=?`).get(entityId) as any
    return !!h?.confirmed_at
  }
  if (entityType === 'report') {
    const r = db.prepare(`SELECT status, voided FROM reports WHERE id=?`).get(entityId) as any
    return r?.status === 'issued' || !!r?.voided
  }
  if (entityType === 'round' || entityType === 'round_sheet') {
    // 期次出了（未作废的）签发报告后，现场照片冻结
    const rep = db.prepare(`SELECT 1 FROM reports WHERE round_id=? AND status='issued' AND voided=0 LIMIT 1`).get(attachmentRoundId(entityType, entityId))
    return !!rep
  }
  return false
}

export function addAttachment(
  db: DB,
  input: { entityType: AttachEntityType; entityId: string; origName: string; storedName: string; mime?: string; size?: number },
  actor: { name: string; username?: string; roles?: string[] },
): Attachment {
  if (!ATTACH_ENTITY_TYPES.includes(input.entityType)) throw new Error('不支持的记录类型')
  if (!input.origName || !input.storedName) throw new Error('文件名必填')
  assertAttachTarget(db, input.entityType, input.entityId)
  if ((input.entityType === 'round' || input.entityType === 'round_sheet') && actor.roles) assertRoundAccess(db, attachmentRoundId(input.entityType, input.entityId), actor as User)
  if (attachTargetFrozen(db, input.entityType, input.entityId)) throw new Error('记录已定稿，附件已冻结，不能再增删')
  const id = randomUUID()
  const at = now()
  db.prepare(`INSERT INTO attachments (id, entity_type, entity_id, orig_name, stored_name, mime, size, who, username, at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.entityType, input.entityId, input.origName, input.storedName,
      input.mime ?? null, input.size ?? null, actor.name, actor.username ?? null, at)
  logAction(db, input.entityId, { name: actor.name, username: actor.username } as User, 'attach_add',
    { attachment_id: id, entity_type: input.entityType, name: input.origName })
  return getAttachment(db, id)!
}

// 列出某记录的有效（未软删）附件，按上传时间正序
export function listAttachments(db: DB, entityType: string, entityId: string, actor?: User): Attachment[] {
  if ((entityType === 'round' || entityType === 'round_sheet') && actor) assertRoundAccess(db, attachmentRoundId(entityType, entityId), actor)
  // 按 rowid（插入顺序）排，稳定；不能按 at 排——同毫秒上传的 at 会打平，而 id 是随机 uuid
  return db.prepare(
    `SELECT * FROM attachments WHERE entity_type=? AND entity_id=? AND deleted_at IS NULL ORDER BY rowid`
  ).all(entityType, entityId) as Attachment[]
}

// 取单个有效附件（下载用）；已软删返回 null
export function getAttachment(db: DB, id: string, actor?: User): Attachment | null {
  const attachment = (db.prepare(`SELECT * FROM attachments WHERE id=? AND deleted_at IS NULL`).get(id) as Attachment) ?? null
  if (attachment && (attachment.entity_type === 'round' || attachment.entity_type === 'round_sheet') && actor) assertRoundAccess(db, attachmentRoundId(attachment.entity_type, attachment.entity_id), actor)
  return attachment
}

// 软删：标记 deleted_at + 写留痕，文件不物理删；定稿记录禁止删
// 归属校验：只能删自己传的；supervisor（tech/admin）可删任何人的
export function deleteAttachment(db: DB, id: string, actor: { name: string; username?: string; roles?: string[] }, supervisor = false) {
  const a = getAttachment(db, id)
  if (!a) throw new Error('附件不存在或已删除')
  if ((a.entity_type === 'round' || a.entity_type === 'round_sheet') && actor.roles) assertRoundAccess(db, attachmentRoundId(a.entity_type, a.entity_id), actor as User)
  if (attachTargetFrozen(db, a.entity_type as AttachEntityType, a.entity_id)) {
    throw new Error('记录已定稿，附件已冻结，不能再增删')
  }
  if (!supervisor && a.username && actor.username && a.username !== actor.username) {
    throw new Error(`该附件由「${a.who}」上传，只能本人或技术负责人删除`)
  }
  db.prepare(`UPDATE attachments SET deleted_at=?, deleted_by=? WHERE id=?`).run(now(), actor.username ?? null, id)
  logAction(db, a.entity_id, { name: actor.name, username: actor.username } as User, 'attach_delete',
    { attachment_id: id, entity_type: a.entity_type, name: a.orig_name })
}

export function listSamples(db: DB, status?: string): Sample[] {
  const rows = status
    ? db.prepare(`SELECT * FROM samples WHERE status = ? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM samples ORDER BY created_at DESC`).all()
  return (rows as any[]).map(r => ({ ...r, items: safeJson(r.items, []) }))
}

export function getRecord(db: DB, sampleId: string, code: string): RecordRow | null {
  const r = db.prepare(
    `SELECT * FROM records WHERE sample_id = ? AND template_code = ?`
  ).get(sampleId, code) as any
  if (!r) return null
  return { ...r, data: safeJson(r.data, {}) }
}

export function getRecordById(db: DB, id: string): RecordRow | null {
  const r = db.prepare(`SELECT * FROM records WHERE id = ?`).get(id) as any
  if (!r) return null
  return { ...r, data: safeJson(r.data, {}) }
}

// 保存记录：不存在则新建(create)，存在则更新(update)，并写留痕（含字段级 diff）
export function saveRecord(
  db: DB,
  input: {
    sampleId: string; code: string; name?: string; sheetType?: string
    method?: string; analyte?: string; matrix?: string; instrumentId?: string
    data: any; who?: string; whoUsername?: string; submit?: boolean
    baseUpdatedAt?: string   // 乐观锁：客户端打开时的 updated_at，不一致=有人先存过，拒绝覆盖
  },
  // 路由层必传：主流程两道闸（交接签收 + 任务归属）。supervisor（tech/admin）兜底放行。
  guard?: { supervisor: boolean },
): RecordRow {
  const who = input.who || '（未署名）'   // 路由层必传真实登录人；兜底绝不能写死某个人名（留痕造假）
  const at = now()
  // 拒收终态：任何人（含监督放行）都不能给拒收样录数据——正路是补采（resampleSample）
  const s0 = getSample(db, input.sampleId) as any
  if (s0?.status === 'rejected') {
    throw new Error(`样品 ${input.sampleId} 已被拒收${s0.replaced_by ? `（已补采为 ${s0.replaced_by}）` : '，请采样员补采'}，不能录入数据`)
  }
  // 终止合同冻结检测线：原来只在出报告一步才拦，白做一整段定稿记录
  if (s0?.contract_id) assertContractNotTerminated(db, s0.contract_id, '录入检测数据')
  if (guard && !guard.supervisor) {
    const s = getSample(db, input.sampleId)
    if (!s) throw new Error('样品不存在')
    requireHandoverConfirmed(db, s)   // 闸1：没签收不能录（决策13）
    // 闸2：任务归属——派了活只有本人能录；期次样品必须先派活（PRD 步骤5→6，「仅本人任务🔒」）
    const tasks = listTestTasks(db, { sampleId: input.sampleId })
    if (tasks.length) {
      // 归属比对优先登录名（重名不互串、改名不绕过）；任一方缺 username（历史派工）回退姓名
      const mine = tasks.filter(t => samePerson({ name: t.assignee, username: t.assignee_username }, { name: who, username: input.whoUsername }))
      if (!mine.length) throw new Error('该样品的检测任务没有派给你；如有疑问请质控员调整派工')
      if (input.analyte && !mine.some(t => t.analyte === input.analyte) && tasks.some(t => t.analyte === input.analyte)) {
        throw new Error(`项目「${input.analyte}」派给了别人，你不能录这一项`)
      }
    } else if (s.round_id || s.contract_id) {
      // 委托线样品（含单次合同的散样路径）一律先派任务再录——原来单次合同样品能跳过任务闸
      throw new Error('质控员还没给这个样品派检测任务，暂不能录入——请先在样品页派任务')
    }
  }
  const existing = getRecord(db, input.sampleId, input.code)
  // 定稿保护：已提交/已复核/已审核的记录不能被静默改写——必须先「打回」再改，
  // 杜绝提交前打开的旧标签页在复核期间继续改数据
  if (existing && ['submitted', 'reviewed', 'approved'].includes(existing.status)) {
    const label = existing.status === 'approved' ? '审核定稿' : existing.status === 'reviewed' ? '复核' : '提交待复核'
    throw new Error(`记录已${label}，不能直接修改；如需更正请先由复核/审核人「打回」`)
  }
  // 仪器必须在台账里（追溯链不能挂空编号）；检定过期只警告不拦（决策10，前端提示）
  let instrumentWarning = ''
  if (input.instrumentId) {
    const inst = db.prepare(`SELECT id, name, cert_until FROM instruments WHERE id=?`).get(input.instrumentId) as any
    if (!inst) throw new Error(`仪器「${input.instrumentId}」不在台账里——先到资源台账登记，或检查是否选错`)
    if (inst.cert_until && inst.cert_until < todayLocal()) {
      instrumentWarning = `仪器 ${inst.id} ${inst.name || ''} 检定/校准已于 ${inst.cert_until} 过期，请尽快送检（本条记录已保存）`
    }
  }
  // 日期交叉校验（警告不拦，同仪器过期先例）：表内填的检测/分析日期早于采样或交接时间=穿帮
  let dateWarning = ''
  {
    const meta = (input.data as any)?.meta || {}
    const key = Object.keys(meta).find(k => /检测日期|分析日期|^date$/i.test(k) && /^\d{4}-\d{2}-\d{2}/.test(String(meta[k] ?? '')))
    if (key && s0) {
      const d = String(meta[key]).slice(0, 10)
      const sampled = s0.round_id ? ((db.prepare(`SELECT sampled_at FROM rounds WHERE id=?`).get(s0.round_id) as any)?.sampled_at || '') : ''
      const handAt = ((db.prepare(`SELECT MIN(at) a FROM sample_handovers WHERE sample_id=?`).get(input.sampleId) as any)?.a || '')
      const baseline = String(sampled || handAt).slice(0, 10)
      if (baseline && d < baseline) dateWarning = `表内「${key}」${d} 早于样品${sampled ? '采样' : '交接'}时间 ${baseline}——日期穿帮，请核对（本条记录已保存）`
    }
  }
  // 标液/试剂批号挂记录（meta.refMaterials=[台账编号]）：过期批号警告不拦（同仪器先例）
  let refWarning = ''
  {
    const ids: string[] = Array.isArray((input.data as any)?.meta?.refMaterials) ? (input.data as any).meta.refMaterials : []
    const expired: string[] = []
    for (const rid of ids) {
      const rm = db.prepare(`SELECT id, name, expiry FROM ref_materials WHERE id=?`).get(rid) as any
      const rg = rm ? null : db.prepare(`SELECT id, name, expiry FROM reagents WHERE id=?`).get(rid) as any
      const hit = rm || rg
      if (hit?.expiry && hit.expiry < todayLocal()) expired.push(`${hit.id} ${hit.name || ''}（${hit.expiry} 过期）`)
    }
    if (expired.length) refWarning = `所选标物/试剂已过期：${expired.join('、')}——请核实是否误选（本条记录已保存）`
  }
  const warn = (rec: any) => {
    if (!instrumentWarning && !dateWarning && !refWarning) return rec
    return { ...rec, ...(instrumentWarning ? { instrument_warning: instrumentWarning } : {}), ...(dateWarning ? { date_warning: dateWarning } : {}), ...(refWarning ? { ref_warning: refWarning } : {}) }
  }
  // 乐观锁：两人（或两个标签页）同开一张表，后保存的不许无声覆盖先保存的
  if (existing && input.baseUpdatedAt !== undefined && existing.updated_at !== input.baseUpdatedAt) {
    const by = (existing as any).author || '他人'
    throw new Error(`这张表在你打开后已被「${by}」保存过（${existing.updated_at.slice(0, 16).replace('T', ' ')}），为防覆盖已阻止本次保存。请另存你改的数据（截图/抄录），刷新拿到最新内容后再补录`)
  }
  const status = input.submit ? 'submitted' : (existing?.status === 'submitted' ? 'submitted' : 'draft')

  if (!existing) {
    const id = randomUUID()
    const serial = nextRecordSerial(db, new Date(at).getFullYear())   // 人可读连号 JL2026-0001
    db.prepare(
      `INSERT INTO records (id, serial, sample_id, template_code, template_name, sheet_type,
         method, analyte, matrix, instrument_id, data, status, author, author_username, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, serial, input.sampleId, input.code, input.name ?? '', input.sheetType ?? '',
      input.method ?? '', input.analyte ?? '', input.matrix ?? '', input.instrumentId ?? null,
      JSON.stringify(input.data), status, who, input.whoUsername ?? null, at)
    writeAudit(db, id, who, 'create', { rows: (input.data?.rows ?? []).length }, at, input.whoUsername ?? null)
    // 有记录开始录入 → 样品进入「检测中」
    db.prepare(`UPDATE samples SET status='testing' WHERE id=? AND status='pending'`).run(input.sampleId)
    if (dateWarning) writeAudit(db, id, who, 'date_warning', { msg: dateWarning }, at, input.whoUsername ?? null)
    const made = getRecordById(db, id)!
    return warn(made)
  }

  const changes = diffData(existing.data, input.data)
  // 打回原因清理（体检36）：被打回的记录重新编辑保存那一刻，旧打回原因就完成了使命——
  // 留着会让下一轮复核误以为还是上一轮的问题。只在这一刻清（复核台展示 rejected 状态时原因仍在）。
  const rejectReason = existing.status === 'rejected' ? '' : existing.reject_reason
  // 编制人跟随最后编辑者：谁最后改的数据谁署名负责（同人校验以此为准）
  db.prepare(
    `UPDATE records SET data=?, status=?, reject_reason=?, template_name=COALESCE(NULLIF(?,''),template_name),
       method=COALESCE(NULLIF(?,''),method), analyte=COALESCE(NULLIF(?,''),analyte),
       instrument_id=COALESCE(NULLIF(?,''),instrument_id),
       author=?, author_username=?, updated_at=? WHERE id=?`
  ).run(JSON.stringify(input.data), status, rejectReason, input.name ?? '', input.method ?? '',
    input.analyte ?? '', input.instrumentId ?? '', who, input.whoUsername ?? null, at, existing.id)
  if (input.submit && existing.status !== 'submitted') {
    writeAudit(db, existing.id, who, 'submit', { changes }, at, input.whoUsername ?? null)
  } else {
    writeAudit(db, existing.id, who, 'update', { changes }, at, input.whoUsername ?? null)
  }
  if (dateWarning) writeAudit(db, existing.id, who, 'date_warning', { msg: dateWarning }, at, input.whoUsername ?? null)
  const saved = getRecordById(db, existing.id)!
  return warn(saved)
}

// PRD 步骤6 跨合同同表：检测员在同一张表里给多个样品（可跨合同）录数据，
// 系统按样品编号逐个落成各自的记录（自动归到样品所属合同）。整批一个事务。
// 体检13：不再整体换成 1 行——已有记录时按「行内检测项目名」合并，只更新/追加本次批量涉及的
// 项目行，其余项目的行原样保留；记录状态守门沿用 saveRecord（非 draft/rejected 一律拒改）。
export function saveRecordsBatch(
  db: DB,
  input: {
    code: string; name?: string; sheetType?: string; method?: string; analyte?: string; matrix?: string
    instrumentId?: string; sharedMeta?: Record<string, any>; reg?: Record<string, any>
    entries: { sampleId: string; row: Record<string, any>; resultSummary?: any }[]
    who?: string; whoUsername?: string; submit?: boolean
  },
  guard?: { supervisor: boolean },
): RecordRow[] {
  if (!input.entries?.length) throw new Error('至少要有一行样品数据')
  const ids = new Set(input.entries.map(e => e.sampleId))
  if (ids.size !== input.entries.length) throw new Error('同一张批量表里一个样品只能占一行')
  const analyte = String(input.analyte ?? '')
  return inTx(db, () => input.entries.map(e => {
    const existing = getRecord(db, e.sampleId, input.code)
    const newRow = { ...e.row, analyte }          // 行打上项目名标签：下次批量才认得出哪行是谁的
    let rows: any[] = [newRow]
    let keptTags: string[] = []
    if (existing) {
      const oldRows: any[] = Array.isArray(existing.data?.rows) ? existing.data.rows : []
      let replaced = false
      rows = oldRows.map(r => {
        // 老行没标签（改造前存的）：按记录级项目名兜底判断归属
        const tag = String(r?.analyte ?? existing.analyte ?? '')
        if (!replaced && tag === analyte) { replaced = true; return newRow }
        return r
      })
      if (!replaced) rows.push(newRow)
      keptTags = [...new Set(rows.filter(r => r !== newRow)
        .map(r => String(r?.analyte ?? existing.analyte ?? '')).filter(Boolean))]
    }
    const base = existing?.data ?? {}
    const rec = saveRecord(db, {
      sampleId: e.sampleId, code: input.code, name: input.name, sheetType: input.sheetType,
      method: input.method, analyte: input.analyte, matrix: input.matrix, instrumentId: input.instrumentId,
      data: {
        ...base,                                   // 其余键（cells/老 reg 等）原样带着走
        rows, meta: { ...(base.meta ?? {}), ...(input.sharedMeta ?? {}), batchEntry: true },
        ...(input.reg ? { reg: input.reg } : {}),
        resultSummary: e.resultSummary ?? base.resultSummary ?? null,
      },
      who: input.who, whoUsername: input.whoUsername, submit: input.submit,
    }, guard)
    // 留痕记这次合并动了哪行、保留了哪些项目的行（saveRecord 里另有逐格 diff）
    if (existing && keptTags.length) {
      writeAudit(db, rec.id, input.who || '（未署名）', 'batch_merge',
        { updated: analyte || '（未填项目）', kept: keptTags }, now(), input.whoUsername ?? null)
    }
    return rec
  }))
}

// 超标复检：标记「需复检」+记原因（可取消）。标记同时把原始结果整体固化进留痕
// （audit_log 只增不改），此后打回重测怎么改，最初的超标数据链都可查——决策16「原记录保留」。
export function flagRecheck(
  db: DB, recordId: string, reason: string, flag = true, who = '',
  // 体检19：检测员只能标自己名下的记录（编制人或任务受派人，登录名优先）；
  // reviewer/approver/tech/admin 由路由层传 restrictToOwn=false 不受限
  opts: { username?: string | null; restrictToOwn?: boolean } = {},
): RecordRow {
  const rec = getRecordById(db, recordId)
  if (!rec) throw new Error('记录不存在')
  if (opts.restrictToOwn) {
    const me = { name: who, username: opts.username ?? null }
    const isAuthor = samePerson({ name: (rec as any).author, username: (rec as any).author_username }, me)
    const isAssignee = listTestTasks(db, { sampleId: rec.sample_id })
      .some(t => t.analyte === rec.analyte && samePerson({ name: t.assignee, username: t.assignee_username }, me))
    if (!isAuthor && !isAssignee) {
      throw httpError(403, '检测员只能给自己名下的记录标复检（记录编制人或任务受派人）；别人的记录请找复核/审核员或技术负责人')
    }
  }
  if (flag && !reason?.trim()) throw new Error('复检原因必填')
  db.prepare(`UPDATE records SET recheck=?, recheck_reason=?, updated_at=? WHERE id=?`)
    .run(flag ? 1 : 0, flag ? reason.trim() : null, now(), recordId)
  if (flag) {
    writeAudit(db, recordId, who || '（未署名）', 'recheck_snapshot',
      { reason: reason.trim(), rows: rec.data?.rows ?? [], resultSummary: rec.data?.resultSummary ?? null }, now())
  }
  return getRecordById(db, recordId)!
}

// —— 列出记录（审核台/报告用）——
export function listRecords(db: DB, filter: { status?: string; sampleId?: string; instrumentId?: string } = {}): RecordRow[] {
  const where: string[] = [], args: any[] = []
  if (filter.status) { where.push('status = ?'); args.push(filter.status) }
  if (filter.sampleId) { where.push('sample_id = ?'); args.push(filter.sampleId) }
  if (filter.instrumentId) { where.push('instrument_id = ?'); args.push(filter.instrumentId) }   // 期间核查不合格按仪器追溯
  // 带出所属合同/单位：三级审核队列按合同分组用（路由层对盲用户走 maskSheetForUser 脱敏）
  const sql = `SELECT r.*, s.contract_id AS contract_id, s.client AS client FROM records r
    LEFT JOIN samples s ON s.id = r.sample_id
    ${where.length ? 'WHERE ' + where.map(w => 'r.' + w).join(' AND ') : ''} ORDER BY r.updated_at DESC`
  return (db.prepare(sql).all(...args) as any[]).map(r => ({ ...r, data: safeJson(r.data, {}) }))
}

// —— 三级审核：检验(提交) → 复核 → 审核 ——
const REVIEW_FLOW: Record<string, { from: string; to: string; action: string }> = {
  review_pass:   { from: 'submitted', to: 'reviewed', action: 'review_pass' },
  review_reject: { from: 'submitted', to: 'rejected', action: 'review_reject' },
  approve:       { from: 'reviewed',  to: 'approved', action: 'approve' },
  reject:        { from: 'reviewed',  to: 'rejected', action: 'reject' },
}
export function reviewRecord(
  db: DB, recordId: string,
  op: 'review_pass' | 'review_reject' | 'approve' | 'reject' | 'revoke',
  who: string, comment = '', whoUsername: string | null = null,
): RecordRow {
  {
    const _rec = getRecordById(db, recordId)
    if (_rec && op === 'approve' && (_rec as any).recheck === 1) {
      throw new Error(`该记录已标「需复检」（${(_rec as any).recheck_reason || ''}）——复检完成请先取消复检标记，或打回重录后再定稿`)
    }
  }
  const rec = getRecordById(db, recordId)
  if (!rec) throw new Error('记录不存在')
  // —— 定稿打回通道（revoke）：审核定稿后发现问题，审核人给原因打回重改（approved → rejected）——
  if (op === 'revoke') {
    if (rec.status !== 'approved') throw new Error(`只有「审核定稿」的记录才能打回（当前状态「${rec.status}」）`)
    if (!comment?.trim()) throw new Error('打回原因必填')
    // 该样品的数据已进入未作废的已签发报告 → 对外文件在先，先作废报告才能动记录
    const inIssued = listReports(db).some(rp => rp.status === 'issued' && !rp.voided &&
      (rp.sample_id === rec.sample_id || (rp.data?.results ?? []).some((x: any) => x.sampleId === rec.sample_id)))
    if (inIssued) throw new Error('该记录已进入已签发报告，请先作废报告再打回')
    const rat = now()
    db.prepare(`UPDATE records SET status='rejected', reject_reason=?, updated_at=? WHERE id=?`).run(comment.trim(), rat, recordId)
    writeAudit(db, recordId, who, 'record_revoke', { comment: comment.trim() }, rat, whoUsername)
    return getRecordById(db, recordId)!
  }
  const flow = REVIEW_FLOW[op]
  if (!flow) throw new Error('未知审核动作')
  if (rec.status !== flow.from) throw new Error(`当前状态「${rec.status}」不能执行此操作`)
  // 合规红线：编制、复核、审核不可同一人（admin 也不例外）。老数据没有编制人则不拦（增量收紧）。
  // 比对优先登录名（重名不误拦、改名不绕过），历史数据缺登录名回退姓名。
  const author = (rec as any).author as string | null
  const authorU = (rec as any).author_username as string | null
  if ((author || authorU) && samePerson({ name: author, username: authorU }, { name: who, username: whoUsername })) {
    throw new Error(`三级审核要求复核/审核人不能是记录编制人本人（${author || authorU}）`)
  }
  if ((op === 'approve' || op === 'reject') && rec.reviewer &&
      samePerson({ name: rec.reviewer, username: (rec as any).reviewer_username }, { name: who, username: whoUsername })) {
    throw new Error(`终审人不能与复核人（${rec.reviewer}）同一人`)
  }
  const at = now()
  if (op === 'review_pass') db.prepare(`UPDATE records SET status='reviewed', reviewer=?, reviewer_username=?, reviewed_at=?, reject_reason='', updated_at=? WHERE id=?`).run(who, whoUsername, at, at, recordId)
  else if (op === 'approve') db.prepare(`UPDATE records SET status='approved', approver=?, approved_at=?, reject_reason='', updated_at=? WHERE id=?`).run(who, at, at, recordId)
  else db.prepare(`UPDATE records SET status='rejected', reject_reason=?, updated_at=? WHERE id=?`).run(comment, at, recordId)
  settleSampleDone(db, rec.sample_id)   // 全项定稿→样品done；打回→回testing
  writeAudit(db, recordId, who, flow.action, { comment }, at, whoUsername)   // 留痕带登录名：重名也能回溯到账号
  return getRecordById(db, recordId)!
}

export type Audit = { id: number; record_id: string; who: string; username: string | null; action: string; detail: any; at: string }
export function getAudit(db: DB, recordId: string): Audit[] {
  const rows = db.prepare(
    `SELECT * FROM audit_log WHERE record_id = ? ORDER BY id DESC`
  ).all(recordId) as any[]
  return rows.map(r => ({ ...r, detail: safeJson(r.detail, null) }))
}

function writeAudit(db: DB, recordId: string, who: string, action: string, detail: any, at: string, username: string | null = null) {
  db.prepare(
    `INSERT INTO audit_log (record_id, who, username, action, detail, at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(recordId, who, username, action, JSON.stringify(detail), at)
}

// 统一操作留痕：所有关键写操作在路由层调它，落到真实账号（姓名+登录名），只增不改。
export function logAction(db: DB, entityId: string, actor: User | null, action: string, detail: any = {}) {
  writeAudit(db, entityId, actor?.name || '系统', action, detail, now(), actor?.username ?? null)
}
// 查某实体的操作轨迹（留痕归档页用）；记录类实体也能查（与 getAudit 同源）
export function listAudit(db: DB, entityId: string): Audit[] { return getAudit(db, entityId) }

export type DataChange = { comp?: string; row: number; col: string; from: any; to: any }

// 逐格对比两套行，comp 非空时给每条改动打上组分名（多组分表用）
function diffRows(oldRows: any[], newRows: any[], comp?: string): DataChange[] {
  const out: DataChange[] = []
  const maxLen = Math.max(oldRows.length, newRows.length)
  for (let i = 0; i < maxLen; i++) {
    const o = oldRows[i] ?? {}, n = newRows[i] ?? {}
    const keys = new Set([...Object.keys(o), ...Object.keys(n)])
    for (const k of keys) {
      if (String(o[k] ?? '') !== String(n[k] ?? '')) {
        out.push({ ...(comp ? { comp } : {}), row: i + 1, col: k, from: o[k] ?? '', to: n[k] ?? '' })
      }
    }
  }
  return out
}

// 逐格对比两个扁平字典，产出 row:0 的表级改动（meta / cells / reg 共用）。
// colOf 决定该键落成哪个 col 前缀、归属哪个组分。
function diffFlat(
  o: Record<string, any>, n: Record<string, any>,
  colOf: (k: string) => { comp?: string; col: string },
): DataChange[] {
  const out: DataChange[] = []
  for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
    if (String(o[k] ?? '') !== String(n[k] ?? '')) {
      const { comp, col } = colOf(k)
      out.push({ ...(comp ? { comp } : {}), row: 0, col, from: o[k] ?? '', to: n[k] ?? '' })
    }
  }
  return out
}

// 逐格对比新旧 data，产出「第N行·列 旧值→新值」列表；多组分表额外带组分名。
// row 语义：row:0 是表级字段（meta: / cell: / reg: 前缀区分），row>=1 是行号；
// 组分靠独立的 comp 字段区分，不占用 row 编码。
export function diffData(oldData: any, newData: any): DataChange[] {
  const out: DataChange[] = []
  const oldComp: Record<string, any[]> = oldData?.compRows ?? {}
  const newComp: Record<string, any[]> = newData?.compRows ?? {}
  const comps = [...new Set([...Object.keys(oldComp), ...Object.keys(newComp)])]
  const isMulti = comps.length > 0

  if (isMulti) {
    // 多组分表以 compRows 为准：data.rows 只是「当前活动组分」那套的派生副本（见 StructuredSheet.vue
    // 的 bakedRows），不是权威数据。对它再 diff 会把同一次编辑重复报一遍，且不带组分名无法定位。
    for (const c of comps) out.push(...diffRows(oldComp[c] ?? [], newComp[c] ?? [], c))
  } else {
    out.push(...diffRows(oldData?.rows ?? [], newData?.rows ?? []))
  }

  // 曲线核查质控值：键形如 cc_<组分>_<项>（多组分）或 cc_<项>（单组分）。
  // 组分名按已知 compRows 键精确匹配，不靠猜下划线位置（组分名本身可能含下划线）。
  const cellCol = (k: string): { comp?: string; col: string } => {
    if (!k.startsWith('cc_')) return { col: 'cell:' + k }
    const rest = k.slice(3)
    for (const c of comps) if (rest.startsWith(c + '_')) return { comp: c, col: 'cell:' + rest.slice(c.length + 1) }
    return { col: 'cell:' + rest }
  }
  out.push(...diffFlat(oldData?.cells ?? {}, newData?.cells ?? {}, cellCol))

  // 校准曲线系数：改 a/b 会改掉全表结果，必须留痕。
  // 多组分表不报——data.reg 只存「当前活动标签页」那个组分的系数（bakedCompRows 不写 reg），
  // 报了会让「切标签页再保存」凭空产生一条组分间的系数变更，属误导性留痕。
  if (!isMulti) out.push(...diffFlat(oldData?.reg ?? {}, newData?.reg ?? {}, k => ({ col: 'reg:' + k })))

  // 元数据变更
  out.push(...diffFlat(oldData?.meta ?? {}, newData?.meta ?? {}, k => ({ col: 'meta:' + k })))
  return out
}

// ============ 客户档案 ============
export type Customer = { id: number; name: string; contact: string | null; phone: string | null; address: string | null; note: string | null; created_at: string; contract_count: number }
// 建合同时确保客户存在（按名去重，已存在不动）
export function ensureCustomer(db: DB, name: string) {
  if (!name?.trim()) return
  db.prepare(`INSERT OR IGNORE INTO customers (name, created_at) VALUES (?, ?)`).run(name.trim(), now())
}
// 补充/更新客户信息（按名 upsert，不新建重复）。电话与联系人分列（体检26）
export function upsertCustomer(db: DB, input: { name: string; contact?: string; phone?: string; address?: string; note?: string }): Customer {
  const name = input.name?.trim()
  if (!name) throw new Error('客户名必填')
  ensureCustomer(db, name)
  db.prepare(`UPDATE customers SET contact=COALESCE(?,contact), phone=COALESCE(?,phone), address=COALESCE(?,address), note=COALESCE(?,note) WHERE name=?`)
    .run(input.contact ?? null, input.phone ?? null, input.address ?? null, input.note ?? null, name)
  return listCustomers(db).find(c => c.name === name)!
}
export function listCustomers(db: DB): Customer[] {
  return db.prepare(`
    SELECT cu.*, (SELECT COUNT(*) FROM contracts c WHERE c.client = cu.name) AS contract_count
    FROM customers cu ORDER BY cu.name`).all() as Customer[]
}
export function getCustomerContracts(db: DB, name: string): Contract[] {
  const ids = db.prepare(`SELECT id FROM contracts WHERE client=? ORDER BY created_at DESC`).all(name) as { id: string }[]
  return ids.map(r => getContract(db, r.id)!).filter(Boolean)
}

// ============ 委托合同 ============
export function nextContractId(db: DB, year: number): string {
  const prefix = `WT${year}-`
  return prefix + String(maxSeq(db, 'contracts', 'id', prefix) + 1).padStart(4, '0')
}

export function createContract(
  db: DB,
  input: {
    client: string; contact?: string; phone?: string; project?: string; note?: string
    cycleMonths?: number; periodStart?: string; periodEnd?: string
    plan?: { matrix: string; items?: string[]; qty?: number; cycleMonths?: number; note?: string }[]
    quote?: { extNo?: string; signDate?: string; invoice?: string; discount?: number; rows: QuoteRow[] }
    review?: any   // 合同评审记录表 QTCYT/JL141：建单时可一并填，存 review_info（填了≠已受理）
  },
  year = new Date().getFullYear(),
): Contract {
  if (!String(input.client ?? '').trim()) throw new Error('客户名称必填')
  const ps = cleanDate(input.periodStart, '有效期起'), pe = cleanDate(input.periodEnd, '有效期止')
  if (ps && pe && pe < ps) throw new Error('有效期止不能早于有效期起')
  const cyc = cleanNum(input.cycleMonths, '监测周期(月)', { min: 0, int: true })
  const id = nextContractId(db, year)
  db.prepare(
    `INSERT INTO contracts (id, client, contact, phone, project, note, status, cycle_months, period_start, period_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
  ).run(id, String(input.client).trim(), input.contact ?? '', input.phone ?? '', input.project ?? '', input.note ?? '', cyc, ps, pe, now())
  ensureCustomer(db, input.client)   // 客户档案：自动补建
  for (const p of input.plan ?? []) {
    db.prepare(
      `INSERT INTO contract_samples (contract_id, matrix, items, qty, cycle_months, note) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, p.matrix, JSON.stringify(p.items ?? []), Math.max(1, p.qty ?? 1), p.cycleMonths ?? input.cycleMonths ?? 0, p.note ?? '')
  }
  // 合同评审记录表：建单时填了就先存下（打印合同即带出）；受理是登记员另点「确认受理」，此处不置 accepted_at
  if (input.review) db.prepare(`UPDATE contracts SET review_info=? WHERE id=?`).run(JSON.stringify(input.review), id)
  if (input.quote) return saveContractQuote(db, id, input.quote)   // 带报价单一步建：计划由报价单生成
  return getContract(db, id)!
}

// —— 决策8：合同能改、改了字段级留痕；改有效期且方案已批准时，未派工期次自动按新周期重排 ——
export function updateContract(
  db: DB, id: string,
  patch: { client?: string; contact?: string; phone?: string; project?: string; note?: string; cycleMonths?: number; periodStart?: string; periodEnd?: string; urgent?: boolean },
  actor: User | { name: string; username?: string },
): { contract: Contract; changes: { col: string; from: any; to: any }[]; reschedule?: { rescheduled: number; manual: number } } {
  const c = getContract(db, id)
  if (!c) throw new Error('合同不存在')
  if (patch.urgent !== undefined) db.prepare(`UPDATE contracts SET urgent=? WHERE id=?`).run(patch.urgent ? 1 : 0, id)
  const map: [keyof typeof patch, string][] = [
    ['client', 'client'], ['contact', 'contact'], ['phone', 'phone'], ['project', 'project'], ['note', 'note'],
    ['cycleMonths', 'cycle_months'], ['periodStart', 'period_start'], ['periodEnd', 'period_end'],
  ]
  // 日期格式先校验：脏日期进库会让排期算出 NaN-NaN-NaN
  if (patch.periodStart !== undefined) patch.periodStart = cleanDate(patch.periodStart, '有效期起') ?? ''
  if (patch.periodEnd !== undefined) patch.periodEnd = cleanDate(patch.periodEnd, '有效期止') ?? ''
  const changes: { col: string; from: any; to: any }[] = []
  const sets: string[] = [], args: any[] = []
  for (const [k, col] of map) {
    const v = patch[k]
    if (v === undefined) continue
    if (String((c as any)[col] ?? '') === String(v ?? '')) continue
    changes.push({ col, from: (c as any)[col] ?? '', to: v ?? '' })
    sets.push(`${col}=?`); args.push(v)
  }
  if (!changes.length) return { contract: c, changes }
  inTx(db, () => {
    db.prepare(`UPDATE contracts SET ${sets.join(', ')} WHERE id=?`).run(...args, id)
    if (patch.client && patch.client !== c.client) ensureCustomer(db, patch.client)
  })
  logAction(db, id, actor as User, 'contract_update', { changes })
  // 有效期变了且方案已批准 → 未派工期次跟随重排（已派工/已采的保留，计入需人工）
  const periodChanged = changes.some(ch => ch.col === 'period_start' || ch.col === 'period_end' || ch.col === 'cycle_months')
  const reschedule = periodChanged && c.scheme?.status === 'approved' ? reschedulePendingRounds(db, id) : undefined
  return { contract: getContract(db, id)!, changes, reschedule }
}

// —— 报价行 → 检测计划：类别归基质、每期样品数=点位数×每天次数、次/年换算监测周期、手写项目标注待确认 ——
const QUOTE_MATRICES = ['废水', '地表水', '地下水', '海水', '土壤', '固废', '环境空气', '废气', '生活饮用水', '大气降水', '噪声']
function quoteMatrix(category: string): string {
  if (category.includes('废气')) return '废气'
  if (category.includes('噪声')) return '噪声'
  return QUOTE_MATRICES.find(m => category.includes(m)) || category
}
export function quoteRowsToPlan(rows: QuoteRow[]): { matrix: string; items: string[]; qty: number; cycleMonths: number; perYear: number; note: string; point: string }[] {
  return rows.map(r => {
    const extras = String(r.extraItems || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
    const perYear = Math.max(0, Math.floor(r.perYear || 0))
    return {
      matrix: quoteMatrix(r.category || ''),
      items: [...(r.items || []), ...extras],
      // 体检14 统一口径：每期样品数 = 点位数 × 每天次数（原来丢了 perDay，3点位×2次/天只建3个样）
      qty: Math.max(1, r.points || 1) * Math.max(1, Math.floor(r.perDay || 1)),
      cycleMonths: perYear >= 1 ? Math.max(1, Math.round(12 / perYear)) : 0,   // 展示/兜底用；排期以 perYear 精确铺
      perYear,   // 0=单次；≥1 时排期一年正好排 perYear 期（不再用 12/perYear 取整漂移）
      note: extras.length ? `点位「${r.point}」含手写项目，方案审核请人工确认` : '',
      point: r.point || '',   // 点位名随计划走：样品编号/报告溯源都靠它
    }
  })
}

// —— 存报价单：小计/合计/大写服务端权威计算，并替换式同步样品计划 ——
export function saveContractQuote(
  db: DB,
  contractId: string,
  input: { extNo?: string; signDate?: string; invoice?: string; discount?: number; buyer?: QuoteBuyer; rows: QuoteRow[] },
): Contract {
  if (!db.prepare(`SELECT id FROM contracts WHERE id=?`).get(contractId)) throw new Error('合同不存在')
  // 数字字段服务端清洗：收字符串会算出 NaN 存成 null，负单价会出负合计
  const rows: QuoteRow[] = (input.rows ?? []).map((r, i) => {
    const price = cleanNum(r.price, `第${i + 1}行 单价`, { min: 0 })
    const points = Math.max(1, cleanNum(r.points, `第${i + 1}行 点位数`, { min: 0, int: true }))
    const perDay = Math.max(1, cleanNum(r.perDay, `第${i + 1}行 每天次数`, { min: 0, int: true }))
    // 每年次数保留 0（0=只做一次/单次），不能洗成 1——排期和前端都按 0=单次理解；算钱时单次按 1 次计
    const perYear = cleanNum(r.perYear, `第${i + 1}行 每年次数`, { min: 0, int: true })
    return { ...r, price, points, perDay, perYear, subtotal: Math.round(price * points * perDay * Math.max(1, perYear) * 100) / 100 }
  })
  const total = Math.round(rows.reduce((s, r) => s + (r.subtotal || 0), 0) * 100) / 100
  const discount = input.discount == null || input.discount === ('' as any) ? total : cleanNum(input.discount, '折后总价', { min: 0 })
  const quote: Quote = {
    extNo: input.extNo ?? '', signDate: cleanDate(input.signDate, '签订日期') ?? '', invoice: input.invoice ?? '',
    buyer: input.buyer ?? {},
    rows, total, discount, discountUpper: rmbUpper(discount),
  }
  // 先删后插必须在事务里：中途失败不能把样品计划清空
  inTx(db, () => {
    db.prepare(`UPDATE contracts SET quote_json=? WHERE id=?`).run(JSON.stringify(quote), contractId)
    db.prepare(`DELETE FROM contract_samples WHERE contract_id=?`).run(contractId)
    for (const p of quoteRowsToPlan(rows)) {
      db.prepare(`INSERT INTO contract_samples (contract_id, matrix, items, qty, cycle_months, note, point, per_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(contractId, p.matrix, JSON.stringify(p.items), p.qty, p.cycleMonths, p.note, p.point, p.perYear)
      if (p.point) upsertPoint(db, contractId, { name: p.point, matrix: p.matrix, source: 'contract' })
    }
  })
  return getContract(db, contractId)!
}

export function getContract(db: DB, id: string): Contract | null {
  const c = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(id) as any
  if (!c) return null
  // 客户档案的地址/电话随合同带出（报告"受检单位地址"要用；合同表本身没有这两列）
  const cust = db.prepare(`SELECT address, phone FROM customers WHERE name = ?`).get(c.client) as any
  if (cust) { c.address = cust.address ?? null; if (c.phone == null) c.phone = cust.phone ?? null }
  c.review_info = safeJson(c.review_info, null)
  c.quote = safeJson(c.quote_json, null)
  delete c.quote_json
  const plan = (db.prepare(`SELECT * FROM contract_samples WHERE contract_id = ? ORDER BY id`).all(id) as any[])
    .map(r => ({ ...r, items: safeJson(r.items, []) }))
  const samples = (db.prepare(`SELECT * FROM samples WHERE contract_id = ? ORDER BY id`).all(id) as any[])
    .map(r => ({ ...r, items: safeJson(r.items, []) }))
  return { ...c, plan, samples, scheme: getScheme(db, id) }
}

// —— 委托受理：登记员「确认受理·合同评审通过」，主线才往下走。可带合同评审结论 ——
// 合同评审签批"不同意签订"= 主线红灯：受理/生成样品/派工全拦（原来只挡打印正本，形同虚设）
function assertNotVetoed(db: DB, contractId: string, doing: string) {
  const r = db.prepare(`SELECT tech_review_result, tech_approved_by FROM contracts WHERE id=?`).get(contractId) as any
  if (r?.tech_review_result === 'reject') {
    throw new Error(`技术负责人（${r.tech_approved_by || ''}）已签批「不同意签订」，不能${doing}——请重新建合同走评审`)
  }
}
export function acceptContract(db: DB, id: string, who: string, review?: any): Contract {
  const c = getContract(db, id)
  if (!c) throw new Error('合同不存在')
  assertNotVetoed(db, id, '受理')   // 被技术负责人否掉的合同不能再走主线（原来"不同意"只挡打印，形同虚设）
  if (!c.accepted_at) {
    // 受理不带评审时保留建单时已填的评审记录（COALESCE），不能抹成 NULL
    db.prepare(`UPDATE contracts SET accepted_at=?, accepted_by=?, review_info=COALESCE(?, review_info) WHERE id=?`)
      .run(now(), who, review ? JSON.stringify(review) : null, id)
  } else if (review) {
    db.prepare(`UPDATE contracts SET review_info=? WHERE id=?`).run(JSON.stringify(review), id)
  }
  return getContract(db, id)!
}

// 合同评审状态机（拍板7）：技术负责人在系统里签「同意/不同意签订」。人选未定，权限暂挂管理员
// （PERM contract_tech_review）。同意 = tech_approved_at 落时间（生效凭据，打印正本的门禁）；
// 不同意只留结果与意见，不置生效。签过一次（无论同意与否）不能重复签，要改走线下沟通后重建合同。
export function techReviewContract(
  db: DB, id: string, decision: 'approve' | 'reject',
  actor: { name: string; username?: string }, note = '',
): Contract {
  const c = getContract(db, id) as any
  if (!c) throw new Error('合同不存在')
  if (c.tech_approved_at || c.tech_review_result) {
    throw new Error(`该合同已签批（${c.tech_approved_by || c.tech_review_result}），不能重复签批`)
  }
  if (decision === 'approve') {
    db.prepare(`UPDATE contracts SET tech_approved_by=?, tech_approved_at=?, tech_approve_note=?, tech_review_result='approve' WHERE id=?`)
      .run(actor.name, now(), note || null, id)
  } else {
    db.prepare(`UPDATE contracts SET tech_approved_by=?, tech_approve_note=?, tech_review_result='reject' WHERE id=?`)
      .run(actor.name, note || null, id)
  }
  logAction(db, id, actor as User, 'contract_tech_review', { decision, note })
  return getContract(db, id)!
}

// —— 合同终止（体检15）：客户跑路/项目黄了，合同置 terminated 终态。已有数据只读不动，
// 新动作（派工/收样/生成样品/生成报告）一律拦 ——
function assertContractNotTerminated(db: DB, contractId: string | null | undefined, doing: string) {
  if (!contractId) return
  const st = (db.prepare(`SELECT status FROM contracts WHERE id=?`).get(contractId) as any)?.status
  if (st === 'terminated') throw new Error(`合同已终止，不能再${doing}；已有数据仅供查看`)
}
export function terminateContract(db: DB, id: string, reason: string, actor: User | { name: string; username?: string }): Contract {
  const c = getContract(db, id)
  if (!c) throw new Error('合同不存在')
  if (c.status === 'terminated') throw new Error('该合同已经终止过了')
  // 周期项目合同从头到尾都是 draft（confirmed 只有单次线的 generateSamples 会写）——
  // 原来这里只放行 confirmed，导致走期次线的合同永远终止不了（客户注销时点终止直接报错）。
  if (!reason?.trim()) throw new Error('终止原因必填')
  return inTx(db, () => {
    db.prepare(`UPDATE contracts SET status='terminated' WHERE id=?`).run(id)
    // 顺带了结所有还没采的期次（pending/rescheduled/failed）：不然它们既不能派工（合同已终止被拦）
    // 也不能标未采成（要求已派工），会变成永远挂在逾期提醒里的僵尸
    const open = db.prepare(`SELECT id, status FROM rounds WHERE contract_id=? AND status IN ('pending','rescheduled','failed')`).all(id) as any[]
    for (const r of open) {
      db.prepare(`UPDATE rounds SET status='cancelled', assignment_status='revoked', assignment_updated_at=? WHERE id=?`).run(now(), r.id)
      logAction(db, r.id, actor as User, 'round_cancel', { reason: `合同终止：${reason.trim()}`, prev_status: r.status })
    }
    logAction(db, id, actor as User, 'contract_terminate', { reason: reason.trim(), prev_status: c.status, cancelled_rounds: open.length })
    return getContract(db, id)!
  })
}

// ============ 点位档案（决策1：合同预设 + 现场补，实际位置留痕，报告如实体现） ============
export type MonitoringPoint = {
  id: number; contract_id: string; code: string; name: string; matrix: string | null
  source: 'contract' | 'field'; planned_desc: string | null; actual_desc: string | null
  coordinate: string | null; remark: string | null; created_at: string
}
export function listPoints(db: DB, contractId: string): MonitoringPoint[] {
  return (db.prepare(`SELECT * FROM monitoring_points WHERE contract_id=? ORDER BY id`).all(contractId) as any[])
    .map(r => ({ ...r, stack_info: safeJson(r.stack_info, null) })) as MonitoringPoint[]
}
function nextPointCode(db: DB, contractId: string): string {
  const n = (db.prepare(`SELECT COUNT(*) n FROM monitoring_points WHERE contract_id=?`).get(contractId) as any).n
  return `${contractId}-P${n + 1}`
}
// 建/补点位：按 (合同, 名称) 幂等；已存在只补空缺字段，不覆盖已有实际位置
export function upsertPoint(
  db: DB, contractId: string,
  p: { name: string; matrix?: string; source?: 'contract' | 'field'; plannedDesc?: string; actualDesc?: string; coordinate?: string; remark?: string; stackInfo?: Record<string, any> },
  actor?: User | { name: string; username?: string },
): MonitoringPoint {
  if (!p.name?.trim()) throw new Error('点位名称必填')
  const name = p.name.trim()
  const cur = db.prepare(`SELECT * FROM monitoring_points WHERE contract_id=? AND name=?`).get(contractId, name) as (MonitoringPoint & { stack_info?: string | null }) | undefined
  if (!cur) {
    db.prepare(`INSERT INTO monitoring_points (contract_id, code, name, matrix, source, planned_desc, actual_desc, coordinate, remark, stack_info, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(contractId, nextPointCode(db, contractId), name, p.matrix ?? null, p.source ?? 'contract',
        p.plannedDesc ?? name, p.actualDesc ?? null, p.coordinate ?? null, p.remark ?? null,
        p.stackInfo ? JSON.stringify(p.stackInfo) : null, now())
    if (actor && p.source === 'field') logAction(db, contractId, actor as User, 'point_add_field', { name, actualDesc: p.actualDesc })
  } else {
    // 地基3：排气筒静态参数按 key 合并——补燃料不丢已录的高度内径
    const mergedStack = p.stackInfo ? JSON.stringify({ ...safeJson(cur.stack_info ?? null, {}), ...p.stackInfo }) : null
    db.prepare(`UPDATE monitoring_points SET matrix=COALESCE(?,matrix), planned_desc=COALESCE(?,planned_desc),
      coordinate=COALESCE(?,coordinate), remark=COALESCE(?,remark), stack_info=COALESCE(?,stack_info) WHERE id=?`)
      .run(p.matrix ?? null, p.plannedDesc ?? null, p.coordinate ?? null, p.remark ?? null, mergedStack, cur.id)
  }
  const row = db.prepare(`SELECT * FROM monitoring_points WHERE contract_id=? AND name=?`).get(contractId, name) as any
  return { ...row, stack_info: safeJson(row.stack_info, null) }
}
// 现场改实际采样位置：与预设不一致必须留痕（决策1 硬要求）
export function setPointActual(db: DB, pointId: number, actualDesc: string, actor: User | { name: string; username?: string }): MonitoringPoint {
  const p = db.prepare(`SELECT * FROM monitoring_points WHERE id=?`).get(pointId) as MonitoringPoint | undefined
  if (!p) throw new Error('点位不存在')
  if (!actualDesc?.trim()) throw new Error('实际采样位置必填')
  const v = actualDesc.trim()
  if ((p.actual_desc || '') !== v) {
    db.prepare(`UPDATE monitoring_points SET actual_desc=? WHERE id=?`).run(v, pointId)
    logAction(db, p.contract_id, actor as User, 'point_actual_change',
      { point: p.name, code: p.code, from: p.actual_desc ?? p.planned_desc ?? '', to: v })
  }
  return db.prepare(`SELECT * FROM monitoring_points WHERE id=?`).get(pointId) as MonitoringPoint
}
// 方案保存时同步点位档案（source=contract）；存量方案 JSON 只读兼容，新方案走这里
function syncPointsFromScheme(db: DB, contractId: string, points: SchemePoint[]) {
  for (const p of points) {
    if (!p.point?.trim()) continue
    upsertPoint(db, contractId, { name: p.point, matrix: p.element, source: 'contract', plannedDesc: p.point })
  }
}

// ============ 监测方案 FA ============
export function getScheme(db: DB, contractId: string): Scheme | null {
  const r = db.prepare(`SELECT * FROM schemes WHERE contract_id = ? ORDER BY created_at DESC LIMIT 1`).get(contractId) as any
  if (!r) return null
  return { ...r, points: safeJson(r.points, []), limits: safeJson(r.limits, []) }
}
// ——— S2 频次结构化：把「每天 N 次」+「监测周期」存进 SchemePoint.freq 的规范文本，前后端同一套解析 ———
const CYCLE_LABELS: { m: number; t: string }[] = [
  { m: 0, t: '单次' }, { m: 1, t: '每月' }, { m: 3, t: '每季度' }, { m: 6, t: '每半年' }, { m: 12, t: '每年' },
]
export function composeFreq(perDay: number, cycleMonths: number): string {
  const n = Math.max(1, Math.floor(Number(perDay) || 1))
  const cyc = CYCLE_LABELS.find(c => c.m === cycleMonths)?.t ?? (cycleMonths > 0 ? `每${cycleMonths}个月` : '单次')
  return `每天${n}次 · ${cyc}`
}
export function parseFreq(freq: string): { perDay: number; cycleMonths: number } {
  const s = String(freq || '')
  const perDay = Math.max(1, Number(s.match(/每天\s*(\d+)\s*次/)?.[1] || s.match(/(\d+)\s*次\s*[\/／]\s*天/)?.[1] || 1))
  let cycleMonths = 0
  const perYear = s.match(/(\d+)\s*次\s*[\/／]\s*年/)          // 旧格式 N次/年 → 每 12/N 月
  const perMonth = s.match(/(\d+)\s*次\s*[\/／]\s*月/)          // 旧格式 N次/月 → 每 1 月（月内多次仍算每月）
  const everyN = s.match(/每\s*(\d+)\s*个月/)
  if (everyN) cycleMonths = Number(everyN[1])
  else if (perYear) { const py = Number(perYear[1]); cycleMonths = py >= 1 ? Math.max(1, Math.round(12 / py)) : 0 }
  else if (perMonth) cycleMonths = 1
  else if (/单次/.test(s)) cycleMonths = 0
  else if (/半年/.test(s)) cycleMonths = 6
  else if (/季/.test(s)) cycleMonths = 3
  else if (/年/.test(s)) cycleMonths = 12
  else if (/月/.test(s)) cycleMonths = 1
  return { perDay, cycleMonths }
}
// 达标限值各挂本项目所在点位的执行标准；限值自带标准优先（修「全挂第一行标准」的 bug）
function resolveLimitStandards(points: SchemePoint[], limits: LimitRule[]): LimitRule[] {
  const stdOf = new Map<string, string>()
  for (const p of points) for (const a of p.items ?? []) if (!stdOf.has(a) && p.standard) stdOf.set(a, p.standard)
  const fallback = points[0]?.standard || ''
  return limits.map(l => ({ ...l, standard: l.standard || stdOf.get(l.analyte) || fallback }))
}
// S2 问题8：方案保存即同步「样品计划」——基质/项目/数量/周期一律以方案点位为准
function syncPlanFromScheme(db: DB, contractId: string, points: SchemePoint[]) {
  const rows = points.filter(p => p.element)
  if (!rows.length) return
  inTx(db, () => {
    db.prepare(`DELETE FROM contract_samples WHERE contract_id=?`).run(contractId)
    for (const p of rows) {
      const { perDay, cycleMonths } = parseFreq(p.freq)
      // 体检14 统一口径：每期样品数 = 点位数 × 每天次数。方案一行就是一个点位（点位数=1），
      // 所以 qty = 1 × perDay；与报价路径（points × perDay）同一公式
      db.prepare(`INSERT INTO contract_samples (contract_id, matrix, items, qty, cycle_months, note, point) VALUES (?,?,?,?,?,?,?)`)
        .run(contractId, p.element, JSON.stringify(p.items ?? []), 1 * Math.max(1, perDay), cycleMonths, '方案同步', p.point || '')
    }
  })
}
export function createScheme(db: DB, input: { contractId: string; points?: SchemePoint[]; limits?: LimitRule[]; cycleMonths?: number; periodStart?: string; periodEnd?: string }, year = new Date().getFullYear()): Scheme {
  const cyc = input.cycleMonths ?? 0
  const points = input.points ?? []
  // PRD 步骤2 校验：带点位保存时不许空方案送审——空方案批准会铺出空待采清单
  if (input.points) {
    if (!points.length) throw new Error('方案至少要有 1 个点位行')
    for (const [i, p] of points.entries()) {
      if (!p.element?.trim()) throw new Error(`第 ${i + 1} 行缺「要素/基质」`)
      if (!p.point?.trim()) throw new Error(`第 ${i + 1} 行缺「点位」——采样地点必须体现（决策1）`)
      if (!p.items?.length || p.items.every(x => !String(x).trim())) throw new Error(`第 ${i + 1} 行（${p.point}）没有检测项目`)
      if (!p.freq?.trim()) throw new Error(`第 ${i + 1} 行（${p.point}）没有频次`)
    }
  }
  const limits = JSON.stringify(resolveLimitStandards(points, input.limits ?? []))
  const existing = getScheme(db, input.contractId)
  if (existing) {   // 一份合同一份方案：已有则更新、状态回到待审核
    db.prepare(`UPDATE schemes SET points=?, limits=?, cycle_months=?, period_start=?, period_end=?, status='draft', reject_reason='' WHERE id=?`)
      .run(JSON.stringify(points), limits, cyc, input.periodStart ?? null, input.periodEnd ?? null, existing.id)
  } else {
    const id = nextSeqId(db, 'schemes', `FA${year}-`)
    db.prepare(`INSERT INTO schemes (id, contract_id, points, limits, cycle_months, period_start, period_end, status, created_at) VALUES (?,?,?,?,?,?,?,'draft',?)`)
      .run(id, input.contractId, JSON.stringify(points), limits, cyc, input.periodStart ?? null, input.periodEnd ?? null, now())
  }
  if (input.points && input.points.length) {
    syncPlanFromScheme(db, input.contractId, points)   // 有点位才同步，旧流程不带 points 不动计划
    syncPointsFromScheme(db, input.contractId, points) // 点位档案（决策1）：方案里的点位落成独立实体
  }
  return getScheme(db, input.contractId)!
}
export function reviewScheme(db: DB, contractId: string, op: 'approve' | 'reject', who: string, comment = ''): Scheme & { _reschedule?: { rescheduled: number; manual: number } } {
  const s = getScheme(db, contractId)
  if (!s) throw new Error('方案不存在')
  if (s.status !== 'draft') throw new Error(`方案当前状态「${s.status}」不能审核`)
  if (op === 'reject') {
    db.prepare(`UPDATE schemes SET status='rejected', reject_reason=? WHERE id=?`).run(comment, s.id)
    return getScheme(db, contractId)!
  }
  db.prepare(`UPDATE schemes SET status='approved', reviewer=?, reviewed_at=?, reject_reason='' WHERE id=?`).run(who, now(), s.id)
  const hadRounds = (db.prepare(`SELECT COUNT(*) n FROM rounds WHERE contract_id=?`).get(contractId) as any).n > 0
  if (!hadRounds) { generateRounds(db, contractId); return getScheme(db, contractId)! }
  // S2 问题9：方案改后重新批准——未派工未采的期次按新周期重排，已派工/已采的保留并提示人工
  const summary = reschedulePendingRounds(db, contractId)
  return { ...getScheme(db, contractId)!, _reschedule: summary }
}

// ============ 监测期次排期 + 到期提醒 ============
function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12), nm = (total % 12) + 1
  const dim = new Date(ny, nm, 0).getDate()          // 该月天数（处理月末）
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`
}
function addDays(iso: string, n: number): string {
  const dt = new Date(iso + 'T00:00:00'); dt.setDate(dt.getDate() + n)
  return todayLocal(dt)   // 进是本地午夜，出也必须按本地日历读，否则东八区少一天
}
export function getRound(db: DB, roundId: string): Round | null {
  const r = db.prepare(`SELECT * FROM rounds WHERE id=?`).get(roundId) as any
  if (!r) return null
  const samplerIds = safeJson(r.sampler_ids, [])
  const names = Array.isArray(samplerIds) ? samplerIds.map((id: string) => getUser(db, id)?.name).filter(Boolean) : []
  let fieldInfo = safeJson(r.field_info, null)
  if (Array.isArray(samplerIds) && samplerIds.length) {
    fieldInfo = fieldInfo && typeof fieldInfo === 'object' ? fieldInfo : {}
    const confirmations = fieldInfo.confirmations && typeof fieldInfo.confirmations === 'object' ? fieldInfo.confirmations : {}
    fieldInfo.confirmation_users = samplerIds.map((id: string) => ({
      user_id: id,
      name: getUser(db, id)?.name ?? confirmations[id]?.name ?? id,
      confirmed_at: confirmations[id]?.at ?? null,
    }))
  }
  if (fieldInfo?.confirmations && typeof fieldInfo.confirmations === 'object') {
    fieldInfo.confirms = Object.fromEntries(Object.entries(fieldInfo.confirmations).map(([id, confirmation]: [string, any]) => [
      getUser(db, id)?.name ?? confirmation?.name ?? id,
      confirmation?.at,
    ]))
  }
  return {
    ...r,
    sampler: names.length ? names.join('、') : r.sampler,
    sampler_ids: Array.isArray(samplerIds) ? samplerIds : [],
    assignment_status: r.assignment_status ?? (names.length ? 'active' : 'unassigned'),
    field_info: fieldInfo,
    items: safeJson(r.items, []),
  }
}

// 期次对象级访问：管理派工的角色可查全部；采样员必须同时具备角色、当前有效派工和 immutable username。
// 历史歧义/已撤销派工一律 fail closed，只有管理角色能进入核对。
export function assertRoundAccess(db: DB, roundId: string, actor: User): Round {
  const r = getRound(db, roundId)
  if (!r) throw httpError(404, '监测期次不存在', 'ROUND_NOT_FOUND')
  if (hasRole(actor, ...PERM.round_assign)) return r
  if (!hasRole(actor, 'sampler') || r.assignment_status !== 'active' || !r.sampler_ids.includes(actor.username)) {
    throw httpError(403, '无权访问该期次：需要当前有效派工或期次管理权限', 'ROUND_FORBIDDEN')
  }
  return r
}

export function canAccessRound(db: DB, roundId: string, actor: User): boolean {
  try { assertRoundAccess(db, roundId, actor); return true } catch { return false }
}

export type StagedAttachmentInput = {
  roundId: string; sampleSlotId: string; clientAttachmentId: string
  hash: string; mime: string; size: number; revision: number; storedName?: string
}
export type StagedAttachmentPolicy = { managedDeviceId?: string; now?: () => Date; leaseMs?: number; requestNonce?:{nonce:string;issuedAt:string;expiresAt:string} }
function consumeDeviceNonce(db:DB,deviceId:string|undefined,proof:StagedAttachmentPolicy['requestNonce']){if(proof)db.prepare(`INSERT INTO device_request_nonces(device_id,nonce,issued_at,expires_at) VALUES(?,?,?,?)`).run(deviceId,proof.nonce,proof.issuedAt,proof.expiresAt)}

function requireStagedAttachmentScope(db: DB, input: Pick<StagedAttachmentInput, 'roundId' | 'sampleSlotId'>, actor: User, policy: StagedAttachmentPolicy) {
  const round = assertRoundAccess(db, input.roundId, actor)
  if (!hasRole(actor, 'sampler') || round.assignment_status !== 'active' || round.sampler_ids.filter(id => id === actor.username).length !== 1) throw new Error('OFFLINE_ASSIGNEE_REQUIRED')
  if (!policy.managedDeviceId) throw new Error('MANAGED_DEVICE_REQUIRED')
  const sequence = new Map<string, number>()
  const allowedSlots = (Array.isArray(round.items) ? round.items : []).flatMap((item: any) => Array.from({ length: Math.max(0, Number(item.qty) || 0) }, () => {
    const matrix = String(item.matrix || '样品'), next = (sequence.get(matrix) ?? 0) + 1
    sequence.set(matrix, next)
    return `${round.id}:${matrix}:${next}`
  }))
  if (!allowedSlots.includes(input.sampleSlotId)) throw new Error('ATTACHMENT_SLOT_MISMATCH')
}

// 文件正文由 HTTP 层安全落入 staging 目录；本函数提供可迁移到对象存储的幂等账本协议。
export function stageAttachment(db: DB, input: StagedAttachmentInput, bytes: Uint8Array, actor: User, policy: StagedAttachmentPolicy = {}) {
  requireStagedAttachmentScope(db, input, actor, policy)
  if (!/^[a-f0-9]{64}$/.test(input.hash) || createHash('sha256').update(bytes).digest('hex') !== input.hash) throw new Error('ATTACHMENT_HASH_MISMATCH')
  if (bytes.byteLength !== input.size || input.size <= 0 || input.size > 10 * 1024 * 1024) throw new Error('ATTACHMENT_SIZE_MISMATCH')
  if (!/^image\/(jpeg|png|webp|heic)$/.test(input.mime)) throw new Error('ATTACHMENT_MIME_REJECTED')
  if (!input.clientAttachmentId || input.clientAttachmentId.length > 128 || !Number.isInteger(input.revision) || input.revision < 1) throw new Error('ATTACHMENT_METADATA_INVALID')
  const existing = db.prepare(`SELECT receipt_id,round_id,sample_slot_id,client_attachment_id,owner_id,device_id,content_hash,mime,size,revision,generation,status,lease_expires_at FROM staged_attachments WHERE round_id=? AND owner_id=? AND device_id=? AND client_attachment_id=?`).get(input.roundId, actor.username, policy.managedDeviceId, input.clientAttachmentId) as any
  if (existing) {
    if (existing.content_hash !== input.hash || existing.size !== input.size || existing.mime !== input.mime || existing.sample_slot_id !== input.sampleSlotId || existing.revision !== input.revision) throw new Error('ATTACHMENT_IDEMPOTENCY_CONFLICT')
    if (!['expired','cancelled'].includes(existing.status)){db.exec('BEGIN IMMEDIATE');try{consumeDeviceNonce(db,policy.managedDeviceId,policy.requestNonce);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}return { receiptId: existing.receipt_id, status: existing.status, leaseExpiresAt: existing.lease_expires_at, hash: existing.content_hash, reused: true }}
  }
  const now = (policy.now ?? (() => new Date()))(), createdAt = now.toISOString(), leaseExpiresAt = new Date(now.getTime() + (policy.leaseMs ?? 24 * 3600_000)).toISOString(), receiptId = randomUUID(), generation = Number(existing?.generation || 0) + 1
  db.exec('BEGIN IMMEDIATE')
  try {
    consumeDeviceNonce(db,policy.managedDeviceId,policy.requestNonce)
    if (existing) {
      if (db.prepare(`SELECT 1 FROM staged_attachment_refs WHERE receipt_id=? LIMIT 1`).get(existing.receipt_id)) throw new Error('ATTACHMENT_GENERATION_REFERENCED')
      db.prepare(`DELETE FROM staged_attachments WHERE receipt_id=?`).run(existing.receipt_id)
    }
    db.prepare(`INSERT INTO staged_attachments(receipt_id,round_id,sample_slot_id,client_attachment_id,owner_id,device_id,content_hash,mime,size,revision,stored_name,blob,generation,status,lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(receiptId, input.roundId, input.sampleSlotId, input.clientAttachmentId, actor.username, policy.managedDeviceId, input.hash, input.mime, input.size, input.revision, null, Buffer.from(bytes), generation, 'uploaded_staged', leaseExpiresAt, createdAt, createdAt)
    logAction(db, input.roundId, actor, 'attachment_staged', { receipt_id: receiptId, generation, sample_slot_id: input.sampleSlotId, client_attachment_id: input.clientAttachmentId, hash: input.hash, size: input.size, lease_expires_at: leaseExpiresAt })
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return { receiptId, status: 'uploaded_staged', leaseExpiresAt, hash: input.hash, reused: false }
}

export function getStagedAttachmentStatus(db: DB, roundId: string, clientAttachmentId: string, actor: User, policy: StagedAttachmentPolicy = {}) {
  assertRoundAccess(db, roundId, actor)
  if (!policy.managedDeviceId) throw new Error('MANAGED_DEVICE_REQUIRED')
  const row = db.prepare(`SELECT receipt_id,sample_slot_id,content_hash,mime,size,revision,status,lease_expires_at FROM staged_attachments WHERE round_id=? AND owner_id=? AND device_id=? AND client_attachment_id=?`).get(roundId, actor.username, policy.managedDeviceId, clientAttachmentId) as any
  if (!row) throw httpError(404, '暂存附件不存在', 'STAGED_ATTACHMENT_NOT_FOUND')
  const now = (policy.now ?? (() => new Date()))()
  const status = Date.parse(row.lease_expires_at) <= now.getTime() && row.status === 'uploaded_staged' ? 'expired' : row.status
  db.exec('BEGIN IMMEDIATE');try{consumeDeviceNonce(db,policy.managedDeviceId,policy.requestNonce);if (status === 'expired' && row.status !== 'expired') db.prepare(`UPDATE staged_attachments SET status='expired',updated_at=? WHERE receipt_id=?`).run(now.toISOString(), row.receipt_id);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
  return { receiptId: row.receipt_id, status, leaseExpiresAt: row.lease_expires_at, hash: row.content_hash, size: row.size, mime: row.mime, sampleSlotId: row.sample_slot_id, revision: row.revision }
}

export function cancelStagedAttachment(db: DB, roundId: string, clientAttachmentId: string, actor: User, policy: StagedAttachmentPolicy = {}) {
  assertRoundAccess(db, roundId, actor)
  if (!policy.managedDeviceId) throw new Error('MANAGED_DEVICE_REQUIRED')
  const row = db.prepare(`SELECT receipt_id,status,stored_name FROM staged_attachments WHERE round_id=? AND owner_id=? AND device_id=? AND client_attachment_id=?`).get(roundId, actor.username, policy.managedDeviceId, clientAttachmentId) as any
  if (!row) throw httpError(404, '暂存附件不存在', 'STAGED_ATTACHMENT_NOT_FOUND')
  if (row.status !== 'cancelled') {
    const updatedAt = (policy.now ?? (() => new Date()))().toISOString()
    db.exec('BEGIN IMMEDIATE'); try { consumeDeviceNonce(db,policy.managedDeviceId,policy.requestNonce);db.prepare(`UPDATE staged_attachments SET status='cancelled', blob=NULL, updated_at=? WHERE receipt_id=?`).run(updatedAt, row.receipt_id); logAction(db, roundId, actor, 'attachment_stage_cancel', { receipt_id: row.receipt_id, client_attachment_id: clientAttachmentId }); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
  } else if(policy.requestNonce){db.exec('BEGIN IMMEDIATE');try{consumeDeviceNonce(db,policy.managedDeviceId,policy.requestNonce);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
  }
  return { receiptId: row.receipt_id, status: 'cancelled', storedName: row.stored_name as string | null }
}

export function addStagedAttachmentRef(db: DB, receiptId: string, refType: string, refId: string) {
  if (!db.prepare(`SELECT 1 FROM staged_attachments WHERE receipt_id=?`).get(receiptId)) throw new Error('STAGED_ATTACHMENT_NOT_FOUND')
  db.prepare(`INSERT OR IGNORE INTO staged_attachment_refs(receipt_id,ref_type,ref_id) VALUES(?,?,?)`).run(receiptId, refType, refId)
}

export function gcStagedAttachments(db: DB,now:Date=new Date()) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const nonceAuditCutoff=new Date(now.getTime()-24*3600_000).toISOString()
    const noncesDeleted=(db.prepare(`DELETE FROM device_request_nonces WHERE expires_at<=?`).run(nonceAuditCutoff) as any).changes??0
    db.prepare(`UPDATE staged_attachments SET status='expired',updated_at=? WHERE status='uploaded_staged' AND lease_expires_at<>'' AND lease_expires_at<=?`).run(now.toISOString(),now.toISOString())
    const rows = db.prepare(`SELECT receipt_id FROM staged_attachments s WHERE s.status IN ('expired','cancelled') AND s.blob IS NOT NULL AND NOT EXISTS (SELECT 1 FROM staged_attachment_refs r WHERE r.receipt_id=s.receipt_id)`).all() as any[]
    for (const row of rows) db.prepare(`UPDATE staged_attachments SET blob=NULL,updated_at=? WHERE receipt_id=?`).run(now.toISOString(),row.receipt_id)
    db.exec('COMMIT'); return { deleted: rows.length,noncesDeleted }
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
export function startStagingGcTimer(db:DB,intervalMs=60_000,now:()=>Date=()=>new Date()){const ms=Math.min(60_000,Math.max(10,intervalMs)),timer=setInterval(()=>{try{gcStagedAttachments(db,now())}catch(error){console.error('[staging-gc] timer failed; ledger retained',error)}},ms);timer.unref();return()=>clearInterval(timer)}

export type OfflinePackagePolicy = {
  offlineWriteEnabled?: boolean
  sensitiveOfflinePackageEnabled?: boolean
  verifyManagedDevice?: (actor: User, roundId: string) => { deviceId: string; trustedUntil: string; attestationId: string; bindingPublicKeySpki: string; bindingFingerprint: string } | null
  signedFormRuleApproved?: boolean
  now?: () => Date
  signingPrivateKeyPem?: string
}
export function currentOfflineTaskScope(db:DB,roundId:string){
  const round=getRound(db,roundId);if(!round)throw httpError(404,'监测期次不存在','ROUND_NOT_FOUND');const items=Array.isArray(round.items)?round.items:[]
  const fingerprint=createHash('sha256').update(JSON.stringify({assignmentUpdatedAt:round.assignment_updated_at||round.created_at,assigneeIds:round.sampler_ids,dueDate:round.due_date,planDate:round.plan_date,items})).digest('hex')
  let version=db.prepare(`SELECT fingerprint,ordinal FROM offline_task_versions WHERE round_id=?`).get(round.id) as any
  if(!version){db.prepare(`INSERT INTO offline_task_versions(round_id,fingerprint,ordinal,updated_at) VALUES(?,?,1,?)`).run(round.id,fingerprint,new Date().toISOString());version={fingerprint,ordinal:1}}
  else if(version.fingerprint!==fingerprint){db.prepare(`UPDATE offline_task_versions SET fingerprint=?,ordinal=ordinal+1,updated_at=? WHERE round_id=?`).run(fingerprint,new Date().toISOString(),round.id);version={fingerprint,ordinal:Number(version.ordinal)+1}}
  const taskVersionOrdinal=Number(version.ordinal)
  return{taskVersion:`${round.id}@${taskVersionOrdinal}:${fingerprint.slice(0,16)}`,taskVersionOrdinal,ruleVersion:activeOfflineRuleVersion(db)}
}
export function currentOfflineValidationScope(db:DB,roundId:string){
  const round=getRound(db,roundId);if(!round)throw httpError(404,'监测期次不存在','ROUND_NOT_FOUND')
  const sequence=new Map<string,number>(),sampleSlotIds=(Array.isArray(round.items)?round.items:[]).flatMap((item:any)=>Array.from({length:Math.max(0,Number(item.qty)||0)},()=>{const matrix=String(item.matrix||'样品'),next=(sequence.get(matrix)??0)+1;sequence.set(matrix,next);return`${round.id}:${matrix}:${next}`}))
  return{sampleSlotIds,samplingDate:round.plan_date||round.due_date}
}

export function deviceBindingFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('invalid device binding key')
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}

// 首张冻结表 tracer bullet。生产能力默认关闭；全局 gate 仅允许继续核验，不能替代逐请求设备证明。
export function issueOfflineTaskPackage(db: DB, roundId: string, actor: User, policy: OfflinePackagePolicy = {}) {
  const round = getRound(db, roundId)
  if (!round) throw httpError(404, '监测期次不存在', 'ROUND_NOT_FOUND')
  if (!hasRole(actor, 'sampler') || round.assignment_status !== 'active'
    || round.sampler_ids.filter(id => id === actor.username).length !== 1) {
    throw httpError(403, '只有当前受派采样员可以取得可写离线包', 'OFFLINE_ASSIGNEE_REQUIRED')
  }
  if (!policy.offlineWriteEnabled || !policy.sensitiveOfflinePackageEnabled) {
    throw httpError(403, '离线填写尚未通过生产门槛', 'OFFLINE_GATE_CLOSED')
  }
  if (!policy.signedFormRuleApproved) throw httpError(403, '首张表规则尚未取得签名批准', 'FORM_RULE_NOT_APPROVED')
  if (!policy.signingPrivateKeyPem) throw httpError(503, '离线任务签名服务未配置', 'OFFLINE_SIGNING_UNAVAILABLE')
  let privateKey
  try { privateKey = createPrivateKey(policy.signingPrivateKeyPem) } catch { throw httpError(503, '离线任务签名密钥无效', 'OFFLINE_SIGNING_UNAVAILABLE') }
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw httpError(503, '离线任务签名密钥必须为 P-256', 'OFFLINE_SIGNING_UNAVAILABLE')
  }
  const device = policy.verifyManagedDevice?.(actor, roundId)
  let verifiedBindingFingerprint = ''
  try { if (device?.bindingPublicKeySpki) verifiedBindingFingerprint = deviceBindingFingerprint(device.bindingPublicKeySpki) } catch { /* deny below */ }
  if (!device?.deviceId || !device.trustedUntil || !device.attestationId || !device.bindingPublicKeySpki || !device.bindingFingerprint
    || verifiedBindingFingerprint !== device.bindingFingerprint) {
    throw httpError(403, '当前设备没有可验证的受管设备证明', 'MANAGED_DEVICE_REQUIRED')
  }
  const now = (policy.now ?? (() => new Date()))()
  const issuedAt = now.toISOString()
  const trustedUntil = new Date(device.trustedUntil)
  if (!Number.isFinite(trustedUntil.getTime()) || trustedUntil.getTime() <= now.getTime()) {
    throw httpError(403, '受管设备证明已过期', 'MANAGED_DEVICE_REQUIRED')
  }
  const expiresAt = new Date(Math.min(trustedUntil.getTime(), now.getTime() + 24 * 3600_000)).toISOString()
  const items = Array.isArray(round.items) ? round.items : []
  const sampleSlots = ensureSampleSlots(db,roundId,items)
  const {taskVersion,taskVersionOrdinal,ruleVersion}=currentOfflineTaskScope(db,roundId)
  const authorization = {
    scope: 'field-draft-write' as const,
    deviceId: device.deviceId,
    attestationId: device.attestationId,
    nonce: randomUUID(),
    issuedAt,
    serverTime: issuedAt,
    expiresAt,
  }
  const signedPayload = {
    schemaVersion: 1 as const,
    roundId,
    assigneeId: actor.username,
    deviceId: device.deviceId,
    deviceBindingPublicKeySpki: device.bindingPublicKeySpki,
    deviceBindingFingerprint: device.bindingFingerprint,
    formCode: 'HJ-TC-136' as const,
    ruleVersion,
    taskVersion,
    taskVersionOrdinal,
    samplingDate: round.plan_date || round.due_date,
    sampleSlots,
    formSchema: {
      globalFields: ['org', 'orgSign', 'samplingDate'],
      rowFields: ['sampleSlotId', 'sampleNo', 'point', 'time', 'item', 'volume', 'preserve', 'waterColor', 'smell', 'oil', 'floating', 'anomaly', 'note'],
    },
    authorization,
  }
  const signature = sign('sha256', Buffer.from(JSON.stringify(signedPayload)), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url')
  return { signedPayload, signature }
}
// —— 现场记录冻结闸：收样入库（done）/期次已终止（cancelled）或本期报告已签发（未作废）后，现场记录不能再改 ——
function assertRoundFieldEditable(db: DB, r: Round) {
  if (r.status === 'done') throw new Error('期次已收样入库，现场记录已冻结，不能再改')
  if (r.status === 'cancelled') throw new Error('这一期已终止，现场记录已冻结，不能再填写')
  const rep = db.prepare(`SELECT 1 FROM reports WHERE round_id=? AND status='issued' AND voided=0 LIMIT 1`).get(r.id)
  if (rep) throw new Error('该期报告已签发，现场记录已冻结，不能再改；要改请先作废报告')
}
// —— 现场记录归属闸：只有本期派工采样员能填（按姓名比对，与 confirmRoundField 口径一致）；tech/admin 在路由层放行 ——
function assertRoundSampler(db: DB, r: Round, actor: { name: string; username?: string }) {
  // HTTP 会话一定有 username；无 username 仅兼容老的内部调用/测试，并且只允许唯一姓名命中。
  const actorId = actor.username || (() => {
    const matches = r.sampler_ids.filter(id => getUser(db, id)?.name === actor.name)
    return matches.length === 1 ? matches[0] : ''
  })()
  if (r.assignment_status !== 'active' || !actorId || !r.sampler_ids.includes(actorId)) {
    throw httpError(403, '无权访问该期次：需要当前有效派工或期次管理权限', 'ROUND_FORBIDDEN')
  }
}
// 现场采样原始记录：采样日期/天气/气温 + 现场质控（全程序空白·现场平行）
// actor/guard 由路由层传（老调用/单测可省略：省 guard 则不做归属校验，与 saveRecord 的 guard 约定一致）
export function saveRoundField(db: DB, roundId: string, info: any, actor?: { name: string; username?: string }, guard?: { supervisor: boolean }): Round {
  const r = getRound(db, roundId)
  if (!r) throw new Error('监测期次不存在')
  assertRoundFieldEditable(db, r)
  if (guard && !guard.supervisor) assertRoundSampler(db, r, actor!)
  // 留痕只记变更字段的旧值→新值（不塞整个 body），上限 50 条防膨胀
  const { confirms: _oldCompatConfirms, confirmation_users: _oldConfirmationUsers, ...old } = r.field_info || {}
  // 确认身份只取会话 actor，客户端提交的姓名/ID 确认字段一律忽略。
  const { confirms: _clientConfirms, confirmations: _clientConfirmations, confirmation_users: _clientConfirmationUsers, ...clientInfo } = info ?? {}
  const neu = { ...clientInfo, ...(old.confirmations ? { confirmations: old.confirmations } : {}) }
  const changes: { field: string; from: any; to: any }[] = []
  for (const k of new Set([...Object.keys(old), ...Object.keys(neu)])) {
    if (JSON.stringify(old[k] ?? '') !== JSON.stringify(neu[k] ?? '')) changes.push({ field: k, from: old[k] ?? '', to: neu[k] ?? '' })
  }
  db.prepare(`UPDATE rounds SET field_info=? WHERE id=?`).run(JSON.stringify(neu), roundId)
  if (actor) logAction(db, roundId, actor as User, 'round_field', { changes: changes.slice(0, 50), total: changes.length })
  return getRound(db, roundId)!
}

// —— 期次现场表单：采样员在现场按精确版式填的采样原始记录（一期一表号一份）——
export type RoundSheet = { id: string; round_id: string; template_code: string; data: any; who: string; username: string | null; updated_at: string }

export function saveRoundSheet(db: DB, roundId: string, code: string, data: any, actor: { name: string; username?: string }, baseUpdatedAt?: string, guard?: { supervisor: boolean }): RoundSheet {
  const r = getRound(db, roundId)
  if (!r) throw new Error('监测期次不存在')
  if (!code) throw new Error('表号必填')
  assertRoundFieldEditable(db, r)                     // 冻结：收样入库/报告签发后不能再改现场记录
  if (guard && !guard.supervisor) assertRoundSampler(db, r, actor)  // 归属：只有本期派工采样员能填（tech/admin 放行）
  // 乐观锁：两名采样员现场同填一张采样单是常态，后保存的不许把前一个人的行悄悄抹掉
  const cur = getRoundSheet(db, roundId, code)
  if (cur && baseUpdatedAt !== undefined && cur.updated_at !== baseUpdatedAt) {
    throw new Error(`这张采样单在你打开后已被「${cur.who}」保存过（${cur.updated_at.slice(0, 16).replace('T', ' ')}），为防覆盖已阻止本次保存。请刷新看最新内容，把你填的部分补进去再存`)
  }
  const at = now()
  db.prepare(
    `INSERT INTO round_sheets (id, round_id, template_code, data, who, username, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(round_id, template_code) DO UPDATE SET data=excluded.data, who=excluded.who, username=excluded.username, updated_at=excluded.updated_at`
  ).run(randomUUID(), roundId, code, JSON.stringify(data ?? {}), actor.name, actor.username ?? null, at)
  // 留痕带逐格 diff（复用 diffData：行/组分/表级字段都覆盖），上限 50 条防膨胀
  const changes = diffData(cur?.data ?? {}, data ?? {})
  logAction(db, roundId, { name: actor.name, username: actor.username } as User, 'round_sheet',
    { template_code: code, changes: changes.slice(0, 50), total: changes.length })
  return getRoundSheet(db, roundId, code)!
}

// 坏行降级：一行脏 JSON 不能把整个期次的表单接口打成 500（体检25）——降级为空表并报错日志，人还能重填
function roundSheetData(r: any): any {
  try { return JSON.parse(r.data) }
  catch (e: any) {
    console.error(`[round_sheets] 数据损坏已降级为空表：round=${r.round_id} code=${r.template_code} → ${e?.message}`)
    return {}
  }
}
export function getRoundSheet(db: DB, roundId: string, code: string, actor?: User): RoundSheet | null {
  if (actor) assertRoundAccess(db, roundId, actor)
  const r = db.prepare(`SELECT * FROM round_sheets WHERE round_id=? AND template_code=?`).get(roundId, code) as any
  return r ? { ...r, data: roundSheetData(r) } : null
}

export function listRoundSheets(db: DB, roundId: string, actor?: User): RoundSheet[] {
  if (actor) assertRoundAccess(db, roundId, actor)
  const rows = db.prepare(`SELECT * FROM round_sheets WHERE round_id=? ORDER BY template_code`).all(roundId) as any[]
  return rows.map(r => ({ ...r, data: roundSheetData(r) }))
}
// 期次汇总状态（体检46）：flatMap 会把「有样品但一条记录都没有」的样品吞掉——那是「还没测」，
// 不是「不存在」。逐样品看：有任何样品零记录就不能算 approved（全空=pending，测了一半=testing）。
// 检测进度汇总只看普通样：质控样不卡主线（报告也不含质控样）。
function roundRollup(db: DB, roundId: string): string {
  // 拒收样不进检测进度（它永远不会有记录，算进来整期就永远到不了 approved）
  const normal = db.prepare(`SELECT id FROM samples WHERE round_id=? AND qc_type IS NULL AND status!='rejected'`).all(roundId) as { id: string }[]
  if (!normal.length) return 'pending'
  const perSample = normal.map(s => listRecords(db, { sampleId: s.id }))
  if (perSample.some(rs => !rs.length)) return perSample.every(rs => !rs.length) ? 'pending' : 'testing'
  return sampleRollup(perSample.flat())
}
// 列出各期，并带出这一期已建的样品数 + 汇总状态（供项目页/提醒展示）
export function listRounds(db: DB, contractId: string, actor?: User): (Round & { sample_count: number; rollup: string })[] {
  const rows = db.prepare(`SELECT * FROM rounds WHERE contract_id=? ORDER BY round_no`).all(contractId) as Round[]
  return rows.filter(r => !actor || canAccessRound(db, r.id, actor)).map(r => {
    const samples = db.prepare(`SELECT id FROM samples WHERE round_id=?`).all(r.id) as { id: string }[]
    return { ...r, ...getRound(db, r.id)!, sample_count: samples.length, rollup: roundRollup(db, r.id) }
  })
}
// ============ S4 采样环节质控规则引擎（依据《采样环节质控要求》） ============
export type QcRequirement = { qcType: string; matrix: string; qty: number; basis: string }
// 水类现场理化项目不要求全程序空白（色度/嗅/浊度/pH/透明度/电导率/溶解氧等）
const BLANK_EXEMPT_ITEMS = ['色度', '嗅', '嗅和味', '浊度', 'pH', 'pH值', '透明度', '电导率', '溶解氧']
// VOC 项目关键词：命中则该批要运输空白
const VOC_KEYWORDS = ['挥发性有机', 'VOC', '苯系物', '氯乙烯', '三氯甲烷', '四氯化碳', '三氯乙烯', '四氯乙烯', '乙苯', '苯乙烯', '二甲苯', '甲苯', '氯苯', '二氯甲烷', '氯仿']
const WATER_MATRICES = ['废水', '地表水', '地下水', '生活饮用水', '大气降水', '海水']
const AIR_MATRICES = ['环境空气', '废气', '有组织废气', '无组织废气']
const SOIL_MATRICES = ['土壤', '沉积物', '海洋沉积物']
// 空气里只采运输空白的项目（非甲烷总烃/总烃/甲烷）；臭气浓度什么空白都不要
const AIR_TRANSPORT_ONLY = ['非甲烷总烃', '总烃', '甲烷']
const AIR_NO_BLANK = ['臭气浓度']
const hasVoc = (items: string[]) => items.some(i => i === '苯' || VOC_KEYWORDS.some(k => i.includes(k)))

// 按本期待采清单算「这次现场要带多少质控样」：派工时展示，入库时照单自动建样
export function qcRequirements(entries: { matrix: string; items: string[]; qty: number }[]): QcRequirement[] {
  // 同基质多行并成一批：空白按批算（1个），平行按总数10%算
  const byMatrix = new Map<string, { items: string[]; qty: number }>()
  for (const e of entries) {
    const m = byMatrix.get(e.matrix) ?? { items: [], qty: 0 }
    m.items.push(...(e.items || [])); m.qty += Math.max(1, e.qty || 1)
    byMatrix.set(e.matrix, m)
  }
  const reqs: QcRequirement[] = []
  for (const [matrix, { items, qty }] of byMatrix) {
    const voc = hasVoc(items)
    if (WATER_MATRICES.includes(matrix)) {
      if (!items.every(i => BLANK_EXEMPT_ITEMS.includes(i)))
        reqs.push({ qcType: '全程序空白', matrix, qty: 1, basis: '水/废水每批1个（现场理化项目除外）' })
      if (voc) reqs.push({ qcType: '运输空白', matrix, qty: 1, basis: '水中VOC项目每批加运输空白' })
      reqs.push({ qcType: '现场平行', matrix, qty: Math.max(1, Math.ceil(qty * 0.1)), basis: '现场平行≥10%（量少至少1份)' })
    } else if (AIR_MATRICES.includes(matrix)) {
      const testable = items.filter(i => !AIR_NO_BLANK.includes(i))
      if (!testable.length) continue                                    // 只测臭气浓度：不需要空白
      if (testable.every(i => AIR_TRANSPORT_ONLY.includes(i))) {
        reqs.push({ qcType: '运输空白', matrix, qty: 1, basis: '非甲烷总烃/总烃/甲烷只采运输空白' })
      } else {
        reqs.push({ qcType: '全程序空白', matrix, qty: 1, basis: '环境空气/废气每批≥1个全程序空白' })
        if (voc) reqs.push({ qcType: '运输空白', matrix, qty: 1, basis: '空气VOC项目加运输空白' })
      }
    } else if (SOIL_MATRICES.includes(matrix)) {
      if (voc) {
        reqs.push({ qcType: '运输空白', matrix, qty: 1, basis: '土壤VOC：运输空白+全程序空白双份（HJ605/HJ1020）' })
        reqs.push({ qcType: '全程序空白', matrix, qty: 1, basis: '土壤VOC：运输空白+全程序空白双份（HJ605/HJ1020）' })
      }
      const minPara = matrix === '海洋沉积物' ? 2 : (voc ? 2 : 1)       // 海洋沉积物同点位采双样；土壤VOC 2份平行
      reqs.push({ qcType: '现场平行', matrix, qty: Math.max(minPara, Math.ceil(qty * 0.1)), basis: matrix === '海洋沉积物' ? '同点位采2~3次混匀分装，现场双样' : '现场平行≥10%' })
    }
    // 固废：份样数按吨位另查表（solidWasteMinPortions），噪声：无质控样
  }
  return reqs
}
// 固废最小份样数查表（HJ 298-2019：≤5t→5 … >1000t→100）
const SOLID_WASTE_PORTIONS: [number, number][] = [[5, 5], [25, 8], [50, 13], [90, 20], [150, 32], [500, 50], [1000, 80]]
export function solidWasteMinPortions(tons: number): number {
  for (const [cap, n] of SOLID_WASTE_PORTIONS) if (tons <= cap) return n
  return 100
}
// 某期次的质控要求清单（派工/详情页展示用）
export function roundQcRequirements(db: DB, roundId: string): QcRequirement[] {
  const round = getRound(db, roundId)
  if (!round) throw new Error('监测期次不存在')
  const c = getContract(db, round.contract_id)
  const plan = round.items?.length ? round.items : (c?.plan ?? [])
  return qcRequirements(plan)
}
// 噪声专项入库拦截：测前测后校准偏差>0.5dB结果无效；气象条件必填、风速<5m/s
function checkNoiseGate(field: any) {
  const f = field || {}
  if (f.calBefore == null || f.calAfter == null || f.calBefore === '' || f.calAfter === '')
    throw new Error('噪声采样必须先在现场记录里录「测前/测后校准值」')
  const dev = Math.abs(Number(f.calAfter) - Number(f.calBefore))
  if (!(dev <= 0.5)) throw new Error(`声级计测前测后校准偏差 ${dev.toFixed(1)}dB > 0.5dB，本期结果无效，不能入库——需重新监测`)
  if (!String(f.weather || '').trim()) throw new Error('噪声监测气象条件必填：先在现场记录里填天气（无雨雪、无雷电）')
  if (f.wind != null && f.wind !== '' && Number(f.wind) >= 5) throw new Error(`风速 ${f.wind}m/s ≥ 5m/s，不符合噪声监测气象条件，不能入库`)
}

// §8.3 两人采样：每名派工采样员都要在系统里确认采样表，全员确认后才能收样入库
export function confirmRoundField(db: DB, roundId: string, actor: { name: string; username?: string }): Round {
  const r = getRound(db, roundId)
  if (!r) throw new Error('监测期次不存在')
  if (r.status === 'done') throw new Error('该期已收样入库，无需再确认')
  if (r.status === 'cancelled') throw new Error('这一期已终止，不用再确认采样表')
  assertRoundSampler(db, r, actor)
  const actorId = actor.username || r.sampler_ids.find(id => getUser(db, id)?.name === actor.name)!
  const info = r.field_info || {}
  const confirmations: Record<string, { name: string; at: string }> = { ...(info.confirmations || {}) }
  if (confirmations[actorId]) throw new Error('你已确认过采样表')
  confirmations[actorId] = { name: actor.name, at: now() }
  const { confirms: _legacyConfirms, confirmation_users: _confirmationUsers, ...storedInfo } = info
  db.prepare(`UPDATE rounds SET field_info=? WHERE id=?`).run(JSON.stringify({ ...storedInfo, confirmations }), roundId)
  logAction(db, roundId, actor as User, 'round_field_confirm', { user_id: actorId, display_name: actor.name })
  return getRound(db, roundId)!
}

// 某一期「现场采样→收样入库」：按本期清单建一批样品（挂 round_id），并按质控规则自动建质控样、
// 给每个样品自动写「采样交接」记录（交接单/照片可在样品页挂附件），期次转已采
export function sampleRound(db: DB, roundId: string, actorOrYear: { name: string; username?: string } | number = { name: '系统' }, year = new Date().getFullYear(), opts?: { supervisor?: boolean }): Sample[] {
  // 兼容旧签名 sampleRound(db, id, 2026)：第3位传数字就当年份（旧调用视作监督放行，不卡双确认）
  const actor = typeof actorOrYear === 'number' ? { name: '系统' } : actorOrYear
  const supervisor = typeof actorOrYear === 'number' ? true : (opts?.supervisor ?? actor.name === '系统')
  if (typeof actorOrYear === 'number') year = actorOrYear
  const round = getRound(db, roundId)
  if (!round) throw new Error('监测期次不存在')
  if (!supervisor) assertRoundSampler(db, round, actor)
  const existing = listSamplesByRound(db, roundId)
  if (round.status === 'done') return existing   // 幂等：这一期已采过就不重复建
  // 终态/异常态先拦（体检12/37）：终止的期次不许收样；标了采不成必须先改期，不能跳过直接收样
  if (round.status === 'cancelled') throw new Error('这一期已终止，不能收样入库')
  if (round.status === 'failed') throw new Error('这期标了采不成，先改期再收样')
  assertContractNotTerminated(db, round.contract_id, '收样入库')   // 体检15：终止合同拦新动作
  // 有样品但期次没到 done = 历史半截数据（本函数已包事务，今后不会再产生）；报出来别装已采过
  if (existing.length) throw new Error(`这一期已有 ${existing.length} 个样品但入库没走完（历史异常），请联系管理员核对后处理`)
  if (!round.sampler) throw new Error('本期还没派工，不能收样入库——先在「排产派工」选采样员')
  const c = getContract(db, round.contract_id)
  if (!c) throw new Error('合同不存在')
  // 体检38：方案改回草稿/被打回期间不许收样（没方案的老数据/快速登记路径放行，维持现状）
  if (c.scheme && c.scheme.status !== 'approved') throw new Error('方案还没批准，先让技术负责人审完再排采样')
  // 只采「本期到期」的项目（各项周期不同），本期清单在 round.items；旧数据兜底用合同全计划
  const plan = round.items?.length ? round.items : c.plan
  // 新版现场工作流一旦持久化了选表信息，每个计划基质都必须有一张真正保存的采样单。
  // 完全没有选表结构的历史期次不追溯阻断；旧 field.sheets 和旧 round_sheets 均算已填。
  const fieldInfo = round.field_info || {}
  const storedSheetCodes = new Set((db.prepare(`SELECT template_code FROM round_sheets WHERE round_id=?`).all(roundId) as any[]).map(x => String(x.template_code)))
  const hasSheetWorkflow = !!fieldInfo.sheetCodes || !!fieldInfo.sheets || storedSheetCodes.size > 0
  if (hasSheetWorkflow) {
    const matrices = [...new Set(plan.map(p => p.matrix).filter(Boolean))]
    const legacyUnmappedSheetsCoverAll = !fieldInfo.sheetCodes && !fieldInfo.sheets && storedSheetCodes.size >= matrices.length
    const missing = legacyUnmappedSheetsCoverAll ? [] : matrices.filter(matrix => {
      if (fieldInfo.sheets?.[matrix]?.code) return false
      const selected = Array.isArray(fieldInfo.sheetCodes?.[matrix]) ? fieldInfo.sheetCodes[matrix].filter(Boolean) : []
      return !selected.some((code: string) => storedSheetCodes.has(code) || fieldInfo.sheetDrafts?.[code])
    })
    if (missing.length) throw new Error(`${missing.join('、')}还没有保存采样单，请至少选择并保存一张后再收样入库`)
  }
  if (plan.some(p => p.matrix === '噪声')) checkNoiseGate(round.field_info)
  // 决策1：采样地点必须体现——已建点位档案的合同，计划行缺点位不许入库（老合同无点位档案的放行）
  if (listPoints(db, c.id).length && plan.some(p => !(p as any).point)) {
    throw new Error('本期清单有计划行没写点位，不能收样入库——请在方案里给每行填上点位（采样地点必须体现）')
  }
  // §8.3 两人采样双确认：每名派工采样员都在系统里确认过采样表才能入库（tech/admin 兜底放行）
  if (!supervisor) {
    const confirmations = round.field_info?.confirmations || {}
    const missingIds = round.sampler_ids.filter(id => !confirmations[id])
    const assignedNames = round.sampler_ids.map(id => getUser(db, id)?.name ?? id)
    const missing = missingIds.map(id => {
      const name = getUser(db, id)?.name ?? id
      return assignedNames.filter(x => x === name).length > 1 ? `${name}（${id}）` : name
    })
    if (missing.length) {
      throw new Error(`采样表还差 ${missing.join('、')} 确认——两人采样要求每名采样员都在系统里确认后才能收样入库`)
    }
  }
  // 建样+质控样+交接+转已采是一个整体：中途失败全部回滚，不留半截
  return inTx(db, () => {
    const made: Sample[] = []
    for (const p of plan) {
      // 点位档案：计划行带点位名 → 取/建点位（拿到 P 码进样品编号；报告溯源用实际位置）
      const pt = (p as any).point ? upsertPoint(db, c.id, { name: (p as any).point, matrix: p.matrix, source: 'contract' }) : null
      for (let i = 0; i < Math.max(1, p.qty || 1); i++) {
        made.push(createSample(db, {
          client: c.client, matrix: p.matrix, items: p.items, note: `第${round.round_no}期`,
          contractId: c.id, roundId, pointName: pt?.name, pointCode: pt?.code,
        }, year))
      }
    }
    // 质控样：按规则引擎照单建号，与普通样同期次关联（round_id + qc_type）
    const itemsOf = (matrix: string) => [...new Set(plan.filter(p => p.matrix === matrix).flatMap(p => p.items || []))]
    for (const req of qcRequirements(plan)) for (let i = 0; i < req.qty; i++) {
      made.push(createSample(db, { client: c.client, matrix: req.matrix, items: itemsOf(req.matrix), note: `第${round.round_no}期·${req.qcType}`, contractId: c.id, roundId, qcType: req.qcType }, year))
    }
    // 采样交接：每个样品自动生成一条（采样员→实验室），完成 CMA 采样-交接闭环
    for (const s of made) {
      addHandover(db, s.id, { action: '采样交接', fromPerson: round.sampler, condition: '完好', note: `第${round.round_no}期现场采样交接` }, actor)
    }
    // 交接单（批次一）：整期聚成一张单（草稿），采样员可改后发质控员整单签收
    createHandoverSheetForRound(db, round, made, year)
    markRoundDone(db, roundId)
    return made
  })
}
function listSamplesByRound(db: DB, roundId: string): Sample[] {
  return (db.prepare(`SELECT * FROM samples WHERE round_id=? ORDER BY id`).all(roundId) as any[]).map(r => ({ ...r, items: safeJson(r.items, []) }))
}
// 采不成：企业停产/天气等去了采不到，标未采成 + 记原因。已采样的期次不能标。
// S4 状态机：没派工就没人去现场，谈不上"采不成"——必须先派工
export function failRound(db: DB, roundId: string, reason: string): Round {
  const r = getRound(db, roundId)
  if (!r) throw new Error('监测期次不存在')
  if (r.status === 'done') throw new Error('该期已采样，不能标未采成')
  if (r.status === 'cancelled') throw new Error('这一期已终止，不能再标未采成')
  if (!r.sampler) throw new Error('本期还没派工——先派工，采样员去了现场采不成才标未采成')
  if (!reason?.trim()) throw new Error('未采成原因必填')
  db.prepare(`UPDATE rounds SET status='failed', fail_reason=? WHERE id=?`).run(reason.trim(), roundId)
  return getRound(db, roundId)!
}

// 未采成后改期：换新采样日期、转「已改期」状态（决策12 状态机 failed→rescheduled，统计可区分）；
// 原定日期留痕，清掉未采成原因。多次改期只保留最初的原定日期。
export function rescheduleRound(db: DB, roundId: string, newDate: string): Round {
  const r = getRound(db, roundId)
  if (!r) throw new Error('监测期次不存在')
  if (r.status !== 'failed') throw new Error('只有未采成的期次能改期，请先标未采成')
  const nd = cleanDate(newDate, '新采样日期')
  if (!nd) throw new Error('新采样日期必填')
  const orig = r.orig_due_date || r.due_date
  db.prepare(`UPDATE rounds SET status='rescheduled', due_date=?, orig_due_date=?, fail_reason=NULL WHERE id=?`)
    .run(nd, orig, roundId)
  return getRound(db, roundId)!
}

// 期次终止（体检12）：确认这一期不再采了（企业注销/常年停产等），failed → cancelled 终态。
// 终态含义：不再派工/收样/填表，不再进到期提醒，不卡合同总报告和主线进度。
export function cancelRound(db: DB, roundId: string, reason: string, actor: User | { name: string; username?: string }): Round {
  const r = getRound(db, roundId)
  if (!r) throw new Error('监测期次不存在')
  if (r.status === 'cancelled') throw new Error('这一期已经终止过了')
  // 放宽（2026-08-01）：没派工的期次也能直接终止（企业注销/常年停产在派工前就知道），
  // 不必先谎报"采不成"绕一圈；已采完（done）的仍不能终止。
  if (!['failed', 'pending', 'rescheduled'].includes(r.status)) throw new Error('这一期已采样入库，不能终止')
  if (!reason?.trim()) throw new Error('终止原因必填')
  db.prepare(`UPDATE rounds SET status='cancelled', assignment_status='revoked', assignment_updated_at=? WHERE id=?`).run(now(), roundId)
  logAction(db, roundId, actor as User, 'round_cancel', { reason: reason.trim(), fail_reason: r.fail_reason })
  return getRound(db, roundId)!
}

// 决策：采样日期可正常微调（客户要求改期不用谎报「采不成」）；只限还没采的期次，改动留痕
export function adjustRoundDue(db: DB, roundId: string, newDate: string, actor: User | { name: string; username?: string }): Round {
  const r = getRound(db, roundId)
  if (!r) throw new Error('监测期次不存在')
  if (r.status === 'done') throw new Error('该期已采样，不能再改日期')
  if (r.status === 'cancelled') throw new Error('这一期已终止，不能再改日期')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate || '')) throw new Error('新日期格式应为 YYYY-MM-DD')
  if (newDate === r.due_date) return r
  const orig = r.orig_due_date || r.due_date
  db.prepare(`UPDATE rounds SET due_date=?, orig_due_date=? WHERE id=?`).run(newDate, orig, roundId)
  logAction(db, roundId, actor as User, 'round_adjust', { from: r.due_date, to: newDate })
  return getRound(db, roundId)!
}

// 期次派工：采样员可多人（CMA 现场采样要求≥2人，是否强制由前端提示），存顿号串；兼容旧的单人字符串
export function assignRound(db: DB, roundId: string, samplers: string | string[], planDate = ''): Round {
  { const _r = getRound(db, roundId); if (_r) assertNotVetoed(db, _r.contract_id, '派工') }
  const r = getRound(db, roundId)
  if (!r) throw new Error('监测期次不存在')
  if (r.status === 'cancelled') throw new Error('这一期已终止，不能再派工')
  assertContractNotTerminated(db, r.contract_id, '派工')   // 体检15
  // 体检38：方案改回草稿/被打回期间不许派工（没方案的老数据放行）
  const scheme = getScheme(db, r.contract_id)
  if (scheme && scheme.status !== 'approved') throw new Error('方案还没批准，先让技术负责人审完再排采样')
  const requested = (Array.isArray(samplers) ? samplers : [samplers]).map(s => (s || '').trim()).filter(Boolean)
  if (!requested.length) throw new Error('采样员必选')
  // 新客户端传不可变 username；老客户端仍可传姓名，但只有唯一命中时才兼容解析，重名绝不猜。
  const candidates = listSamplers(db)
  const selected = requested.map(value => {
    const byId = candidates.find(u => u.username === value)
    if (byId) return byId
    const byName = candidates.filter(u => u.name === value)
    if (byName.length > 1) throw httpError(409, `姓名「${value}」对应多个在职采样员，请刷新人员列表并按用户 ID 派工`)
    if (byName.length === 1) return byName[0]
    throw new Error(`「${value}」不是在职采样员——请核对用户 ID，或先在人员台账给同事挂上「采样员」岗位`)
  })
  const ids = [...new Set(selected.map(u => u.username))]
  const names = ids.map(id => selected.find(u => u.username === id)!.name)
  const pd = cleanDate(planDate, '约定采样日') ?? ''   // 体检39：脏日期不入库
  let fieldInfo = r.field_info
  if (fieldInfo) {
    const { confirms: _oldConfirms, confirmation_users: _oldConfirmationUsers, ...storedFieldInfo } = fieldInfo
    if (JSON.stringify(r.sampler_ids) !== JSON.stringify(ids)) {
      const { confirmations: _oldConfirmations, ...withoutOldConfirmations } = storedFieldInfo
      fieldInfo = withoutOldConfirmations
    } else {
      fieldInfo = storedFieldInfo
    }
  }
  db.prepare(`UPDATE rounds SET sampler=?, sampler_ids=?, assignment_status='active', assignment_updated_at=?, plan_date=?, field_info=? WHERE id=?`)
    .run(names.join('、'), JSON.stringify(ids), now(), pd, fieldInfo == null ? null : JSON.stringify(fieldInfo), roundId)
  return getRound(db, roundId)!
}
// 全部期次（采样派工页主列表）：带客户/项目 + 样品数/汇总状态 + 到期分桶
export function listAllRounds(db: DB, today = todayLocal(), actor?: User) {
  const rows = db.prepare(
    `SELECT r.*, c.client, c.project FROM rounds r JOIN contracts c ON c.id=r.contract_id ORDER BY r.due_date`
  ).all() as any[]
  const soonLine = addDays(today, 14)
  return rows.filter(r => !actor || canAccessRound(db, r.id, actor)).map(r => {
    const hydrated = getRound(db, r.id)!
    const samples = listSamplesByRound(db, r.id)
    return {
      ...r, ...hydrated, sample_count: samples.length,
      rollup: roundRollup(db, r.id),   // 体检46：无记录样品不再被吞掉误亮绿灯
      // cancelled 是终态（体检12）：不再算逾期/临期
      bucket: (r.status === 'done' || r.status === 'cancelled') ? 'done' : (r.due_date < today ? 'overdue' : (r.due_date <= soonLine ? 'soon' : 'later')),
    }
  })
}
// 期次详情：合同 + 待采清单 + 该期已入库样品（带各自进度）
export function getRoundDetail(db: DB, roundId: string, actor?: User) {
  const round = actor ? assertRoundAccess(db, roundId, actor) : getRound(db, roundId)
  if (!round) throw httpError(404, '监测期次不存在', 'ROUND_NOT_FOUND')
  const contract = getContract(db, round.contract_id)
  const samples = listSamplesByRound(db, roundId).map(s => ({ ...s, rollup: sampleRollup(listRecords(db, { sampleId: s.id })) }))
  // 待采清单 = 本期到期的项目（不是合同全部计划）
  const planItems = (round.items?.length ? round.items : contract?.plan ?? []).map((p: any, i: number) => ({ id: i, matrix: p.matrix, items: p.items, qty: p.qty, point: p.point || '' }))
  return { round, contract, planItems, samples }
}
// 该期报告是否已签发：期次报告（一期一份）或该期每个样品都有已签发的单样报告（兼容旧数据）。
// 作废的报告不算数（体检21）：作废后进度条要退回「待出报告」，与报告页口径一致（冻结逻辑同样排 voided）
function roundReportIssued(db: DB, roundId: string): boolean {
  const issued = listReports(db).filter(r => r.status === 'issued' && !r.voided)
  if (issued.some(r => r.round_id === roundId)) return true
  const samples = listSamplesByRound(db, roundId).filter(s => !s.qc_type)
  return samples.length > 0 && samples.every(s => issued.some(r => r.sample_id === s.id))
}
// 按方案的周期+有效期排出每一期采样日期（幂等：已排过不重排）
// 排期：合同有效期内，样品计划每一行各按自己的周期排采样日；把各行的日期合并成期次，
// 同一天到期的项目并进同一期（第N期只采「本期到期」的项目，各项周期可不同）。
type RoundEntry = { matrix: string; items: string[]; qty: number; point?: string }
// 按合同有效期 + 样品计划各行周期，算出「日期 -> 本期该采的项目行」（同天到期并进同一期）
function scheduleDates(c: Contract, s: Scheme): Map<string, RoundEntry[]> {
  const dateMap = new Map<string, RoundEntry[]>()
  const start = c.period_start || s.period_start
  if (!start) return dateMap
  const end = c.period_end || s.period_end || start
  const push = (date: string, entry: RoundEntry) => {
    if (!dateMap.has(date)) dateMap.set(date, [])
    dateMap.get(date)!.push(entry)
  }
  for (const row of c.plan) {
    const entry = { matrix: row.matrix, items: row.items, qty: Math.max(1, row.qty || 1), point: (row as any).point || '' }
    // 报价「每年N次」精确排期：一年正好 N 期、月份均匀分布（floor 取整：5次/年 → 第1,3,5,8,10月），
    // 不再用 12/N 取整的固定间隔（那会让 5次/年 实排 6~7 期）。老计划行没有 per_year → 走原 cycle_months 逻辑。
    const perYear = Number(row.per_year)
    if (Number.isFinite(perYear) && perYear >= 1) {
      let prev = ''
      for (let k = 0; k < 2400; k++) {                 // 上限 200 年，防脏数据死循环
        const d = addMonths(start, Math.floor(12 * k / perYear))
        if (d > end) break
        if (d !== prev) push(d, entry)                 // perYear>12 时同月去重（排期粒度到月）
        prev = d
      }
      continue
    }
    const cyc = row.cycle_months || s.cycle_months || 0   // 每行自己的周期；没设则回退用方案的整单周期
    if (cyc <= 0) { push(start, entry); continue }
    for (let k = 0; k < 240; k++) {
      const d = addMonths(start, cyc * k)
      if (d > end) break
      push(d, entry)
    }
  }
  return dateMap
}
export function generateRounds(db: DB, contractId: string): Round[] {
  const c = getContract(db, contractId)
  const s = c?.scheme
  if (!c || !s || s.status !== 'approved') return listRounds(db, contractId)
  if (!(c.period_start || s.period_start)) return listRounds(db, contractId)
  if ((db.prepare(`SELECT COUNT(*) n FROM rounds WHERE contract_id=?`).get(contractId) as any).n > 0) return listRounds(db, contractId)

  const dateMap = scheduleDates(c, s)
  const dates = [...dateMap.keys()].sort()
  let no = 1
  for (const d of dates) {
    db.prepare(`INSERT INTO rounds (id, contract_id, round_no, due_date, items, status, created_at) VALUES (?,?,?,?,?,'pending',?)`)
      .run(`${contractId}-R${String(no).padStart(2, '0')}`, contractId, no, d, JSON.stringify(dateMap.get(d)), now())
    no++
  }
  return listRounds(db, contractId)
}
// S2 问题9：方案改后重新批准的重排。未派工且未采(pending 无 sampler)的期次删掉按新排期重建；
// 已派工/已采/未采成/已终止的期次一律保留（其日期不再重排，避免撞期），非终态的计入「需人工确认」。
// 体检11：待派工期次上挂着现场表单（round_sheets）或期次附件的不能删——删了表和照片就成孤儿。
// 这类期次保留原 id，只把应采日期挪到新排期上；干净的期次照旧删了重建。保留动作写留痕。
export function reschedulePendingRounds(db: DB, contractId: string): { rescheduled: number; manual: number } {
  const c = getContract(db, contractId)
  const s = c?.scheme
  if (!c || !s || s.status !== 'approved') return { rescheduled: 0, manual: 0 }
  const existing = db.prepare(`SELECT * FROM rounds WHERE contract_id=?`).all(contractId) as any[]
  const keep = existing.filter(r => r.status === 'done' || r.status === 'failed' || r.status === 'cancelled' || (r.sampler && r.sampler !== ''))
  const manual = keep.filter(r => r.status !== 'done' && r.status !== 'cancelled').length   // 已派工/未采成但没完成 → 提示人工
  const keepDates = new Set(keep.map(r => r.due_date))
  const keepIds = new Set(keep.map(r => r.id))
  const hasFieldData = (id: string) =>
    !!db.prepare(`SELECT 1 FROM round_sheets WHERE round_id=? LIMIT 1`).get(id) ||
    !!db.prepare(`SELECT 1 FROM attachments WHERE entity_type='round' AND entity_id=? AND deleted_at IS NULL LIMIT 1`).get(id) ||
    !!db.prepare(`SELECT 1 FROM attachments WHERE entity_type='round_sheet' AND substr(entity_id,1,length(?) + 2)=? || '::' AND deleted_at IS NULL LIMIT 1`).get(id, id)
  const pending = existing.filter(r => !keepIds.has(r.id))                  // 待派工待采：候删
  const dirty = pending.filter(r => hasFieldData(r.id)).sort((a, b) => (a.due_date < b.due_date ? -1 : 1))
  const dirtyIds = new Set(dirty.map(r => r.id))
  // 先删后插包事务：中途失败不能把待采期次删丢
  let rescheduled = 0
  const kept: { id: string; from: string; to: string }[] = []
  inTx(db, () => {
    for (const r of pending) if (!dirtyIds.has(r.id)) db.prepare(`DELETE FROM rounds WHERE id=?`).run(r.id)
    let no = existing.reduce((m, r) => Math.max(m, r.round_no), 0)   // 保留期次的编号不动，新期次续号
    const queue = [...dirty]                                          // 挂了表/附件的：按日期序逐个挪到新排期
    const dates = [...scheduleDates(c, s).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    for (const [d, entries] of dates) {
      if (keepDates.has(d)) continue   // 该日期已有保留期次，不重复排
      rescheduled++
      const reuse = queue.shift()
      if (reuse) {
        if (reuse.due_date !== d) kept.push({ id: reuse.id, from: reuse.due_date, to: d })
        db.prepare(`UPDATE rounds SET due_date=?, items=? WHERE id=?`).run(d, JSON.stringify(entries), reuse.id)
      } else {
        no++
        db.prepare(`INSERT INTO rounds (id, contract_id, round_no, due_date, items, status, created_at) VALUES (?,?,?,?,?,'pending',?)`)
          .run(`${contractId}-R${String(no).padStart(2, '0')}`, contractId, no, d, JSON.stringify(entries), now())
      }
    }
    // 新排期比挂数据的期次还少：多出来的原样保留（日期不动），宁多勿删
    for (const left of queue) kept.push({ id: left.id, from: left.due_date, to: left.due_date })
  })
  if (dirty.length) {
    logAction(db, contractId, null, 'round_reschedule_keep',
      { note: '重排时这些期次挂着现场表单/附件，未删除，仅调整应采日期', kept: dirty.map(r => r.id), moves: kept })
  }
  return { rescheduled, manual }
}
export function markRoundDone(db: DB, roundId: string, planId?: string): Round {
  db.prepare(`UPDATE rounds SET status='done', sampled_at=?, plan_id=COALESCE(?,plan_id) WHERE id=?`).run(now(), planId ?? null, roundId)
  return db.prepare(`SELECT * FROM rounds WHERE id=?`).get(roundId) as Round
}
// §9 提醒4：合同快到期（30天内到期/已过期且项目未完结）——续签/收尾提醒
export function contractAlerts(db: DB, today = todayLocal()): { id: string; client: string; project: string; period_end: string; bucket: 'overdue' | 'soon' }[] {
  const soonLine = addDays(today, 30)
  const rows = db.prepare(`SELECT id, client, project, period_end FROM contracts
    WHERE status != 'terminated' AND period_end IS NOT NULL AND period_end != '' AND period_end <= ?`).all(soonLine) as any[]
  return rows
    .filter(c => {
      // 项目已全部完结（期次全在终态：done 或 cancelled）就不吵了（体检12：终止的期次不再催）
      const rounds = db.prepare(`SELECT status FROM rounds WHERE contract_id=?`).all(c.id) as any[]
      return !rounds.length || rounds.some(r => r.status !== 'done' && r.status !== 'cancelled')
    })
    .map(c => ({ ...c, bucket: c.period_end < today ? 'overdue' as const : 'soon' as const }))
}

// 全部待采期次，按到期分桶：overdue 已逾期 | soon 14天内到期 | later 以后（= 定时提醒的数据源）
export function listDueRounds(db: DB, today = todayLocal(), actor?: User) {
  const rows = db.prepare(
    `SELECT r.*, c.client, c.project, c.urgent AS urgent FROM rounds r JOIN contracts c ON c.id=r.contract_id
     WHERE r.status IN ('pending','rescheduled') AND c.status != 'terminated' ORDER BY c.urgent DESC, r.due_date`
  ).all() as any[]
  const soonLine = addDays(today, 14)
  return rows.filter(r => !actor || canAccessRound(db, r.id, actor))
    .map(r => ({ ...r, ...getRound(db, r.id)!, bucket: r.due_date < today ? 'overdue' : (r.due_date <= soonLine ? 'soon' : 'later') }))
}

export function listContracts(db: DB): Contract[] {
  const rows = db.prepare(`SELECT id FROM contracts ORDER BY created_at DESC`).all() as { id: string }[]
  return rows.map(r => getContract(db, r.id)!)
}

// 从合同一键生成样品：按计划每行 × 数量，各建一个真实样品（带回合同号+检测项目），合同转已确认
export function generateSamples(db: DB, contractId: string, year = new Date().getFullYear()): Sample[] {
  assertNotVetoed(db, contractId, '生成样品')
  const c = getContract(db, contractId)
  if (!c) throw new Error('合同不存在')
  if (c.status === 'terminated') throw new Error('合同已终止，不能再生成样品；已有数据仅供查看')   // 体检15
  if (!c.accepted_at) throw new Error('合同尚未受理，不能生成样品；请登记员先「确认受理·合同评审通过」')
  if (c.status === 'confirmed') return c.samples   // 幂等：已生成过就不重复生成
  // 事务：建样与置 confirmed 同生共死——否则中途失败重试时幂等判断不成立，整批重复建样
  return inTx(db, () => {
    const created: Sample[] = []
    for (const p of c.plan) {
      for (let i = 0; i < p.qty; i++) {
        created.push(createSample(db, {
          client: c.client, matrix: p.matrix, items: p.items, note: p.note, contractId,
        }, year))
      }
    }
    db.prepare(`UPDATE contracts SET status='confirmed' WHERE id=?`).run(contractId)
    return created
  })
}

// ============ 检测计划 / 派工 ============
// ⚠️ 概念澄清（卖同行会被问）：本节的 plans（RW 采样任务单）只服务「散样/自送样」路径；
// 周期项目的派工统一在 rounds 上（assignRound 写 rounds.sampler），不要再往 plans 上加周期逻辑。
export type Plan = {
  id: string; contract_id: string | null; client: string; sampler: string
  plan_date: string; status: string; note: string; created_at: string
}
function nextSeqId(db: DB, table: string, prefix: string): string {
  return prefix + String(maxSeq(db, table, 'id', prefix) + 1).padStart(4, '0')
}
// 检测记录人可读连号 JL2026-0001（存在 serial 列上，与内部 uuid 主键并存）
export function nextRecordSerial(db: DB, year = new Date().getFullYear()): string {
  const prefix = `JL${year}-`
  return prefix + String(maxSeq(db, 'records', 'serial', prefix) + 1).padStart(4, '0')
}
export function createPlan(db: DB, input: { contractId?: string; client?: string; sampler?: string; planDate?: string; note?: string }, year = new Date().getFullYear()): Plan {
  const id = nextSeqId(db, 'plans', `RW${year}-`)   // 采样任务单 RW2026-0001
  const status = input.sampler ? 'assigned' : 'pending'
  db.prepare(`INSERT INTO plans (id, contract_id, client, sampler, plan_date, status, note, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, input.contractId ?? null, input.client ?? '', input.sampler ?? '', input.planDate ?? '', status, input.note ?? '', now())
  return getPlan(db, id)!
}
export function planFromContract(db: DB, contractId: string, year = new Date().getFullYear()): Plan {
  const c = getContract(db, contractId)
  if (!c) throw new Error('合同不存在')
  return createPlan(db, { contractId, client: c.client, note: c.project }, year)
}
export function getPlan(db: DB, id: string): Plan | null {
  return (db.prepare(`SELECT * FROM plans WHERE id = ?`).get(id) as any) ?? null
}
export function listPlans(db: DB, status?: string): Plan[] {
  return (status
    ? db.prepare(`SELECT * FROM plans WHERE status=? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM plans ORDER BY created_at DESC`).all()) as Plan[]
}
export function assignPlan(db: DB, id: string, sampler: string, planDate: string): Plan {
  if (!getPlan(db, id)) throw new Error('计划不存在')
  db.prepare(`UPDATE plans SET sampler=?, plan_date=?, status='assigned' WHERE id=?`).run(sampler, planDate, id)
  return getPlan(db, id)!
}
export function markSampled(db: DB, id: string): Plan {
  if (!getPlan(db, id)) throw new Error('计划不存在')
  db.prepare(`UPDATE plans SET status='sampled' WHERE id=?`).run(id)
  return getPlan(db, id)!
}
// 计划详情：带出关联合同的「样品计划(待采)」+ 已入库样品
export function getPlanDetail(db: DB, planId: string) {
  const plan = getPlan(db, planId)
  if (!plan) throw new Error('计划不存在')
  const contract = plan.contract_id ? getContract(db, plan.contract_id) : null
  const samples = plan.contract_id
    ? listSamplesByContract(db, plan.contract_id).map(s => ({ ...s, rollup: sampleRollup(listRecords(db, { sampleId: s.id })) }))
    : []
  return { plan, contract, planItems: contract?.plan ?? [], samples }
}
// 现场采样→收样入库：按合同的样品计划把样品建出来，计划转已采样
export function sampleIn(db: DB, planId: string, year = new Date().getFullYear()): Sample[] {
  const plan = getPlan(db, planId)
  if (!plan) throw new Error('计划不存在')
  if (!plan.contract_id) throw new Error('该计划未关联合同，无法收样')
  const made = generateSamples(db, plan.contract_id, year)   // 幂等
  markSampled(db, planId)
  return made
}

// ============ 仪器台账 + 检定到期 ============
export type Instrument = { id: string; name: string; model: string; status: string; cert_until: string | null; cert_no: string | null; note: string }
export function listInstruments(db: DB): Instrument[] {
  return db.prepare(`SELECT * FROM instruments ORDER BY id`).all() as Instrument[]
}
// 台账整行覆盖的字段级 diff（体检44）：证书号/效期/量程哪个格子从啥改成啥都可查
function rowDiff(oldRow: Record<string, any>, newRow: Record<string, any>): { col: string; from: any; to: any }[] {
  const out: { col: string; from: any; to: any }[] = []
  for (const k of new Set([...Object.keys(oldRow), ...Object.keys(newRow)])) {
    if (String(oldRow[k] ?? '') !== String(newRow[k] ?? '')) out.push({ col: k, from: oldRow[k] ?? '', to: newRow[k] ?? '' })
  }
  return out
}
// 台账保存留痕（体检44）：更新记逐字段 from→to，新建记整行快照；不传 actor（种子/老单测）不写留痕
function logLedgerSave(db: DB, id: string, action: string, old: any, neu: any, actor?: { name: string; username?: string }) {
  if (!actor) return
  logAction(db, id, actor as User, action, old ? { changes: rowDiff(old, neu) } : { snapshot: neu })
}
export function createInstrument(db: DB, i: { id: string; name: string; model?: string; note?: string; certUntil?: string; certNo?: string; status?: string }, actor?: { name: string; username?: string }): Instrument {
  const old = db.prepare(`SELECT * FROM instruments WHERE id=?`).get(i.id) as any
  const certUntil = cleanDate(i.certUntil, '检定有效期')   // 脏日期会让效期提醒漏报
  db.prepare(`INSERT OR REPLACE INTO instruments (id, name, model, status, cert_until, cert_no, note) VALUES (?,?,?,?,?,?,?)`)
    .run(i.id, i.name, i.model ?? '', i.status ?? old?.status ?? 'normal', certUntil ?? old?.cert_until ?? null, i.certNo ?? old?.cert_no ?? null, i.note ?? '')
  const neu = db.prepare(`SELECT * FROM instruments WHERE id=?`).get(i.id) as Instrument
  logLedgerSave(db, i.id, 'instrument_save', old, neu, actor)
  return neu
}
// ============ 仪器领用 / 归还台账 ============
export type Checkout = { id: number; instrument_id: string; round_id: string | null; taken_by: string; taken_at: string; cert_ok_at_checkout: number; returned_by: string | null; returned_at: string | null; status: string }
// 领用：登记谁为哪期领了哪台仪器。检定过期一律拦（体检49：过期仪器出的数据没有法律效力，
// 所有角色都不放行，含 tech/admin）；没登记有效期的老台账不拦但留痕提醒补录。仪器转「使用中」。
export function checkoutInstrument(db: DB, input: { instrumentId: string; roundId?: string; takenBy: string }, actor: { name: string; username?: string }): Checkout & { warning?: string } {
  const inst = db.prepare(`SELECT * FROM instruments WHERE id=?`).get(input.instrumentId) as Instrument | undefined
  if (!inst) throw new Error('仪器不存在')
  if (!input.takenBy?.trim()) throw new Error('领用人必填')
  if (inst.cert_until && inst.cert_until < todayLocal()) {
    throw new Error(`这台仪器检定已过期（有效期至 ${inst.cert_until}），先送检更新台账再领用`)
  }
  const certOk = 1   // 能走到这必然在有效期内；cert_until 为空的老数据视同未知，放行但留痕提醒
  const info = db.prepare(`INSERT INTO instrument_checkouts (instrument_id, round_id, taken_by, taken_at, cert_ok_at_checkout, status)
    VALUES (?,?,?,?,?, 'out')`).run(input.instrumentId, input.roundId ?? null, input.takenBy.trim(), now(), certOk)
  db.prepare(`UPDATE instruments SET status='busy' WHERE id=?`).run(input.instrumentId)
  const co = db.prepare(`SELECT * FROM instrument_checkouts WHERE id=?`).get(info.lastInsertRowid) as Checkout
  if (!inst.cert_until) {
    logAction(db, input.instrumentId, { name: actor.name, username: actor.username } as User, 'instrument_cert_missing',
      { note: '领用时台账未登记检定有效期，无法核验是否在检定周期内，请尽快补录' })
    return { ...co, warning: `仪器「${inst.name}」台账没登记检定有效期，本次放行，请尽快补录台账` }
  }
  return co
}
// 归还：登记归还；若该仪器再无在外领用，转回「正常」。不能重复归还。
export function returnInstrument(db: DB, checkoutId: number, actor: { name: string; username?: string }): Checkout {
  const co = db.prepare(`SELECT * FROM instrument_checkouts WHERE id=?`).get(checkoutId) as Checkout | undefined
  if (!co) throw new Error('领用记录不存在')
  if (co.status === 'returned') throw new Error('该设备已归还，不能重复归还')
  db.prepare(`UPDATE instrument_checkouts SET status='returned', returned_by=?, returned_at=? WHERE id=?`).run(actor.name, now(), checkoutId)
  const others = db.prepare(`SELECT COUNT(*) n FROM instrument_checkouts WHERE instrument_id=? AND status='out'`).get(co.instrument_id) as { n: number }
  if (others.n === 0) db.prepare(`UPDATE instruments SET status='normal' WHERE id=? AND status='busy'`).run(co.instrument_id)
  return db.prepare(`SELECT * FROM instrument_checkouts WHERE id=?`).get(checkoutId) as Checkout
}
export function listCheckouts(db: DB, filter: { open?: boolean } = {}): (Checkout & { instrument_name: string })[] {
  const where = filter.open ? `WHERE co.status='out'` : ''
  return db.prepare(`SELECT co.*, i.name AS instrument_name FROM instrument_checkouts co JOIN instruments i ON i.id=co.instrument_id ${where} ORDER BY co.id DESC`).all() as any[]
}

// 标物/试剂删除改软删（体检16）：台账是追溯证据，不物理删；返回整行快照供路由层写进留痕
export function deleteRefMaterial(db: DB, id: string): RefMaterial {
  const row = db.prepare(`SELECT * FROM ref_materials WHERE id=? AND deleted=0`).get(id) as RefMaterial | undefined
  if (!row) throw new Error('标准物质不存在')
  db.prepare(`UPDATE ref_materials SET deleted=1 WHERE id=?`).run(id)
  return row
}
export function deleteReagent(db: DB, id: string): Reagent {
  const row = db.prepare(`SELECT * FROM reagents WHERE id=? AND deleted=0`).get(id) as Reagent | undefined
  if (!row) throw new Error('试剂不存在')
  db.prepare(`UPDATE reagents SET deleted=1 WHERE id=?`).run(id)
  return row
}
export function seedInstruments(db: DB) {
  if ((db.prepare(`SELECT COUNT(*) n FROM instruments`).get() as any).n > 0) return
  const seed: [string, string, string, string][] = [
    ['TC-004', '原子吸收分光光度计', 'WFX-130B', '2026-09-30'],
    ['TC-005', '紫外可见分光光度计', 'UV-1801', '2026-07-20'],
    ['TC-006', '原子荧光光度计', 'AFS-9700', '2027-01-15'],
    ['TC-007', '离子色谱仪', 'ICS-1100', '2026-06-30'],
    ['TC-008', '电子天平', 'ME204', '2026-08-05'],
    ['TC-009', '多参数水质分析仪', 'DR6000', '2026-12-01'],
  ]
  for (const [id, name, model, certUntil] of seed) createInstrument(db, { id, name, model, certUntil, certNo: `JD${id}` })
}

// ============ 标准物质 + 试剂台账 ============
export type RefMaterial = { id: string; name: string; batch: string; spec: string; expiry: string | null; stock: string; supplier: string; cert_no: string; created_at: string }
export type Reagent = { id: string; name: string; spec: string; grade: string; batch: string; expiry: string | null; stock: string; supplier: string; created_at: string }
export function listRefMaterials(db: DB): RefMaterial[] { return db.prepare(`SELECT * FROM ref_materials WHERE deleted=0 ORDER BY id`).all() as RefMaterial[] }
export function createRefMaterial(db: DB, m: Partial<RefMaterial> & { id: string; name: string }, actor?: { name: string; username?: string }): RefMaterial {
  // created_at 是原始登记时间＝留痕，改台账不能把它抹成今天；以库里已有的为准，不信客户端传的
  const old = db.prepare(`SELECT * FROM ref_materials WHERE id=?`).get(m.id) as any
  db.prepare(`INSERT OR REPLACE INTO ref_materials (id,name,batch,spec,expiry,stock,supplier,cert_no,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(m.id, m.name, m.batch ?? '', m.spec ?? '', cleanDate(m.expiry, '有效期'), m.stock ?? '', m.supplier ?? '', m.cert_no ?? '', old?.created_at ?? now())
  const neu = db.prepare(`SELECT * FROM ref_materials WHERE id=?`).get(m.id) as RefMaterial
  logLedgerSave(db, m.id, 'refmaterial_save', old, neu, actor)   // 体检44：更新记逐字段 diff
  return neu
}
export function listReagents(db: DB): Reagent[] { return db.prepare(`SELECT * FROM reagents WHERE deleted=0 ORDER BY id`).all() as Reagent[] }
export function createReagent(db: DB, r: Partial<Reagent> & { id: string; name: string }, actor?: { name: string; username?: string }): Reagent {
  const old = db.prepare(`SELECT * FROM reagents WHERE id=?`).get(r.id) as any
  db.prepare(`INSERT OR REPLACE INTO reagents (id,name,spec,grade,batch,expiry,stock,supplier,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(r.id, r.name, r.spec ?? '', r.grade ?? '', r.batch ?? '', cleanDate(r.expiry, '有效期'), r.stock ?? '', r.supplier ?? '', old?.created_at ?? now())
  const neu = db.prepare(`SELECT * FROM reagents WHERE id=?`).get(r.id) as Reagent
  logLedgerSave(db, r.id, 'reagent_save', old, neu, actor)   // 体检44
  return neu
}
// 资源到期提醒：仪器检定 + 标物/试剂效期，按今天分桶（30天内=soon，过期=overdue）
export function resourceAlerts(db: DB, today = todayLocal()) {
  const soonLine = addDays(today, 30)
  const bucket = (d: string | null) => !d ? null : (d < today ? 'overdue' : (d <= soonLine ? 'soon' : null))
  const out: { type: string; typeLabel: string; id: string; name: string; date: string; bucket: string }[] = []
  for (const i of listInstruments(db)) { const b = bucket(i.cert_until); if (b) out.push({ type: 'instrument', typeLabel: '仪器检定', id: i.id, name: i.name, date: i.cert_until!, bucket: b }) }
  for (const m of listRefMaterials(db)) { const b = bucket(m.expiry); if (b) out.push({ type: 'ref', typeLabel: '标准物质', id: m.id, name: m.name, date: m.expiry!, bucket: b }) }
  for (const r of listReagents(db)) { const b = bucket(r.expiry); if (b) out.push({ type: 'reagent', typeLabel: '试剂', id: r.id, name: r.name, date: r.expiry!, bucket: b }) }
  // 人员授权效期（2026新规）：设了 cert_until 的在职人员，到期前30天/过期进预警
  const people = db.prepare(`SELECT username, name, cert_name, cert_until FROM users WHERE status='active' AND cert_until IS NOT NULL`).all() as any[]
  for (const u of people) { const b = bucket(u.cert_until); if (b) out.push({ type: 'person', typeLabel: '人员授权', id: u.username, name: `${u.name}${u.cert_name ? '·' + u.cert_name : ''}`, date: u.cert_until, bucket: b }) }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}
// 年度统计（管理评审/年终盘点用）：合同/样品/报告/超标 + 检测员工作量 + 客户排行
export function statsYearly(db: DB, year: number) {
  const y = `${year}-`
  const n1 = (sql: string) => (db.prepare(sql).get(y + '%') as any)?.n ?? 0
  const contracts = n1(`SELECT COUNT(*) n FROM contracts WHERE created_at LIKE ?`)
  const samples = n1(`SELECT COUNT(*) n FROM samples WHERE created_at LIKE ?`)
  const reportsIssued = n1(`SELECT COUNT(*) n FROM reports WHERE issued_at LIKE ?`)
  const exceed = n1(`SELECT COUNT(*) n FROM reports WHERE issued_at LIKE ? AND conclusion LIKE '%超标%'`)
  const testers = db.prepare(`SELECT author AS name, COUNT(*) n FROM records WHERE updated_at LIKE ? AND author IS NOT NULL AND author != '' GROUP BY author ORDER BY n DESC LIMIT 20`).all(y + '%') as any[]
  const clients = db.prepare(`SELECT client, COUNT(*) n FROM contracts WHERE created_at LIKE ? GROUP BY client ORDER BY n DESC LIMIT 10`).all(y + '%') as any[]
  const qc = db.prepare(`SELECT SUM(CASE WHEN verdict='合格' THEN 1 ELSE 0 END) pass, COUNT(*) total FROM qc_records WHERE at LIKE ? AND verdict IS NOT NULL`).get(y + '%') as any
  return { year, contracts, samples, reportsIssued, exceed, testers, clients, qc: { pass: qc?.pass ?? 0, total: qc?.total ?? 0 } }
}
export function seedResources(db: DB) {
  if ((db.prepare(`SELECT COUNT(*) n FROM ref_materials`).get() as any).n === 0) {
    createRefMaterial(db, { id: 'BW-Zn', name: '锌标准溶液', batch: 'GBW08620', spec: '1000 μg/mL', expiry: '2026-07-25', stock: '2 支', supplier: '国家标准物质中心', cert_no: 'GBW08620' })
    createRefMaterial(db, { id: 'BW-COD', name: 'COD标准溶液', batch: 'GBW(E)080401', spec: '1000 mg/L', expiry: '2027-03-10', stock: '1 支', supplier: '环保部标样所', cert_no: 'GBW080401' })
    createRefMaterial(db, { id: 'BW-NH3', name: '氨氮标准溶液', batch: 'GBW08606', spec: '1000 mg/L', expiry: '2026-06-15', stock: '3 支', supplier: '国家标准物质中心', cert_no: 'GBW08606' })
  }
  if ((db.prepare(`SELECT COUNT(*) n FROM reagents`).get() as any).n === 0) {
    createReagent(db, { id: 'SJ-001', name: '硫酸', spec: '500 mL', grade: '优级纯 GR', batch: '20250312', expiry: '2027-03-12', stock: '4 瓶', supplier: '国药' })
    createReagent(db, { id: 'SJ-002', name: '纳氏试剂', spec: '100 mL', grade: '分析纯 AR', batch: '20250601', expiry: '2026-07-18', stock: '1 瓶', supplier: '阿拉丁' })
    createReagent(db, { id: 'SJ-003', name: '重铬酸钾', spec: '250 g', grade: '基准试剂', batch: '20250109', expiry: '2028-01-09', stock: '2 瓶', supplier: '国药' })
  }
}

// ============ 管理统计看板：全所家底一眼看全 ============
export type StatsOverview = {
  contracts: { total: number; accepted: number }
  samples: { total: number; pending: number; month: number }
  reports: { total: number; draft: number; checked: number; issued: number; monthIssued: number; exceed: number }
  qc: { total: number; pass: number; rate: number | null }
  system: { audit: boolean; review: boolean; train: boolean }
  resource: { alerts: number; overdue: number }
}
export function statsOverview(db: DB, ref = new Date().toISOString()): StatsOverview {
  const ym = todayLocal(new Date(ref)).slice(0, 7) + '%'   // 本月 YYYY-MM（本地日：每月1号凌晨不再算进上月）
  const cnt = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any).n as number
  const contracts = {
    total: cnt(`SELECT COUNT(*) n FROM contracts`),
    accepted: cnt(`SELECT COUNT(*) n FROM contracts WHERE accepted_at IS NOT NULL`),
  }
  const samples = {
    total: cnt(`SELECT COUNT(*) n FROM samples`),
    pending: cnt(`SELECT COUNT(*) n FROM samples WHERE status IN ('pending','testing')`),
    month: cnt(`SELECT COUNT(*) n FROM samples WHERE created_at LIKE ?`, ym),
  }
  const reports = {
    total: cnt(`SELECT COUNT(*) n FROM reports`),
    draft: cnt(`SELECT COUNT(*) n FROM reports WHERE status='draft'`),
    checked: cnt(`SELECT COUNT(*) n FROM reports WHERE status='checked'`),
    issued: cnt(`SELECT COUNT(*) n FROM reports WHERE status='issued'`),
    monthIssued: cnt(`SELECT COUNT(*) n FROM reports WHERE status='issued' AND issued_at LIKE ?`, ym),
    exceed: cnt(`SELECT COUNT(*) n FROM reports WHERE conclusion LIKE '%超标%'`),
  }
  const qcTotal = cnt(`SELECT COUNT(*) n FROM qc_records`)
  const qcPass = cnt(`SELECT COUNT(*) n FROM qc_records WHERE verdict='合格'`)
  const qc = { total: qcTotal, pass: qcPass, rate: qcTotal ? Math.round(qcPass / qcTotal * 100) : null }
  const sysDone = (cat: string) => cnt(`SELECT COUNT(*) n FROM system_records WHERE category=? AND status='已完成'`, cat) > 0
  const system = { audit: sysDone('内部审核'), review: sysDone('管理评审'), train: sysDone('人员培训') }
  const al = resourceAlerts(db, todayLocal(new Date(ref)))
  const resource = { alerts: al.length, overdue: al.filter(a => a.bucket === 'overdue').length }
  return { contracts, samples, reports, qc, system, resource }
}

// ============ 检测报告 ============
export type Report = {
  id: string; sample_id: string | null; round_id: string | null; contract_id: string | null; client: string
  title: string; conclusion: string; data: any; status: string
  checker: string | null; checked_at: string | null
  issuer: string | null; issued_at: string | null; created_at: string
  author?: string | null
  author_username?: string | null; checker_username?: string | null; issuer_username?: string | null   // 同人校验按登录名（老数据为空回退姓名）
  voided?: number; void_reason?: string | null; voided_by?: string | null; voided_at?: string | null; reissue_of?: string | null
}
// 报告串全过程（决策17）：合同→方案→谁何时去哪采了什么→交接→派了哪些检测。出报告时快照进 data.process。
function buildReportProcess(db: DB, c: Contract, roundId?: string) {
  const scheme = c.scheme
  const points = listPoints(db, c.id).map(p => ({
    code: p.code, name: p.name, planned: p.planned_desc, actual: p.actual_desc || p.planned_desc, source: p.source,
  }))
  let sampling: any = null
  if (roundId) {
    const r = getRound(db, roundId)
    if (r) {
      sampling = {
        roundNo: r.round_no, dueDate: r.due_date, planDate: r.plan_date || '',
        sampler: r.sampler || '', sampledAt: r.sampled_at || '',
        weather: r.field_info?.weather || '', fieldDate: r.field_info?.date || '',
      }
    }
  }
  const samples = roundId ? listSamplesByRound(db, roundId).filter(s => !s.qc_type) : []
  const handovers = samples.map(s => {
    const h = listHandovers(db, s.id).find(x => x.action === '采样交接')
    return h ? { sampleId: s.id, from: h.from_person || h.who, confirmedBy: h.confirmed_by, confirmedAt: h.confirmed_at } : null
  }).filter(Boolean)
  const tasks = samples.flatMap(s => listTestTasks(db, { sampleId: s.id }).map(t => ({ sampleId: s.id, analyte: t.analyte, assignee: t.assignee })))
  return {
    contract: { id: c.id, client: c.client, project: c.project, period: [c.period_start, c.period_end] },
    scheme: scheme ? { id: scheme.id, standards: [...new Set((scheme.points || []).map(p => p.standard).filter(Boolean))], reviewer: scheme.reviewer } : null,
    points, sampling, handovers, tasks,
  }
}
// 一期一报告：汇总该期全部样品的已审核结果（真实报告的样子）
export function generateRoundReport(db: DB, roundId: string, year = new Date().getFullYear(), reportAuthor = '', reportAuthorUsername = ''): Report {
  const round = getRound(db, roundId)
  if (!round) throw new Error('监测期次不存在')
  const c = getContract(db, round.contract_id)
  if (!c) throw new Error('合同不存在')
  if (c.status === 'terminated') throw new Error('合同已终止，不能再生成报告；已有数据仅供查看')   // 体检15
  // 报告只汇总普通样：质控样（空白/平行）走质控评价线；拒收样（终态）不进报告也不卡报告
  const samples = listSamplesByRound(db, roundId).filter(s => !s.qc_type && (s as any).status !== 'rejected')
  if (!samples.length) throw new Error('这一期还没有样品（或全部被拒收），先收样/补采入库')
  // 一期一报告：本期已有未作废的报告就不许再生成；作废后允许重出并记 reissue_of 链
  const dup = listReports(db).find(r => r.round_id === roundId && !r.voided)
  if (dup) throw new Error(`第${round.round_no}期已生成报告 ${dup.id}，不要重复生成；如需修改请打开该报告（签发后要改先作废再重出）`)
  const voidedPrev = listReports(db).find(r => r.round_id === roundId && r.voided)
  const limits = c.scheme?.limits ?? []
  const results: any[] = []
  const compareBlocks: any[] = []
  const authors = new Set<string>()
  const reviewers = new Set<string>()
  for (const s of samples) {
    // 真"全部定稿"校验：该样品名下任何一条记录没走完三级审核都不能出报告（不能无声跳过缺项）
    const allRecs = listRecords(db, { sampleId: s.id })
    const unfinished = allRecs.filter(r => r.status !== 'approved')
    if (unfinished.length) {
      throw new Error(`样品 ${s.id} 还有 ${unfinished.length} 条记录未审核定稿（${unfinished.map(r => r.analyte || r.template_code).join('、')}），不能出报告`)
    }
    // 质控派了任务但还没出记录的项目，也算没测完
    const tasks = listTestTasks(db, { sampleId: s.id })
    const missing = tasks.filter(t => !allRecs.some(r => r.analyte === t.analyte))
    if (missing.length) {
      throw new Error(`样品 ${s.id} 的项目「${missing.map(t => t.analyte).join('、')}」已派任务但还没有检测记录，不能出报告`)
    }
    const approved = allRecs
    if (!approved.length) throw new Error(`样品 ${s.id} 还没有「审核通过」的记录，不能出报告`)
    for (const r of approved) {
      // 比对插槽：记录带 data.compare（A/B成对数据）→ 判定引擎出比对块；无常规结果的比对记录不进结果表
      if (Array.isArray(r.data?.compare) && r.data.compare.length) {
        for (const g of r.data.compare) {
          compareBlocks.push({ sampleId: s.id, analyte: g.analyte, type: g.type, pairs: g.pairs, stdValue: g.stdValue ?? null, ...judgeCompareGroup(g) })
        }
        const cby = recordAuthor(db, r.id); if (cby) authors.add(cby)
        if (r.reviewer) reviewers.add(r.reviewer); if (r.approver) reviewers.add(r.approver)
        if (!r.data?.resultSummary) continue
      }
      const rs = r.data?.resultSummary || {}
      const analyte = r.analyte || rs.analyte || ''
      // 拍板3（2026-07-31，翻案决策15）：自动判定进草稿，编制人确认/修改后出
      const j = judgeResult(rs.value, limitFor(limits, analyte))
      // corrected/rate/time：折算浓度、排放速率、测量时间透传位（记录填了就带进报告；噪声表用 time 列）
      results.push({ sampleId: s.id, matrix: s.matrix, pointName: s.point_name || '', qcType: s.qc_type || '', analyte, method: r.method || '', value: rs.value ?? '', unit: rs.unit ?? '', corrected: rs.corrected ?? '', rate: rs.rate ?? '', time: rs.time ?? '', code: r.template_code, serial: r.serial, limit: j.limitText, verdict: j.verdict, instrumentId: r.instrument_id || '' })
      const by = recordAuthor(db, r.id); if (by) authors.add(by)
      if (r.reviewer) reviewers.add(r.reviewer); if (r.approver) reviewers.add(r.approver)
    }
  }
  // 质控联动：本期有"不合格"的质控评价 → 报告数据带警示（编制界面提示，不拦但必须看见）
  const qcFails = db.prepare(`SELECT COUNT(*) n FROM qc_records WHERE round_id=? AND verdict='不合格'`).get(roundId) as any
  const warnParts: string[] = []
  if (qcFails?.n) warnParts.push(`本期有 ${qcFails.n} 条质控评价不合格（平行/加标/密码样），出报告前请质控员确认处理意见`)
  // 日期穿帮兜底：录入时已警告过，出报告再核一遍（评审抽卷比日期是基本动作）
  {
    const base = String(round.sampled_at || '').slice(0, 10)
    if (base) {
      const bad: string[] = []
      for (const s2 of samples) for (const rec of listRecords(db, { sampleId: s2.id })) {
        const meta = (rec.data as any)?.meta || {}
        const key = Object.keys(meta).find(k => /检测日期|分析日期|^date$/i.test(k) && /^\d{4}-\d{2}-\d{2}/.test(String(meta[k] ?? '')))
        if (key && String(meta[key]).slice(0, 10) < base) bad.push(`${s2.id}·${rec.analyte || rec.template_code}`)
      }
      if (bad.length) warnParts.push(`有 ${bad.length} 条记录的检测日期早于本期采样日 ${base}（${bad.slice(0, 3).join('、')}${bad.length > 3 ? '…' : ''}），日期穿帮请先改正`)
    }
  }
  const qcWarning = warnParts.join('；')
  const std = c.scheme?.points?.[0]?.standard || ''
  const author = [...authors].join('、'), reviewer = [...reviewers].join('、')
  // 分包进报告（缺口2收口）：本合同分包单里的项目 → 结果行打 sub 标（打印页加*），报告带分包声明
  const subs = listSubcontracts(db, { contractId: c.id }).filter(x => x.subcontractor)
  const subItems = new Map<string, Subcontract>()
  for (const x of subs) for (const it of String(x.items || '').split(/[,，、\s]+/).filter(Boolean)) subItems.set(it, x)
  let subNote = ''
  if (subItems.size) {
    for (const r of results as any[]) if (subItems.has(r.analyte)) r.sub = true
    const labs = new Set([...subItems.values()].map(x => `外委给${x.subcontractor}${x.qualification ? `，计量认证证书编号：${x.qualification}` : ''}`))
    subNote = `（*为我公司分包项目，本公司无资质，${[...labs].join('；')}。）`
  }
  // 有组织废气插槽：气类期次带上涉及点位的排气筒静态档案（地基3 stack_info），供报告附表渲染
  const GAS_MATRIX = ['废气', '有组织废气', '无组织废气', '环境空气']
  let stacks: any[] = []
  if (samples.some(s => GAS_MATRIX.includes(s.matrix))) {
    const ptNames = new Set(results.map((r: any) => r.pointName).filter(Boolean))
    stacks = listPoints(db, c.id)
      .filter((p: any) => ptNames.has(p.name))
      .map((p: any) => ({ name: p.name, code: p.code, stack_info: p.stack_info || null }))
  }
  const id = nextSeqId(db, 'reports', `BG${year}-`)
  db.prepare(`INSERT INTO reports (id, sample_id, round_id, contract_id, client, title, conclusion, data, status, author, author_username, reissue_of, created_at)
    VALUES (?,NULL,?,?,?,?,?,?,'draft',?,?,?,?)`)
    .run(id, roundId, c.id, c.client, `${c.client} 检测报告（第${round.round_no}期）`,
      compareBlocks.length ? '不予判定。' : buildConclusionDraft(results, limits),   // 比对报告总结论恒"不予判定"（6份样本一致）
      JSON.stringify({ round: { id: roundId, no: round.round_no, due: round.due_date }, results, compareBlocks, stacks, fieldInfo: round.field_info || null, subNote, author, reviewer, qcWarning: qcWarning || undefined, process: buildReportProcess(db, c, roundId) }),
      reportAuthor || null, reportAuthorUsername || null, voidedPrev?.id ?? null, now())
  return getReport(db, id)!
}
// 从某样品已「审核通过」的记录汇总生成报告草稿
export function generateReport(db: DB, sampleId: string, year = new Date().getFullYear(), reportAuthor = '', reportAuthorUsername = ''): Report {
  const sample = getSample(db, sampleId)
  if (!sample) throw new Error('样品不存在')
  assertContractNotTerminated(db, sample.contract_id, '生成报告')   // 体检15（散样无合同不受影响）
  // 散样报告也查重：已有未作废的报告不许再生成（双击不会出两份）
  const dup = listReports(db).find(r => r.sample_id === sampleId && !r.voided)
  const voidedPrev0 = listReports(db).find(r => r.sample_id === sampleId && r.voided)
  if (dup) throw new Error(`该样品已生成报告 ${dup.id}，不要重复生成；要改先作废再重出`)
  const allRecs = listRecords(db, { sampleId })
  const unfinished = allRecs.filter(r => r.status !== 'approved')
  if (unfinished.length) throw new Error(`该样品还有 ${unfinished.length} 条记录未审核定稿（${unfinished.map(r => r.analyte || r.template_code).join('、')}），不能出报告`)
  const approved = allRecs
  if (!approved.length) throw new Error('该样品还没有「审核通过」的记录，无法出报告')
  const scheme = sample.contract_id ? getScheme(db, sample.contract_id) : null
  const limits = scheme?.limits ?? []
  const authors = new Set<string>(), reviewers = new Set<string>()
  const results = approved.map(r => {
    const rs = r.data?.resultSummary || {}
    const analyte = r.analyte || rs.analyte || ''
    // 拍板3（2026-07-31，翻案决策15）：自动判定进草稿，编制人确认/修改后出
    const j = judgeResult(rs.value, limitFor(limits, analyte))
    const by = recordAuthor(db, r.id); if (by) authors.add(by)
    if (r.reviewer) reviewers.add(r.reviewer); if (r.approver) reviewers.add(r.approver)
    return { sampleId, matrix: sample.matrix, pointName: sample.point_name || '', qcType: sample.qc_type || '', analyte, method: r.method || '', value: rs.value ?? '', unit: rs.unit ?? '', code: r.template_code, serial: r.serial, limit: j.limitText, verdict: j.verdict, instrumentId: r.instrument_id || '' }
  })
  const std = scheme?.points?.[0]?.standard || ''
  const id = nextSeqId(db, 'reports', `BG${year}-`)
  db.prepare(`INSERT INTO reports (id, sample_id, contract_id, client, title, conclusion, data, status, author, author_username, reissue_of, created_at) VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?)`)
    .run(id, sampleId, sample.contract_id, sample.client, `${sample.client} 检测报告`, buildConclusionDraft(results, limits), JSON.stringify({ sample, results, author: [...authors].join('、'), reviewer: [...reviewers].join('、') }), reportAuthor || null, reportAuthorUsername || null, voidedPrev0?.id ?? null, now())
  return getReport(db, id)!
}
// 样号反查（批次二修补）：期次报告 sample_id 为空，按样品的 round_id 兜底匹配到报告
export function findReportsBySample(db: DB, sampleId: string): Report[] {
  const s = getSample(db, sampleId)
  if (!s) return []
  const rows = db.prepare(`SELECT * FROM reports WHERE sample_id=? OR (round_id IS NOT NULL AND round_id=?) ORDER BY created_at DESC`)
    .all(sampleId, s.round_id ?? '__none__') as any[]
  return rows.map(r => ({ ...r, data: safeJson(r.data, {}) }))
}
export function getReport(db: DB, id: string): Report | null {
  const r = db.prepare(`SELECT * FROM reports WHERE id=?`).get(id) as any
  if (!r) return null
  return { ...r, data: safeJson(r.data, {}) }
}
export function assertReportReadAccess(db: DB, id: string, actor: User): Report {
  if (!hasRole(actor, ...REPORT_READ_ROLES)) {
    throw httpError(403, '无权读取报告或归档清单', 'REPORT_FORBIDDEN')
  }
  const report = getReport(db, id)
  if (!report) throw httpError(404, '报告不存在', 'REPORT_NOT_FOUND')
  return report
}
export function listReports(db: DB): Report[] {
  return (db.prepare(`SELECT * FROM reports ORDER BY created_at DESC`).all() as any[]).map(r => ({ ...r, data: safeJson(r.data, {}) }))
}
// 报告三级第二关：审核（编制→审核）。审核通过才能签发。
export function checkReport(db: DB, id: string, checker: string, checkerUsername = ''): Report {
  const r = getReport(db, id)
  if (!r) throw new Error('报告不存在')
  if (r.voided) throw new Error('报告已作废，不能审核')
  if (r.status === 'issued') throw new Error('报告已签发，不能再审核')
  if (r.status === 'checked') return r
  // 三级签字不可同一人：审核人 ≠ 编制人（老报告无编制人则不拦）。优先登录名比对，缺则回退姓名。
  const author = (r as any).author as string | null
  const authorU = (r as any).author_username as string | null
  if ((author || authorU) && samePerson({ name: author, username: authorU }, { name: checker, username: checkerUsername })) {
    throw new Error(`报告审核人不能是编制人本人（${author || authorU}）`)
  }
  db.prepare(`UPDATE reports SET status='checked', checker=?, checker_username=?, checked_at=? WHERE id=?`).run(checker, checkerUsername || null, now(), id)
  return getReport(db, id)!
}
// 报告三级第三关：签发（审核→签发）。必须先审核。
export function issueReport(db: DB, id: string, issuer: string, issuerUsername = ''): Report {
  const r = getReport(db, id)
  if (!r) throw new Error('报告不存在')
  // 2026新规"先授权后上岗"：授权签字人设了授权有效期且已过期 → 拦签发（没设效期的老账号不拦）
  if (issuerUsername) {
    const u = db.prepare(`SELECT cert_name, cert_until FROM users WHERE username=?`).get(issuerUsername) as any
    if (u?.cert_until && u.cert_until < todayLocal()) {
      throw new Error(`${issuer} 的授权${u.cert_name ? `（${u.cert_name}）` : ''}已于 ${u.cert_until} 过期，不能签发报告——请先更新人员授权`)
    }
  }
  if (r.voided) throw new Error('报告已作废，不能签发')
  if (r.status === 'issued') return r
  if (r.status !== 'checked') throw new Error('报告未经审核，不能签发；请先由报告审核人审核')
  // 三级签字不可同一人：签发人 ≠ 编制人、≠ 审核人。优先登录名比对，缺则回退姓名。
  const author = (r as any).author as string | null
  const authorU = (r as any).author_username as string | null
  if ((author || authorU) && samePerson({ name: author, username: authorU }, { name: issuer, username: issuerUsername })) {
    throw new Error(`报告签发人不能是编制人本人（${author || authorU}）`)
  }
  if (r.checker && samePerson({ name: r.checker, username: (r as any).checker_username }, { name: issuer, username: issuerUsername })) {
    throw new Error(`报告签发人不能与审核人（${r.checker}）同一人`)
  }
  db.prepare(`UPDATE reports SET status='issued', issuer=?, issuer_username=?, issued_at=? WHERE id=?`).run(issuer, issuerUsername || null, now(), id)
  return getReport(db, id)!
}
// 决策17：签发后锁死，要改走「作废重出」——作废留痕，重出的新报告记 reissue_of 链。
// 作废限签发人本人（优先登录名比对）；tech/admin 由路由层传 supervisor 兜底放行。
export function voidReport(db: DB, id: string, reason: string, actor: User | { name: string; username?: string }, supervisor = false): Report {
  const r = getReport(db, id)
  if (!r) throw new Error('报告不存在')
  if (r.voided) throw new Error('该报告已作废')
  if (r.status !== 'issued') throw new Error('只有已签发的报告需要作废重出；未签发的直接改或删草稿即可')
  if (!supervisor && !samePerson({ name: r.issuer, username: (r as any).issuer_username }, { name: (actor as any).name, username: (actor as any).username })) {
    throw httpError(403, '只有签发人本人才能作废这份报告')
  }
  if (!reason?.trim()) throw new Error('作废原因必填')
  db.prepare(`UPDATE reports SET voided=1, void_reason=?, voided_by=?, voided_at=? WHERE id=?`)
    .run(reason.trim(), (actor as any).name, now(), id)
  logAction(db, id, actor as User, 'report_void', { reason: reason.trim() })
  return getReport(db, id)!
}
// 报告草稿可删：只删还没走完签发流的（draft/checked）。已签发/已作废是对外/留档文件，不能物理删。
// 物理 DELETE：删掉后同一期次/合同的查重自然放行，可重新生成。
export function deleteReport(db: DB, id: string, actor: User | { name: string; username?: string }): { ok: true } {
  const r = getReport(db, id)
  if (!r) throw new Error('报告不存在')
  if (r.voided) throw new Error('已作废的报告要永久留档，不能删除')
  if (r.status === 'issued') throw new Error('已签发的报告不能删除；要撤回请走「作废重出」')
  if (r.status !== 'draft' && r.status !== 'checked') throw new Error(`当前状态「${r.status}」的报告不能删除`)
  db.prepare(`DELETE FROM reports WHERE id=?`).run(id)
  // 留痕记下报告号/标题/原状态：表里行没了，留痕里还能查到删过什么
  logAction(db, id, actor as User, 'report_delete', { report_no: r.id, title: r.title, status: r.status })
  return { ok: true }
}
// 合同总报告（决策17）：项目结束按合同汇总一份——聚合各期报告的结果
export function generateContractReport(db: DB, contractId: string, reportAuthor = '', year = new Date().getFullYear(), reportAuthorUsername = ''): Report {
  const c = getContract(db, contractId)
  if (!c) throw new Error('合同不存在')
  if (c.status === 'terminated') throw new Error('合同已终止，不能再生成报告；已有数据仅供查看')   // 体检15
  const roundReports = listReports(db).filter(r => r.contract_id === contractId && r.round_id && !r.voided)
  if (!roundReports.length) throw new Error('该合同还没有期次报告，先按期出报告，项目结束再汇总总报告')
  const rounds = listRounds(db, contractId)
  // cancelled 是终态（体检12）：终止的期次不算「未完成」，不再卡总报告
  const undone = rounds.filter(r => r.status !== 'done' && r.status !== 'cancelled')
  if (undone.length) throw new Error(`还有 ${undone.length} 期未完成采样（第${undone.map(r => r.round_no).join('、')}期），项目未结束不能出总报告`)
  const dupTotal = listReports(db).find(r => r.contract_id === contractId && !r.round_id && !r.sample_id && !r.voided)
  if (dupTotal) throw new Error(`该合同已有总报告 ${dupTotal.id}；要改先作废再重出`)
  // 聚合各期结果（带期次号），按期次顺序
  const results = roundReports
    .sort((a, b) => (a.data?.round?.no ?? 0) - (b.data?.round?.no ?? 0))
    .flatMap(r => (r.data?.results ?? []).map((x: any) => ({ ...x, roundNo: r.data?.round?.no })))
  const limits = c.scheme?.limits ?? []
  const id = nextSeqId(db, 'reports', `BG${year}-`)
  db.prepare(`INSERT INTO reports (id, sample_id, round_id, contract_id, client, title, conclusion, data, status, author, author_username, created_at)
    VALUES (?,NULL,NULL,?,?,?,?,?,'draft',?,?,?)`)
    .run(id, contractId, c.client, `${c.client} 检测总报告（${rounds.length}期汇总）`, buildConclusionDraft(results, limits),
      JSON.stringify({ kind: 'total', rounds: rounds.map(r => ({ no: r.round_no, due: r.due_date, sampler: r.sampler, sampledAt: r.sampled_at })), results, roundReports: roundReports.map(r => r.id), process: buildReportProcess(db, c) }),
      reportAuthor || null, reportAuthorUsername || null, now())
  return getReport(db, id)!
}
// §8.1 审核通则：报告审核后发现问题 → 退回编制（带原因、留痕），不许审核后静默改内容
export function rejectReport(db: DB, id: string, reason: string, actor: User | { name: string; username?: string }): Report {
  const r = getReport(db, id)
  if (!r) throw new Error('报告不存在')
  if (r.voided) throw new Error('报告已作废')
  if (r.status !== 'checked') throw new Error('只有「已审核待签发」的报告能退回编制')
  if (!reason?.trim()) throw new Error('退回原因必填')
  db.prepare(`UPDATE reports SET status='draft', checker=NULL, checked_at=NULL WHERE id=?`).run(id)
  logAction(db, id, actor as User, 'report_reject', { reason: reason.trim() })
  return getReport(db, id)!
}
export function updateReport(db: DB, id: string, patch: { title?: string; conclusion?: string }): Report {
  const r = getReport(db, id)
  if (!r) throw new Error('报告不存在')
  if (r.voided) throw new Error('报告已作废，不能修改；请在重出的新报告上编辑')
  // 已签发报告是对外出具的正式文件，不许直接改；如需变更须走「作废重出」
  if (r.status === 'issued') throw new Error('报告已签发，不能直接修改。要改请先「作废」（留痕）再重新生成')
  // §8.1：审核通过等签发的报告也不许静默改——要改先退回编制（留痕）
  if (r.status === 'checked') throw new Error('报告已审核待签发，不能直接改内容；请审核人先「退回编制」再改')
  db.prepare(`UPDATE reports SET title=COALESCE(?,title), conclusion=COALESCE(?,conclusion) WHERE id=?`)
    .run(patch.title ?? null, patch.conclusion ?? null, id)
  return getReport(db, id)!
}

// ============ 项目视图：把一份合同底下的一切聚合起来 ============
// 单个样品的汇总状态：pending 待检测 | testing 检测中 | review 待审核 | approved 已审核
export function sampleRollup(records: RecordRow[]): string {
  if (!records.length) return 'pending'
  if (records.every(r => r.status === 'approved')) return 'approved'
  if (records.some(r => r.status === 'submitted' || r.status === 'reviewed')) return 'review'
  return 'testing'
}
export function projectStats(db: DB, contractId: string) {
  const samples = listSamplesByContract(db, contractId)
  const enriched = samples.map(s => { const recs = listRecords(db, { sampleId: s.id }); return { rollup: sampleRollup(recs), hasRec: recs.length > 0 } })
  const reports = listReports(db).filter(r => r.contract_id === contractId)
  // 报告进度：取最靠后的状态，让列表卡片/「下一步」不再只认「已签发」
  const reportStatus: 'none' | 'draft' | 'checked' | 'issued' =
    reports.some(r => r.status === 'issued') ? 'issued'
    : reports.some(r => r.status === 'checked') ? 'checked'
    : reports.some(r => r.status === 'draft') ? 'draft'
    : 'none'
  return {
    samples: enriched.length,
    tested: enriched.filter(e => e.hasRec).length,
    approved: enriched.filter(e => e.rollup === 'approved').length,
    reports: reports.length,
    issued: reports.some(r => r.status === 'issued'),
    reportStatus,
  }
}
function listSamplesByContract(db: DB, contractId: string): Sample[] {
  return (db.prepare(`SELECT * FROM samples WHERE contract_id = ? ORDER BY id`).all(contractId) as any[])
    .map(r => ({ ...r, items: safeJson(r.items, []) }))
}
export function getProject(db: DB, contractId: string) {
  const contract = getContract(db, contractId)
  if (!contract) throw new Error('项目不存在')
  const plans = listPlans(db).filter(p => p.contract_id === contractId)
  const samples = listSamplesByContract(db, contractId).map(s => {
    const records = listRecords(db, { sampleId: s.id })
    return { ...s, records, rollup: sampleRollup(records) }
  })
  const reports = listReports(db).filter(r => r.contract_id === contractId)
  return { contract, plans, samples, reports, stats: projectStats(db, contractId), pipeline: getProjectPipeline(db, contractId) }
}
export function listProjects(db: DB) {
  return listContracts(db).map(c => {
    const plans = listPlans(db).filter(p => p.contract_id === c.id)
    return { ...c, stats: projectStats(db, c.id), plan: plans[0] ?? null, pipeline: getProjectPipeline(db, c.id) }
  })
}

// —— 主线状态机：算出一单走到 8 环里的哪一环、下一步该谁点什么 ——
// 周期项目按「期」推进：第 1 期出完报告不算完，主线回到第 2 期采样，全部期都完才算完成。
export type PipeStage = { key: string; label: string; code: string; who: string; status: 'done' | 'active' | 'todo'; action: string }
export type PipelineInfo = { stages: PipeStage[]; activeIndex: number; round: { no: number | null; total: number; due?: string } | null }

const STAGE_DEFS = (codes: Record<string, string>): Omit<PipeStage, 'status'>[] => [
  { key: 'accept',   label: '委托受理', code: codes.accept,   who: '登记员',        action: '确认受理 · 合同评审通过' },
  { key: 'scheme',   label: '监测方案', code: codes.scheme,   who: '技术负责人',    action: '编制监测方案并审核通过' },
  { key: 'dispatch', label: '采样派工', code: codes.dispatch, who: '调度 · 采样员', action: '给这一期派采样员' },
  { key: 'sampleIn', label: '样品建档', code: codes.sampleIn, who: '采样员',        action: '现场采样 · 收样入库' },
  { key: 'testing',  label: '检测记录', code: codes.testing,  who: '检测员',        action: '认领仪器 · 录入 · 提交' },
  { key: 'review',   label: '三级审核', code: codes.review,   who: '复核 · 审核员', action: '复核通过 → 审核通过' },
  { key: 'report',   label: '报告签发', code: codes.report,   who: '授权签字人',    action: '生成本期报告 · 签发盖章' },
  { key: 'archive',  label: '归档留痕', code: codes.archive,  who: '系统',          action: '已归档' },
]
function buildStages(defs: Omit<PipeStage, 'status'>[], done: boolean[]): { stages: PipeStage[]; activeIndex: number } {
  const activeIndex = done.findIndex(d => !d)
  return {
    stages: defs.map((d, i) => ({ ...d, status: done[i] ? 'done' : (i === activeIndex ? 'active' : 'todo') })),
    activeIndex,
  }
}

export function getProjectPipeline(db: DB, contractId: string): PipelineInfo {
  const c = getContract(db, contractId)
  if (!c) throw new Error('项目不存在')
  const schemeApproved = c.scheme?.status === 'approved'
  const rounds = schemeApproved ? listRounds(db, contractId) : []

  // ============ 周期路径：主线跟着「当前期」走 ============
  if (rounds.length) {
    const isComplete = (r: (typeof rounds)[number]) =>
      r.status === 'done' && r.sample_count > 0 && r.rollup === 'approved' && roundReportIssued(db, r.id)
    // cancelled 是终态（体检12）：终止的期次不再当「当前期」卡主线
    const active = rounds.find(r => r.status !== 'cancelled' && !isComplete(r))
    if (!active) {   // 所有期都走完
      const { stages } = buildStages(STAGE_DEFS({
        accept: c.id, scheme: c.scheme!.id, dispatch: `${rounds.length} 期全部完成`, sampleIn: '全部入库',
        testing: '全部录入', review: '全部通过', report: `${rounds.length} 期报告已签发`, archive: '全链路可溯',
      }), [true, true, true, true, true, true, true, true])
      return { stages, activeIndex: -1, round: { no: null, total: rounds.length } }
    }
    const samples = listSamplesByRound(db, active.id)
    // 主线卡点只看普通样：质控样（空白/平行）走质控评价线，不卡报告
    const recs = samples.filter(s => !s.qc_type).map(s => listRecords(db, { sampleId: s.id }))
    const dispatched = !!active.sampler || active.status === 'done'
    const sampled = active.status === 'done' && samples.length > 0
    const tested = sampled && recs.every(rs => rs.length > 0)
    const approvedAll = sampled && recs.every(rs => rs.length > 0 && rs.every(r => r.status === 'approved'))
    const issued = roundReportIssued(db, active.id)
    const roundRep = listReports(db).find(r => r.round_id === active.id)
    const { stages, activeIndex } = buildStages(STAGE_DEFS({
      accept: c.id, scheme: c.scheme!.id,
      dispatch: active.sampler ? `${active.sampler} · ${active.plan_date || active.due_date}` : `截止 ${active.due_date}`,
      sampleIn: sampled ? `${samples.length} 个样品` : '待收样入库',
      testing: tested ? `${recs.flat().length} 条记录` : '待录入',
      review: '记录复核审核',
      report: roundRep?.id ?? '待生成',
      archive: '全链路可溯',
    }), [!!c.accepted_at, true, dispatched, sampled, tested, approvedAll, issued, issued])
    return { stages, activeIndex, round: { no: active.round_no, total: rounds.length, due: active.due_date } }
  }

  // ============ 单次路径（无排期/免采样散样）============
  const plans = listPlans(db).filter(p => p.contract_id === contractId)
  const samples = listSamplesByContract(db, contractId)
  const recsBySample = samples.map(s => listRecords(db, { sampleId: s.id }))
  const reports = listReports(db).filter(r => r.contract_id === contractId)
  const sampled = samples.length > 0
  const dispatched = plans.some(p => p.status === 'assigned' || p.status === 'sampled') || sampled
  const tested = sampled && recsBySample.every(rs => rs.length > 0)
  const allApproved = sampled && recsBySample.every(rs => rs.length > 0 && rs.every(r => r.status === 'approved'))
  const issued = reports.some(r => r.status === 'issued')
  const serials = recsBySample.flat().map(r => r.serial).filter(Boolean)
  const { stages, activeIndex } = buildStages(STAGE_DEFS({
    accept: c.id, scheme: c.scheme?.id ?? '待编制',
    dispatch: plans[0]?.id ?? '待下达',
    sampleIn: sampled ? `${samples.length} 个样品` : '待收样',
    testing: serials.length ? `${serials.length} 条记录` : '待录入',
    review: '记录复核审核',
    report: reports[0]?.id ?? '待生成',
    archive: '全链路可溯',
  }), [!!c.accepted_at, c.scheme?.status === 'approved', dispatched, sampled, tested, allApproved, issued, issued])
  return { stages, activeIndex, round: null }
}

function safeJson<T>(s: any, fallback: T): T {
  if (typeof s !== 'string') return (s ?? fallback) as T
  try { return JSON.parse(s) as T } catch { return fallback }
}

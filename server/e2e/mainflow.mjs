// 端到端串测：分岗账号走完 委托→方案→派工→采样→交接→派活→检测→三级审核→报告签发。
// 验的是「8 个岗位各司其职、全程不用 admin 代办」，以及各道合规闸门确实拦得住。
//
// 跑法（需要真起服务，不走单测内存库；放在 e2e/ 而非 test/，免得被 npm test 当单测捡起来）：
//   cd server && npm run e2e
// 端口被占时先 `lsof -ti:3997 | xargs kill -9`。
const B = `http://localhost:${process.env.E2E_PORT || 3997}/api`
const T = {}
async function login(u, p) {
  const r = await (await fetch(`${B}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()
  if (!r.token) throw new Error(`登录 ${u} 失败: ${r.error}`)
  T[u] = r.token; return r
}
async function call(who, method, path, body) {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T[who] }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`[${who}] ${method} ${path} → ${r.status} ${j?.error || ''}`)
  return j
}
const ok = (s) => console.log('  ✔', s)

// 0 建全岗位账号（admin）；新库种子账号要先改初始密码
await login('demo_admin', '123456')
try { await call('demo_admin','POST','/change-password',{ oldPassword:'123456', newPassword:'Pass1234' }); await login('demo_admin','Pass1234') } catch { await login('demo_admin','Pass1234') }
// 技术负责人也要能用（方案审核）
await login('demo_tech','123456').then(async()=>{ try { await call('demo_tech','POST','/change-password',{ oldPassword:'123456', newPassword:'Pass1234' }) } catch {} ; await login('demo_tech','Pass1234') }).catch(async()=>{ await login('demo_tech','Pass1234') })
const staff = [['reg1','周登记',['registrar']],['sam1','赵采样',['sampler']],['sam2','赵采样',['sampler']],
  ['qc1','吴质控',['qc']],['tst1','孙检测',['tester']],['rev1','周复核',['reviewer']],['apr1','吴审核',['approver']],['sgn1','郑签发',['signer']]]
for (const [u, n, roles] of staff) {
  try { await call('demo_admin','POST','/users',{ username: u, name: n, roles, password: 'init1234' }) } catch (e) { if (!String(e).includes('已存在')) throw e }
  await login(u, 'init1234').catch(()=>{})
  try { await call(u,'POST','/change-password',{ oldPassword:'init1234', newPassword:'Pass1234' }) } catch {}
  await login(u, 'Pass1234')
}
ok(`8 个分岗账号就绪`)

// 1 登记员录合同（PRD 步骤1）
const c = await call('reg1','POST','/contracts',{ client:'串测环保有限公司', project:'例行监测', periodStart:'2026-07-01', periodEnd:'2026-07-01' })
ok(`步骤1 登记员建合同 ${c.id}`)
await call('reg1','POST',`/contracts/${c.id}/accept`,{ review:{ conclusion:'能做' } })
ok('步骤1 确认受理（登记员）')

// 2 登记员编方案（以前只有 tech 能编 → 修复项）
await call('reg1','POST',`/contracts/${c.id}/scheme`,{ cycleMonths:0, periodStart:'2026-07-01', periodEnd:'2026-07-01',
  points:[{ element:'废水', point:'1#总排口', items:['COD'], freq:'每天1次 · 单次', standard:'GB8978-1996' }] })
ok('步骤2 登记员编方案')
try { await call('reg1','POST',`/contracts/${c.id}/scheme/review`,{ op:'approve' }); throw new Error('登记员不该能审方案') }
catch (e) { if (!String(e).includes('403')) throw e; ok('步骤2 登记员不能自审方案（编审分离）') }
await call('demo_tech','POST',`/contracts/${c.id}/scheme/review`,{ op:'approve' })
ok('步骤2 技术负责人审批方案 → 自动铺期次')
const points = await call('reg1','GET',`/contracts/${c.id}/points`)
if (!points.length) throw new Error('点位档案没建')
ok(`决策1 点位档案自动建档：${points[0].code} ${points[0].name}`)

// 3 质控员派工（以前 403 → 修复项）
const rounds = await call('reg1','GET',`/contracts/${c.id}/rounds`)
const R = rounds[0].id
await call('qc1','POST',`/rounds/${R}/assign`,{ samplerIds:['sam1','sam2'], planDate:'2026-07-01' })
ok('步骤3 质控员派工给两名采样员')

// 4 采样：双确认才能入库（§8.3）
await call('sam1','POST',`/rounds/${R}/field`,{ date:'2026-07-01', time:'09:30', weather:'晴' })
try { await call('sam1','POST',`/rounds/${R}/sample`); throw new Error('没双确认不该能入库') }
catch (e) { if (!String(e).includes('确认')) throw e; ok('§8.3 未双确认时收样入库被拦') }
await call('sam1','POST',`/rounds/${R}/confirm-field`)
await call('sam2','POST',`/rounds/${R}/confirm-field`)
const made = await call('sam1','POST',`/rounds/${R}/sample`)
const normal = made.filter(s => !s.qc_type)
ok(`步骤4 两人确认后入库 ${made.length} 个样品（含质控样）`)
ok(`决策9 样品编号新规：${normal[0].id}`)

// 5 交接闸 + 派检测任务（步骤5）
const S = normal[0].id
try { await call('tst1','POST','/records',{ sampleId:S, code:'HJ-TC-030', analyte:'COD', data:{rows:[]} }); throw new Error('未签收不该能录') }
catch (e) { if (!String(e).includes('签收')) throw e; ok('决策13 未签收不能录检测数据') }
const hos = await call('qc1','GET',`/samples/${S}/handovers`)
try { await call('sam1','POST',`/handovers/${hos[0].id}/confirm`); throw new Error('交样人不该能自己签收') }
catch (e) { if (!String(e).match(/403|自己/)) throw e; ok('决策13 交样人不能自己签收') }
await call('qc1','POST',`/handovers/${hos[0].id}/confirm`)
ok('步骤5 质控员确认签收')
try { await call('tst1','POST','/records',{ sampleId:S, code:'HJ-TC-030', analyte:'COD', data:{rows:[]} }); throw new Error('没派活不该能录') }
catch (e) { if (!String(e).includes('派检测任务')) throw e; ok('步骤5 未派任务不能录（期次样品）') }
await call('qc1','POST',`/samples/${S}/tasks`,{ items:[{ analyte:'COD', assignee:'孙检测', assigneeUsername:'tst1' }] })
ok('步骤5 质控员派检测任务 COD→孙检测')

// 6 检测 + 三级审核（同人校验）
const rec = await call('tst1','POST','/records',{ sampleId:S, code:'HJ-TC-030', analyte:'COD', data:{ rows:[{v:1}], resultSummary:{ analyte:'COD', value:22.5, unit:'mg/L' } }, submit:true })
ok(`步骤6 检测员录入并提交 ${rec.serial}`)
try { await call('tst1','POST',`/records/${rec.id}/review`,{ op:'review_pass' }); throw new Error('检测员不该能复核') }
catch (e) { if (!String(e).includes('403')) throw e; ok('三级审核 检测员不能自己复核（角色闸）') }
await call('rev1','POST',`/records/${rec.id}/review`,{ op:'review_pass' })
ok('步骤6 复核员复核通过')
await call('apr1','POST',`/records/${rec.id}/review`,{ op:'approve' })
ok('步骤6 审核员定稿')

// 7 报告：登记员编制 → 复核员审核 → 签字人签发（全链分岗）
const rep = await call('reg1','POST','/reports/generate-round',{ roundId:R })
ok(`步骤7 登记员编制报告 ${rep.id}`)
if (!rep.data?.process?.sampling?.sampler) throw new Error('报告没串采样过程')
ok(`决策17 报告串全过程：采样员 ${rep.data.process.sampling.sampler} · 点位 ${rep.data.process.points[0].name}`)
try { await call('reg1','POST',`/reports/${rep.id}/check`); throw new Error('编制人不该能审自己的报告') }
catch (e) { if (!String(e).match(/403|编制人/)) throw e; ok('§8.1 报告编制人不能自审') }
await call('rev1','POST',`/reports/${rep.id}/check`)
ok('步骤7 复核员审核报告')
await call('sgn1','POST',`/reports/${rep.id}/issue`)
ok('步骤7 签字人签发')
try { await call('reg1','POST',`/reports/${rep.id}/update`,{ conclusion:'偷改' }); throw new Error('签发后不该能改') }
catch (e) { if (!String(e).match(/403|已签发/)) throw e; ok('决策17 签发后锁死') }
await call('sgn1','POST',`/reports/${rep.id}/void`,{ reason:'串测：验证作废重出' })
ok('决策17 作废重出通道可用')

// 8 留痕可查
const audit = await call('rev1','GET',`/audit/${c.id}`)
ok(`留痕可查：合同 ${c.id} 有 ${audit.length} 条操作留痕（${[...new Set(audit.map(a=>a.action))].slice(0,5).join('、')}…）`)
console.log('\n🎉 端到端串测全过：8 个岗位各司其职，全流程无需 admin 代办')

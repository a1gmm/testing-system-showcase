// 数据库层：用 Node 内置 node:sqlite（零原生依赖）。
// 设计成能平滑迁到 PostgreSQL：灵活字段统一用 JSON 文本列存。
import { DatabaseSync } from 'node:sqlite'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { detectImageMime } from './attachmentSecurity.ts'

export type DB = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  id          TEXT PRIMARY KEY,          -- 唯一样品编号，如 W2026-0001
  client      TEXT,                      -- 受检单位
  matrix      TEXT,                      -- 基质：废水/地表水/...
  items       TEXT NOT NULL DEFAULT '[]',-- 检测项目 JSON 数组
  status      TEXT NOT NULL,             -- pending 待检测 | testing 检测中 | done 已完成
  note        TEXT,
  contract_id TEXT,                      -- 来自哪份委托合同（手工收样为空）
  round_id    TEXT,                      -- 来自哪一期监测（周期性项目：每期各建一批样品）
  source      TEXT NOT NULL DEFAULT 'field', -- field 受托采样(走委托/采样) | self 自送样(客户送检/凭空登记)
  qc_type     TEXT,                      -- 质控样类型：全程序空白/运输空白/现场平行；普通样为 NULL
  created_at  TEXT NOT NULL
);

-- 委托合同：一切的源头，样品从这里自动生成
CREATE TABLE IF NOT EXISTS contracts (
  id          TEXT PRIMARY KEY,          -- 委托单号，如 WT2026-0001
  client      TEXT NOT NULL,             -- 委托单位
  contact     TEXT,                      -- 联系人/电话
  project     TEXT,                      -- 工程/项目名称
  note        TEXT,
  status      TEXT NOT NULL,             -- draft 草稿 | confirmed 已生成样品 | terminated 已终止（新动作全拦，已有数据只读）
  doc_name    TEXT,                      -- 合同原件文件名
  doc_path    TEXT,                      -- 合同原件磁盘路径
  accepted_at TEXT,                      -- 受理时间（登记员「确认受理·合同评审通过」后）
  accepted_by TEXT,                      -- 受理人
  review_info TEXT,                      -- 合同评审 JSON {demand,ability,subcontract,risk,note}
  cycle_months INTEGER DEFAULT 0,        -- 监测周期(月)：签约时约定，0=单次 1=月 3=季 6=半年 12=年
  period_start TEXT,                     -- 合同/监测有效期 起
  period_end   TEXT,                     -- 合同/监测有效期 止
  quote_json  TEXT,                      -- 合同报价单 JSON（按示例纸质合同模板在线填写：明细行/合计/折后/大写）
  created_at  TEXT NOT NULL
);

-- 客户档案：委托单位独立建档，可存联系人/地址，按客户查历史合同。
-- name 与 contracts.client 对应（不改动 client 字段，零风险）；建合同时自动补建。
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,      -- 客户/委托单位名
  contact     TEXT,                      -- 联系人
  phone       TEXT,                      -- 电话（与联系人分列，体检26）
  address     TEXT,                      -- 地址
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- 监测方案 FA2026-XXXX：受理后编制，按要素列 点位×项目×频次×执行标准，审核通过才能排采样
CREATE TABLE IF NOT EXISTS schemes (
  id            TEXT PRIMARY KEY,        -- 方案号 FA2026-0001
  contract_id   TEXT NOT NULL,
  points        TEXT NOT NULL DEFAULT '[]', -- [{element要素, point点位, items[]检测项目, freq频次, standard执行标准}]
  limits        TEXT NOT NULL DEFAULT '[]', -- 达标限值 [{analyte项目, op ≤/≥/range, value, value2, unit, standard}]
  cycle_months  INTEGER DEFAULT 0,       -- 监测周期(月)：0=单次 1=每月 3=每季 6=每半年 12=每年
  period_start  TEXT,                    -- 监测有效期 起
  period_end    TEXT,                    -- 监测有效期 止
  status        TEXT NOT NULL,           -- draft 待审核 | approved 已批准 | rejected 打回
  reviewer      TEXT, reviewed_at TEXT,  -- 方案审核人/时间
  reject_reason TEXT,
  created_at    TEXT NOT NULL
);

-- 监测期次/排期：按方案的周期+有效期自动排出每一期采样日期。
-- 期次 = 周期项目的工作单元：派工、采样、检测、报告都按期走
CREATE TABLE IF NOT EXISTS rounds (
  id          TEXT PRIMARY KEY,          -- 期次号 WT2026-0003-R01
  contract_id TEXT NOT NULL,
  round_no    INTEGER NOT NULL,          -- 第几期
  due_date    TEXT NOT NULL,             -- 计划采样日期（到期提醒基准）
  items       TEXT NOT NULL DEFAULT '[]',-- 本期该采什么 [{matrix,items[],qty}]（各项周期不同，每期只采到期的）
  status      TEXT NOT NULL,             -- pending 待采 | done 已采样 | failed 未采成 | rescheduled 已改期 | cancelled 已终止（终态）
  plan_id     TEXT,                      -- （旧）关联采样任务，已由期次直管
  sampler     TEXT,                      -- 派工：采样员
  sampler_ids TEXT NOT NULL DEFAULT '[]',-- 派工真值：不可变用户 ID(username) JSON 数组；sampler 仅展示
  assignment_status TEXT NOT NULL DEFAULT 'unassigned', -- unassigned | active | revoked | quarantined
  assignment_updated_at TEXT,
  plan_date   TEXT,                      -- 派工：约定采样日
  sampled_at  TEXT,                      -- 实际收样入库时间
  field_info  TEXT,                      -- 现场采样原始记录 JSON {date,weather,temp,blank,parallel,note}
  fail_reason   TEXT,                    -- 采不成原因（企业停产/天气…）：status=failed 时有值
  orig_due_date TEXT,                    -- 改期前的原定采样日期（改期留痕）
  created_at  TEXT NOT NULL
);

-- 合同里约定的样品计划（每行 = 一种基质 + 检测项目 + 数量 + 各自的监测周期）
CREATE TABLE IF NOT EXISTS contract_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  matrix      TEXT NOT NULL,
  items       TEXT NOT NULL DEFAULT '[]',
  qty         INTEGER NOT NULL DEFAULT 1,
  cycle_months INTEGER DEFAULT 0,        -- 这一项的监测周期(月)：0=单次 1=月 3=季 6=半年 12=年
  note        TEXT
);

CREATE TABLE IF NOT EXISTS records (
  id            TEXT PRIMARY KEY,        -- uuid（系统内部主键）
  serial        TEXT,                    -- 人能看懂的连号 JL2026-0001，供溯源展示
  sample_id     TEXT NOT NULL,
  template_code TEXT NOT NULL,           -- 表号 HJ-TC-XXX
  template_name TEXT,
  sheet_type    TEXT,
  method        TEXT,
  analyte       TEXT,
  matrix        TEXT,
  instrument_id TEXT,                    -- 认领的仪器
  data          TEXT NOT NULL,           -- JSON {rows, meta, reg}
  -- 三级审核状态流：draft 草稿 → submitted 检验提交(待复核) → reviewed 复核通过(待审核)
  --               → approved 审核通过(定稿) ；rejected 被打回
  status        TEXT NOT NULL,
  reviewer      TEXT, reviewed_at TEXT,  -- 复核人/时间
  approver      TEXT, approved_at TEXT,  -- 审核人/时间
  reject_reason TEXT,                    -- 打回原因
  recheck        INTEGER NOT NULL DEFAULT 0, -- 超标复检标记：1=已标记需复检
  recheck_reason TEXT,                    -- 复检原因（超标等）
  updated_at    TEXT NOT NULL,
  UNIQUE(sample_id, template_code)
);

-- 人员台账 + 登录会话：操作留痕落到真实账号（评审必查）
CREATE TABLE IF NOT EXISTS users (
  username   TEXT PRIMARY KEY,           -- 登录名
  name       TEXT NOT NULL,              -- 姓名（留痕显示用）
  roles      TEXT NOT NULL DEFAULT '[]', -- 角色 JSON：admin/registrar/sampler/tester/qc/reviewer/approver/signer/tech
  pass_salt  TEXT NOT NULL,
  pass_hash  TEXT NOT NULL,              -- scrypt(password, salt)
  status     TEXT NOT NULL DEFAULT 'active',
  must_change_pw INTEGER NOT NULL DEFAULT 0, -- 1=初始/被重置密码，登录后必须先改密才能用系统
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen  TEXT                       -- 最后活动时间(ISO)：空闲超时按此判定，每次访问续期
);

-- 留痕表：只增不改（append-only），对应 2026 合规「记录更改全程留痕」
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  TEXT NOT NULL,              -- 被操作实体的编号（记录/合同/方案/期次/报告/用户…）
  who        TEXT NOT NULL,              -- 操作人姓名（显示用）
  username   TEXT,                       -- 操作人登录名（唯一回溯用，姓名可能重名）
  action     TEXT NOT NULL,              -- create|update|submit|review_pass|approve|reject|contract_accept|scheme_approve|round_sample|report_issue…
  detail     TEXT,                       -- JSON：本次改了哪些格子 / 审核意见 / 关键字段
  at         TEXT NOT NULL
);

-- 姓名派工升级账：一行期次只迁一次；无法唯一解析的旧姓名明确隔离，禁止猜测归属。
CREATE TABLE IF NOT EXISTS round_assignment_migrations (
  round_id          TEXT PRIMARY KEY,
  legacy_sampler    TEXT,
  status            TEXT NOT NULL,       -- migrated | quarantined | unassigned
  resolved_user_ids TEXT NOT NULL DEFAULT '[]',
  detail            TEXT,
  migrated_at       TEXT NOT NULL
);

-- 前处理记录（6.1.5）：消解/萃取/浓缩/定容等，只增不改
CREATE TABLE IF NOT EXISTS pretreatments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id   TEXT NOT NULL,
  method      TEXT NOT NULL,             -- 微波消解 / 电热板消解 / 萃取 / 浓缩 / 过滤 / 定容…
  reagent     TEXT,                      -- 所用试剂
  condition   TEXT,                      -- 条件（温度/时间等）
  vol_final   TEXT,                      -- 定容/最终体积
  note        TEXT,
  who         TEXT NOT NULL, username TEXT,
  at          TEXT NOT NULL
);

-- 样品交接 / 流转 / 留样 / 处置记录（6.1.4）：只增不改，记交接双方+样品状态+操作人
CREATE TABLE IF NOT EXISTS sample_handovers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id   TEXT NOT NULL,
  action      TEXT NOT NULL,              -- 采样交接 | 接样入库 | 流转领用 | 归还 | 留样 | 处置
  from_person TEXT,                       -- 交出人
  to_person   TEXT,                       -- 接收人
  condition   TEXT,                       -- 样品状态确认（完好 / 破损 / 量不足…）
  note        TEXT,
  who         TEXT NOT NULL,              -- 记录操作人姓名
  username    TEXT,                       -- 操作人登录名
  at          TEXT NOT NULL,
  confirmed_by TEXT,                      -- 接收方确认签收人（双签：发起后待接收，接收方确认）
  confirmed_at TEXT                       -- 确认签收时间
);

-- 交接单（2026-07-31 批次一）：把一期样品的逐条交接聚成"一张单"——收样自动生成草稿、
-- 可人工改、发质控员整单签收；拒收落在明细行（rejected+原因），被拒样品的逐条交接不确认
CREATE TABLE IF NOT EXISTS handover_sheets (
  id          TEXT PRIMARY KEY,              -- JJ2026-0001
  round_id    TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'field', -- field 现场采样 / self 送样（打印版式列显隐用）
  sample_ids  TEXT NOT NULL,                 -- JSON [样品编号]
  detail      TEXT NOT NULL DEFAULT '[]',    -- JSON 明细行 [{sampleId,items,condition,container,rejected,rejectReason}]
  from_person TEXT,                          -- 采/送样人
  from_at     TEXT,
  to_person   TEXT,                          -- 收样人（质控员，签收时落）
  to_at       TEXT,
  storage     TEXT,                          -- 保存条件说明
  status      TEXT NOT NULL DEFAULT 'draft', -- draft → sent → confirmed
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- 点位档案（决策1）：合同预设(contract) + 采样现场补(field)；实际位置与预设不同必须留痕，报告如实体现
CREATE TABLE IF NOT EXISTS monitoring_points (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id  TEXT NOT NULL,
  code         TEXT NOT NULL,              -- 点位编号 {合同号}-P{序号}，自动生成
  name         TEXT NOT NULL,              -- 点位名称（如"1#废水排口"）
  matrix       TEXT,                       -- 基质（水/气/土/噪声）
  source       TEXT NOT NULL DEFAULT 'contract',  -- contract 合同预设 / field 现场补
  planned_desc TEXT,                       -- 合同里写的位置描述
  actual_desc  TEXT,                       -- 实际采样位置（可与 planned 不同，改动留痕）
  coordinate   TEXT,
  remark       TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(contract_id, name)
);

-- 检测任务派工：质控员收样签收后，把每个样品的检测项目派给指定检测员（PRD 步骤5）
CREATE TABLE IF NOT EXISTS test_tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id         TEXT NOT NULL,
  analyte           TEXT NOT NULL,          -- 检测项目（须来自样品的项目清单）
  assignee          TEXT NOT NULL,          -- 检测员姓名
  assignee_username TEXT,
  assigned_by       TEXT NOT NULL,          -- 派工人（质控员）
  assigned_at       TEXT NOT NULL,
  UNIQUE(sample_id, analyte)                -- 同一样品同一项目只有一个负责人，重派即改派
);

-- 检测任务通知单 HJ-TC-137（2026-07-31 批次一）：质控员从已签收交接单一键生成、承办人单签、
-- 下达即按样品×项目建"待认领"任务（assignee=''，检测员认领或质控员指派）。一张交接单只出一张通知单。
CREATE TABLE IF NOT EXISTS test_notices (
  id              TEXT PRIMARY KEY,             -- TZ2026-0001
  sheet_id        TEXT NOT NULL UNIQUE,
  round_id        TEXT,
  contract_id     TEXT,
  category        TEXT,                         -- 任务类别（污水/地下水/废气…按介质映射，多介质顿号并列）
  nature          TEXT DEFAULT '自行监测',       -- 任务性质（自行监测/环评监测/验收检测/其他）
  source          TEXT DEFAULT '现场采样',       -- 样品来源（现场检测/现场采样/来样检测/其他）
  sample_desc     TEXT,                         -- 样品份数/状态（如"3份无色无味液体"）
  groups_json     TEXT NOT NULL,                -- [{sampleId, analytes[]}] 检测项目按样品分组
  received_at     TEXT,                         -- 接样时间（=交接单签收时间）
  due_at          TEXT,                         -- 完成时间（可含分项说明，见 note）
  dept            TEXT DEFAULT '环境室',         -- 承接科室（拍板8：不分科室，固定值）
  issuer          TEXT, issuer_username TEXT,   -- 承办人（质控员，单签）
  status          TEXT NOT NULL DEFAULT 'draft',-- draft → issued
  issued_at       TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL
);

-- 报告发放登记（批次三）：签发后对外发放的份数/方式/领取人留痕（纸质流程的取报告凭证对应物）
CREATE TABLE IF NOT EXISTS report_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   TEXT NOT NULL,
  copies      INTEGER NOT NULL DEFAULT 1,
  method      TEXT NOT NULL DEFAULT '自取',   -- 自取 | 邮寄 | 电子送达
  receiver    TEXT,                           -- 领取人/收件人
  deliverer   TEXT NOT NULL,                  -- 发放人
  deliverer_username TEXT,
  at          TEXT NOT NULL,
  note        TEXT
);

-- 留样与处置（批次三，老决策"留样+处置记录要管"落地）：一样品一条，处置后只读
CREATE TABLE IF NOT EXISTS sample_retention (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id      TEXT NOT NULL UNIQUE,
  location       TEXT NOT NULL,               -- 留样位置（柜号）
  until_date     TEXT,                        -- 留存期限
  registered_by  TEXT NOT NULL,
  registered_at  TEXT NOT NULL,
  disposed_at    TEXT,
  disposed_by    TEXT,
  dispose_method TEXT,
  note           TEXT
);

-- 公司主数据（批次二地基1）：报告抬头/地址/证书号等全站取用，单行表（id 恒为 1）
CREATE TABLE IF NOT EXISTS org_profile (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  name      TEXT NOT NULL,
  name_en   TEXT,
  address   TEXT,
  postcode  TEXT,
  phone     TEXT,
  fax       TEXT,
  cma_no    TEXT,                          -- CMA 资质认定证书编号
  note      TEXT
);

-- 质量控制记录（6.1.5）：密码样/平行样/加标回收/空白，自动判合格，只增不改
CREATE TABLE IF NOT EXISTS qc_records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  qc_type      TEXT NOT NULL,             -- 密码样 | 平行样 | 加标回收 | 空白
  round_id     TEXT,                      -- 关联期次（可空）
  sample_id    TEXT,                      -- 关联样品（可空）
  analyte      TEXT,                      -- 检测项目
  data         TEXT,                      -- JSON：各类型的原始数值
  unit         TEXT,
  result       REAL,                      -- 自动算：相对偏差% / 回收率% / 相对误差%
  verdict      TEXT,                      -- 合格 | 不合格
  criterion    TEXT,                      -- 判定依据文字
  note         TEXT,
  who          TEXT NOT NULL, username TEXT,
  at           TEXT NOT NULL
);

-- 质量体系运行记录（6.2/管理体系）：内审 / 管评 / 培训 / 文件受控…统一台账，可更新状态
CREATE TABLE IF NOT EXISTS system_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL,             -- 内部审核 | 管理评审 | 人员培训 | 文件受控 | 监督检查 | 其他
  title       TEXT NOT NULL,             -- 记录标题，如“2026年度内部审核”
  rec_date    TEXT,                      -- 记录/发生日期
  owner       TEXT,                      -- 负责人 / 责任部门
  status      TEXT NOT NULL,             -- 计划中 | 进行中 | 已完成
  content     TEXT,                      -- 明细内容（参训人员/受控清单/输入项…）
  result      TEXT,                      -- 结论 / 结果 / 整改情况
  note        TEXT,
  who         TEXT NOT NULL, username TEXT,
  at          TEXT NOT NULL, updated_at TEXT
);

-- 分包管理（6.1.2）：分包给有资质实验室，核查资质+委托方同意+结果核验
CREATE TABLE IF NOT EXISTS subcontracts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id   TEXT,                      -- 关联委托单号
  items         TEXT,                      -- 分包的检测项目
  subcontractor TEXT NOT NULL,             -- 分包方（承接实验室）
  qualification TEXT,                      -- 分包方资质证号 CMA/CNAS
  reason        TEXT,                      -- 分包原因
  consent       INTEGER NOT NULL DEFAULT 0,-- 委托方是否书面同意 0/1
  status        TEXT NOT NULL,             -- 计划中 | 已分包 | 结果已核
  result_note   TEXT,                      -- 分包结果核验情况
  note          TEXT,
  who           TEXT NOT NULL, username TEXT,
  at            TEXT NOT NULL, updated_at TEXT
);

-- 检测计划 / 排产派工：从合同生成，派采样员+采样日期
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,          -- 采样任务单号 RW2026-0001
  contract_id TEXT,
  client      TEXT,
  sampler     TEXT,                      -- 采样员
  plan_date   TEXT,                      -- 计划采样日期
  status      TEXT NOT NULL,             -- pending 待派工 | assigned 已派工 | sampled 已采样
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- 仪器台账：认领用 + 检定/校准到期提醒
CREATE TABLE IF NOT EXISTS instruments (
  id          TEXT PRIMARY KEY,          -- 仪器编号 TC-004
  name        TEXT NOT NULL,             -- 名称
  model       TEXT,                      -- 型号
  status      TEXT NOT NULL,             -- normal 正常 | busy 使用中 | repair 维修
  cert_until  TEXT,                      -- 检定/校准有效期（到期提醒基准）
  cert_no     TEXT,                      -- 证书编号
  note        TEXT
);

-- 仪器领用/归还台账：采样/检测领设备→登记，用完归还；领用时记检定是否在有效期（过期只警告仍放行）
CREATE TABLE IF NOT EXISTS instrument_checkouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_id TEXT NOT NULL,
  round_id      TEXT,                        -- 为哪一期采样领（可空）
  taken_by      TEXT NOT NULL,               -- 领用人
  taken_at      TEXT NOT NULL,
  cert_ok_at_checkout INTEGER NOT NULL DEFAULT 1, -- 领用时检定是否在有效期（0=已过期仍领，警告留痕）
  returned_by   TEXT,                        -- 归还登记人
  returned_at   TEXT,
  status        TEXT NOT NULL                -- out 在外 | returned 已还
);

-- 标准物质台账（6.2.4）：效期提醒
CREATE TABLE IF NOT EXISTS ref_materials (
  id          TEXT PRIMARY KEY,          -- 编号
  name        TEXT NOT NULL,             -- 名称
  batch       TEXT,                      -- 批号
  spec        TEXT,                      -- 规格 / 标准值
  expiry      TEXT,                      -- 有效期
  stock       TEXT,                      -- 库存量
  supplier    TEXT,                      -- 厂家
  cert_no     TEXT,                      -- 证书号
  deleted     INTEGER NOT NULL DEFAULT 0,-- 软删标记（体检16）：台账不物理删，留痕可查
  created_at  TEXT NOT NULL
);

-- 试剂耗材台账（6.2.5）：效期提醒
CREATE TABLE IF NOT EXISTS reagents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  spec        TEXT,                      -- 规格
  grade       TEXT,                      -- 级别（分析纯/优级纯…）
  batch       TEXT,
  expiry      TEXT,                      -- 有效期
  stock       TEXT,                      -- 库存
  supplier    TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0,-- 软删标记（体检16）
  created_at  TEXT NOT NULL
);

-- 记录附件（6.1.4/6.1.5 佐证）：采样交接/实验室分析等每类记录都可挂照片/小票。
-- 通用表：entity_type + entity_id 指向任意记录。选传不强制。
-- 只增；删除为软删（deleted_at 标记，文件不物理删），配合 audit_log 保链式证据完整。
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,          -- uuid
  entity_type TEXT NOT NULL,             -- record | handover | pretreatment | qc | system_record
  entity_id   TEXT NOT NULL,             -- 关联记录主键（统一转字符串）
  orig_name   TEXT NOT NULL,             -- 原始文件名（下载时给用户看）
  stored_name TEXT NOT NULL,             -- 落盘文件名（uuid+扩展名，存 UPLOAD_DIR）
  mime        TEXT,
  size        INTEGER,
  who         TEXT NOT NULL,             -- 上传人姓名
  username    TEXT,                      -- 上传人登录名
  at          TEXT NOT NULL,             -- 上传时间
  deleted_at  TEXT,                      -- 软删标记（NULL=有效）
  deleted_by  TEXT                       -- 删除人登录名
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);

-- 离线附件暂存账本。文件正文位于独立 staging 目录；这里记录幂等键、内容身份与租约。
CREATE TABLE IF NOT EXISTS staged_attachments (
  receipt_id          TEXT PRIMARY KEY,
  round_id            TEXT NOT NULL,
  sample_slot_id      TEXT NOT NULL,
  client_attachment_id TEXT NOT NULL,
  owner_id            TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  mime                TEXT NOT NULL,
  size                INTEGER NOT NULL,
  revision            INTEGER NOT NULL,
  stored_name         TEXT,
  blob                BLOB,
  generation          INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL,
  lease_expires_at    TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(round_id, owner_id, device_id, client_attachment_id)
);
CREATE TABLE IF NOT EXISTS staged_attachment_refs (receipt_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, PRIMARY KEY(receipt_id,ref_type,ref_id));
CREATE TABLE IF NOT EXISTS device_request_nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(device_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_device_request_nonces_expiry ON device_request_nonces(expires_at);

-- 移动现场提交协调器：永久绑定 client_submission_id 与 canonical payload hash。
-- canonical_payload 是服务端收到并校验的历史证据；正式发布产物与永久回执同事务写入。
CREATE TABLE IF NOT EXISTS mobile_submissions (
  client_submission_id TEXT PRIMARY KEY,
  receipt_id            TEXT NOT NULL UNIQUE,
  round_id              TEXT NOT NULL,
  owner_id              TEXT NOT NULL,
  device_id             TEXT NOT NULL,
  task_version          TEXT NOT NULL,
  rule_version          TEXT NOT NULL,
  draft_revision        INTEGER NOT NULL,
  payload_hash          TEXT NOT NULL,
  canonical_payload     TEXT NOT NULL,
  attachment_receipts   TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL,
  publication_json      TEXT,
  error_code            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_mobile_submissions_status_updated ON mobile_submissions(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_mobile_submissions_round_owner ON mobile_submissions(round_id, owner_id);

CREATE TABLE IF NOT EXISTS offline_rule_versions (
  rule_version TEXT PRIMARY KEY,
  form_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','retired')),
  reason TEXT,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO offline_rule_versions(rule_version,form_code,status,updated_at)
VALUES('HJ-TC-136@provisional-v1','HJ-TC-136','active','2026-08-17T00:00:00.000Z');
CREATE TABLE IF NOT EXISTS offline_task_versions (
  round_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mobile_sample_slots (
  sample_slot_id TEXT PRIMARY KEY,
  temporary_id TEXT NOT NULL UNIQUE,
  round_id TEXT NOT NULL,
  matrix TEXT NOT NULL,
  items TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','voided')),
  parent_slot_id TEXT,
  official_sample_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  UNIQUE(round_id,matrix,sequence)
);
CREATE INDEX IF NOT EXISTS idx_mobile_sample_slots_round ON mobile_sample_slots(round_id,state,sequence);
CREATE TABLE IF NOT EXISTS mobile_submission_confirmations (
  client_submission_id TEXT NOT NULL,
  confirmer_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  task_version TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  rule_version TEXT NOT NULL,
  summary_hash TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY(client_submission_id,confirmer_id)
);
CREATE TABLE IF NOT EXISTS mobile_confirmation_invites (
  claim_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_submission_id TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  intended_confirmer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('issued','claimed','used')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  used_at TEXT
);

-- 期次现场表单：采样员在现场按精确版式填的采样原始记录（一期一表号一份；收样入库/报告签发后冻结）
CREATE TABLE IF NOT EXISTS round_sheets (
  id            TEXT PRIMARY KEY,        -- uuid
  round_id      TEXT NOT NULL,           -- 关联期次
  template_code TEXT NOT NULL,           -- 模板库表号 HJ-TC-xxx
  data          TEXT NOT NULL,           -- 整张表数据 JSON {rows,meta,cells,compRows…}
  who           TEXT NOT NULL,           -- 最后保存人姓名
  username      TEXT,                    -- 最后保存人登录名
  updated_at    TEXT NOT NULL,
  UNIQUE(round_id, template_code)
);

-- 检测报告：汇总某样品/合同已定稿的记录
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,          -- 报告号 BG2026-0001
  sample_id   TEXT,                      -- 单样品报告（免采样/散样用）
  round_id    TEXT,                      -- 期次报告：一期一份，汇总该期全部样品
  contract_id TEXT,
  client      TEXT,
  title       TEXT,
  conclusion  TEXT,                      -- 结论
  data        TEXT NOT NULL,             -- JSON：结果明细 [{analyte,result,unit,limit,method}]
  status      TEXT NOT NULL,             -- 报告三级：draft 编制(待审核) | checked 已审核(待签发) | issued 已签发
  checker     TEXT, checked_at TEXT,     -- 报告审核人/时间
  issuer      TEXT, issued_at TEXT,      -- 签发人/时间(盖章)
  created_at  TEXT NOT NULL
);
`

// 迁移不能带着半套 schema 继续服务：只有「列已存在」是幂等重试，
// 磁盘满、锁死、表损坏等错误必须向上抛出，由进程停止启动。
export function addColumn(db: DB, sql: string) {
  try { db.exec(sql) } catch (e: any) {
    const msg = String(e?.message || e)
    if (!/duplicate column/i.test(msg)) throw new Error(`[迁移] ALTER 失败：${sql} → ${msg}`, { cause: e })
  }
}
// 回填 UPDATE 也必须在启动前完成，避免新代码读到一半新一半旧的数据。
export function backfill(db: DB, sql: string, why: string) {
  try { db.exec(sql) } catch (e: any) {
    throw new Error(`[迁移] 回填失败：${why} → ${String(e?.message || e)}`, { cause: e })
  }
}

// 老库 rounds.sampler 是姓名顿号串。只有每个姓名都唯一命中 users 时才回填 immutable username；
// 重名、缺账号或脏数据进入 quarantined，管理角色核对并重新派工前不向任何采样员开放。
export function migrateRoundAssignments(db: DB) {
  let rows: any[]
  try {
    rows = db.prepare(`SELECT id, sampler, status, field_info FROM rounds WHERE assignment_status IS NULL OR assignment_status=''`).all() as any[]
  } catch (e: any) {
    console.error(`[迁移] 期次派工 ID 回填失败（继续启动，下次启动会重试）：${String(e?.message || e)}`)
    return
  }
  for (const row of rows) {
    const legacyNames = String(row.sampler || '').split('、').map((x: string) => x.trim()).filter(Boolean)
    if (!legacyNames.length) {
      const at = new Date().toISOString()
      db.exec('SAVEPOINT migrate_round_assignment')
      try {
        db.prepare(`UPDATE rounds SET sampler_ids='[]', assignment_status='unassigned', assignment_updated_at=? WHERE id=? AND (assignment_status IS NULL OR assignment_status='')`).run(at, row.id)
        db.prepare(`INSERT INTO round_assignment_migrations
          (round_id, legacy_sampler, status, resolved_user_ids, detail, migrated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(round_id) DO NOTHING`)
          .run(row.id, row.sampler, 'unassigned', '[]', JSON.stringify({ reason: 'legacy_unassigned' }), at)
        db.exec('RELEASE migrate_round_assignment')
      } catch (e) {
        db.exec('ROLLBACK TO migrate_round_assignment')
        db.exec('RELEASE migrate_round_assignment')
        console.error(`[迁移] 期次 ${row.id} 空派工回填失败（已回滚，下次启动会重试）：${String((e as any)?.message || e)}`)
      }
      continue
    }
    const resolved: string[] = []
    const failures: { name: string; matches: string[] }[] = []
    for (const name of legacyNames) {
      const matches = (db.prepare(`SELECT username FROM users WHERE name=? ORDER BY username`).all(name) as any[]).map(u => String(u.username))
      if (matches.length === 1) resolved.push(matches[0])
      else failures.push({ name, matches })
    }
    const uniqueIds = [...new Set(resolved)]
    const migrationStatus = failures.length ? 'quarantined' : 'migrated'
    const assignmentStatus = failures.length ? 'quarantined' : (row.status === 'cancelled' ? 'revoked' : 'active')
    let fieldInfo = row.field_info
    if (!failures.length && fieldInfo) {
      try {
        const parsed = JSON.parse(fieldInfo)
        const legacyConfirms = parsed?.confirms && typeof parsed.confirms === 'object' ? parsed.confirms : {}
        const confirmations: Record<string, { name: string; at: string }> = { ...(parsed?.confirmations || {}) }
        for (const id of uniqueIds) {
          const name = (db.prepare(`SELECT name FROM users WHERE username=?`).get(id) as any)?.name
          if (name && legacyConfirms[name] && !confirmations[id]) confirmations[id] = { name, at: legacyConfirms[name] }
        }
        const { confirms: _legacy, ...rest } = parsed
        fieldInfo = JSON.stringify({ ...rest, ...(Object.keys(confirmations).length ? { confirmations } : {}) })
      } catch { /* 脏 field_info 不妨碍派工迁移；原值留存供人工核对 */ }
    }
    const at = new Date().toISOString()
    db.exec('SAVEPOINT migrate_round_assignment')
    try {
      db.prepare(`UPDATE rounds SET sampler_ids=?, assignment_status=?, assignment_updated_at=?, field_info=?
        WHERE id=? AND (assignment_status IS NULL OR assignment_status='')`)
        .run(failures.length ? '[]' : JSON.stringify(uniqueIds), assignmentStatus, at, fieldInfo, row.id)
      db.prepare(`INSERT INTO round_assignment_migrations
        (round_id, legacy_sampler, status, resolved_user_ids, detail, migrated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(round_id) DO NOTHING`)
        .run(row.id, row.sampler, migrationStatus, JSON.stringify(failures.length ? [] : uniqueIds),
          JSON.stringify(failures.length ? { reason: 'name_not_uniquely_resolvable', failures } : { names: legacyNames }), at)
      db.exec('RELEASE migrate_round_assignment')
    } catch (e) {
      db.exec('ROLLBACK TO migrate_round_assignment')
      db.exec('RELEASE migrate_round_assignment')
      console.error(`[迁移] 期次 ${row.id} 派工 ID 回填失败（已回滚，下次启动会重试）：${String((e as any)?.message || e)}`)
    }
  }
}

export type OpenDbOptions={legacyStagingDir?:string;unlinkFile?:(path:string)=>void;skipLegacyCleanup?:boolean;beforeCleanupMarker?:()=>void}
export function resolveLegacyStagingDir(uploadDir:string,override?:string){return override||resolve(uploadDir,'.staging')}
export function openDb(path = 'data.db',options:OpenDbOptions={}): DB {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN sample_slot_id TEXT NOT NULL DEFAULT ''`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN client_attachment_id TEXT NOT NULL DEFAULT ''`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN device_id TEXT NOT NULL DEFAULT ''`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN mime TEXT NOT NULL DEFAULT ''`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN size INTEGER NOT NULL DEFAULT 0`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN stored_name TEXT`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN blob BLOB`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN generation INTEGER NOT NULL DEFAULT 1`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN status TEXT NOT NULL DEFAULT 'legacy_pending'`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN lease_expires_at TEXT NOT NULL DEFAULT ''`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`)
  addColumn(db, `ALTER TABLE staged_attachments ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_staged_attachments_lease ON staged_attachments(status,lease_expires_at);CREATE TABLE IF NOT EXISTS staged_attachment_refs(receipt_id TEXT NOT NULL,ref_type TEXT NOT NULL,ref_id TEXT NOT NULL,PRIMARY KEY(receipt_id,ref_type,ref_id));CREATE TABLE IF NOT EXISTS device_request_nonces(device_id TEXT NOT NULL,nonce TEXT NOT NULL,issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(device_id,nonce));CREATE INDEX IF NOT EXISTS idx_device_request_nonces_expiry ON device_request_nonces(expires_at);`)
  // 老库平滑升级：给已存在的表补新列（新库 SCHEMA 里已含，加列时「已存在」静默、其他错误留日志）
  addColumn(db, 'ALTER TABLE audit_log ADD COLUMN username TEXT')
  addColumn(db, 'ALTER TABLE sessions ADD COLUMN last_seen TEXT')
  // 加列故意不带 NOT NULL DEFAULT：老行先落成 NULL，让下面的幂等回填认得出「还没回填过」
  addColumn(db, 'ALTER TABLE users ADD COLUMN must_change_pw INTEGER')
  addColumn(db, 'ALTER TABLE reports ADD COLUMN checker TEXT')
  addColumn(db, 'ALTER TABLE reports ADD COLUMN checked_at TEXT')
  addColumn(db, 'ALTER TABLE samples ADD COLUMN source TEXT')
  addColumn(db, 'ALTER TABLE rounds ADD COLUMN fail_reason TEXT')
  addColumn(db, 'ALTER TABLE rounds ADD COLUMN orig_due_date TEXT')
  addColumn(db, 'ALTER TABLE rounds ADD COLUMN sampler_ids TEXT')
  addColumn(db, 'ALTER TABLE rounds ADD COLUMN assignment_status TEXT')
  addColumn(db, 'ALTER TABLE rounds ADD COLUMN assignment_updated_at TEXT')
  addColumn(db, 'ALTER TABLE records ADD COLUMN recheck INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'ALTER TABLE records ADD COLUMN recheck_reason TEXT')
  addColumn(db, 'ALTER TABLE sample_handovers ADD COLUMN confirmed_by TEXT')
  addColumn(db, 'ALTER TABLE sample_handovers ADD COLUMN confirmed_at TEXT')
  addColumn(db, 'ALTER TABLE contracts ADD COLUMN quote_json TEXT')
  addColumn(db, 'ALTER TABLE contracts ADD COLUMN phone TEXT')               // 业务联系人电话（与姓名分列，打印合同分栏带出）
  addColumn(db, 'ALTER TABLE samples ADD COLUMN qc_type TEXT')               // S4 质控样标记，普通样为 NULL
  addColumn(db, 'ALTER TABLE records ADD COLUMN author TEXT')                // 记录编制人（同人校验用）
  addColumn(db, 'ALTER TABLE reports ADD COLUMN author TEXT')                // 报告编制人（同人校验用）
  addColumn(db, 'ALTER TABLE contract_samples ADD COLUMN point TEXT')        // 计划行携带点位名
  addColumn(db, 'ALTER TABLE samples ADD COLUMN point_name TEXT')
  addColumn(db, 'ALTER TABLE monitoring_points ADD COLUMN stack_info TEXT')  // 批次二地基3：排气筒静态参数 JSON（DA编号/高度/内径/工艺/燃料…）
  // 合同评审状态机（拍板7）：技术负责人签批。同意= tech_approved_at 落时间；不同意只留意见与结果
  addColumn(db, 'ALTER TABLE contracts ADD COLUMN tech_approved_by TEXT')
  addColumn(db, 'ALTER TABLE contracts ADD COLUMN tech_approved_at TEXT')
  addColumn(db, 'ALTER TABLE contracts ADD COLUMN tech_approve_note TEXT')
  addColumn(db, 'ALTER TABLE contracts ADD COLUMN tech_review_result TEXT')
  addColumn(db, 'ALTER TABLE samples ADD COLUMN point_code TEXT')
  addColumn(db, 'ALTER TABLE reports ADD COLUMN voided INTEGER NOT NULL DEFAULT 0')  // 报告作废（决策17）
  addColumn(db, 'ALTER TABLE reports ADD COLUMN void_reason TEXT')
  addColumn(db, 'ALTER TABLE reports ADD COLUMN voided_by TEXT')
  addColumn(db, 'ALTER TABLE reports ADD COLUMN voided_at TEXT')
  addColumn(db, 'ALTER TABLE reports ADD COLUMN reissue_of TEXT')            // 重出自哪份作废报告
  // 同人校验改按登录名（姓名会重名/改名）：记录/报告各关键角色补 username 列，老数据为空回退姓名比对
  addColumn(db, 'ALTER TABLE records ADD COLUMN author_username TEXT')
  addColumn(db, 'ALTER TABLE records ADD COLUMN reviewer_username TEXT')
  addColumn(db, 'ALTER TABLE reports ADD COLUMN author_username TEXT')
  addColumn(db, 'ALTER TABLE reports ADD COLUMN checker_username TEXT')
  addColumn(db, 'ALTER TABLE reports ADD COLUMN issuer_username TEXT')
  // 报价「每年N次」精确排期：计划行记住 per_year，铺期次时一年正好排 N 期
  addColumn(db, 'ALTER TABLE contract_samples ADD COLUMN per_year INTEGER')
  // 客户电话分列（体检26）：contact 只放联系人，电话单独一列
  addColumn(db, 'ALTER TABLE customers ADD COLUMN phone TEXT')
  // 标物/试剂软删（体检16）：删除改标记，台账行留档可查；带 DEFAULT 0，老行自动落 0=有效
  addColumn(db, 'ALTER TABLE ref_materials ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'ALTER TABLE samples ADD COLUMN replaced_by TEXT')   // 拒收样补采后指向新样（补采闭环）
  addColumn(db, 'ALTER TABLE users ADD COLUMN cert_name TEXT')       // 人员授权/上岗证名称（2026新规）
  addColumn(db, 'ALTER TABLE users ADD COLUMN cert_until TEXT')      // 授权有效期：过期拦签发、进资源预警
  addColumn(db, 'ALTER TABLE contracts ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0')  // 加急标记：列表置顶+红标
  addColumn(db, 'ALTER TABLE test_tasks ADD COLUMN due_at TEXT')     // 完成时限：通知单下达时落到任务，检测员可见
  addColumn(db, 'ALTER TABLE reagents ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')

  // —— 幂等回填：条件只认 NULL（=还没回填过的老行），每次启动都跑，失败过也能自动补 ——
  // 存量账号（含默认口令的老账号）一律要求下次登录改密；新库/新账号由代码显式写 0/1，不受影响
  backfill(db, 'UPDATE users SET must_change_pw=1 WHERE must_change_pw IS NULL', 'users.must_change_pw 老账号强制改密')
  // 老样品补来源：既无委托又无期次的是自送样，其余是受托采样
  backfill(db, "UPDATE samples SET source='self' WHERE source IS NULL AND contract_id IS NULL AND round_id IS NULL", 'samples.source 自送样回填')
  backfill(db, "UPDATE samples SET source='field' WHERE source IS NULL", 'samples.source 受托采样回填')
  migrateRoundAssignments(db)
  if(options.legacyStagingDir)migrateLegacyStagedFiles(db,options.legacyStagingDir,options)
  return db
}

function legacyPath(directory:string,name:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.(?:jpe?g|png|webp|heic))?$/i.test(name))throw new Error('LEGACY_STORED_NAME_INVALID');const root=resolve(directory),file=resolve(root,name);if(!file.startsWith(root+sep))throw new Error('LEGACY_PATH_ESCAPE');return file}
function secureRead(file:string){const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('LEGACY_FILE_NOT_REGULAR');const nofollow=(constants as any).O_NOFOLLOW??0,fd=openSync(file,constants.O_RDONLY|nofollow);try{if(!fstatSync(fd).isFile())throw new Error('LEGACY_FILE_NOT_REGULAR');return readFileSync(fd)}finally{closeSync(fd)}}
function migrateLegacyStagedFiles(db: DB, directory: string,options:OpenDbOptions) {
  const unlinkFile=options.unlinkFile??unlinkSync
  const cleanup=()=>{if(options.skipLegacyCleanup)return;const rows=db.prepare(`SELECT receipt_id,stored_name FROM staged_attachments WHERE blob IS NOT NULL AND cleanup_pending=1 AND stored_name IS NOT NULL`).all() as any[];for(const row of rows){try{const file=legacyPath(directory,String(row.stored_name));try{unlinkFile(file)}catch(error:any){if(error?.code!=='ENOENT')throw error}db.exec('BEGIN IMMEDIATE');try{options.beforeCleanupMarker?.();db.prepare(`UPDATE staged_attachments SET stored_name=NULL,cleanup_pending=0,updated_at=? WHERE receipt_id=? AND cleanup_pending=1`).run(new Date().toISOString(),row.receipt_id);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}}catch(error){console.error(`[迁移] 暂存附件 ${row.receipt_id} 旧文件待下次清理：${String((error as any)?.message||error)}`)}}}
  cleanup()
  const rows=db.prepare(`SELECT receipt_id,round_id,stored_name,content_hash,mime,size,status FROM staged_attachments WHERE blob IS NULL AND stored_name IS NOT NULL AND status NOT IN ('cancelled','expired')`).all() as any[]
  for(const row of rows){const now=new Date().toISOString();let bytes:Buffer;try{bytes=secureRead(legacyPath(directory,String(row.stored_name)))}catch{db.prepare(`UPDATE staged_attachments SET status='storage_error',updated_at=? WHERE receipt_id=?`).run(now,row.receipt_id);continue}const hash=createHash('sha256').update(bytes).digest('hex'),magic=detectImageMime(bytes);if(hash!==row.content_hash||bytes.length!==row.size||magic!==row.mime){db.prepare(`UPDATE staged_attachments SET status='storage_error',updated_at=? WHERE receipt_id=?`).run(now,row.receipt_id);continue}db.exec('BEGIN IMMEDIATE');try{db.prepare(`UPDATE staged_attachments SET blob=?,status='uploaded_staged',cleanup_pending=1,updated_at=? WHERE receipt_id=?`).run(bytes,now,row.receipt_id);db.prepare(`INSERT INTO audit_log(record_id,who,username,action,detail,at) VALUES(?,?,?,?,?,?)`).run(row.round_id,'system',null,'attachment_legacy_migrated',JSON.stringify({receipt_id:row.receipt_id,stored_name:row.stored_name}),now);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}}
  cleanup()
}

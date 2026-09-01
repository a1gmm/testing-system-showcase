import { mount } from '@vue/test-utils'
import { expect, test } from 'vitest'
import ArchiveFormalRecord from '../src/components/ArchiveFormalRecord.vue'

function archiveItem(entityType: string, snapshot: Record<string, unknown>) {
  return {
    id: 41,
    archive_package_id: 'ARCHIVE-1',
    item_order: 7,
    entity_type: entityType,
    entity_id: `${entityType}-41`,
    workflow_instance_id: entityType.endsWith('_workflow') ? 'WF-41' : null,
    revision: entityType.endsWith('_workflow') ? 2 : null,
    content_hash: 'a'.repeat(64),
    label: `${entityType} 冻结记录`,
    metadata: { snapshot },
  } as any
}

test('水和废水交接单按 HJ-TC-135 正式版式呈现样品明细', () => {
  const wrapper = mount(ArchiveFormalRecord, { props: { item: archiveItem('handover_sheet', {
    id: 'JJ2026-0003', contract_id: 'WT2026-0002', source: 'field', storage: '常温',
    from_person: '林工程师、赵采样', from_at: '2026-09-01T00:22:00.000Z',
    to_person: '', to_at: null,
    sample_ids: ['W260901-3', 'W260901-00', 'W260901-4'],
    detail: [
      { sampleId: 'W260901-3', items: ['氨氮', '化学需氧量'], container: '', condition: '完好' },
      { sampleId: 'W260901-00', items: ['氨氮', '化学需氧量'], container: '', condition: '完好' },
      { sampleId: 'W260901-4', items: ['氨氮', '化学需氧量'], container: '', condition: '完好' },
    ],
  }) } })

  expect(wrapper.get('[data-form-number]').text()).toBe('HJ-TC-135')
  expect(wrapper.get('h3').text()).toBe('水和废水交接记录表')
  expect(wrapper.findAll('thead th').map(cell => cell.text())).toEqual([
    '样品编号', '检测项目', '容器保存方法', '采样记录及样品运储检查',
  ])
  expect(wrapper.get('.detail-table tbody').text()).toContain('W260901-3')
  expect(wrapper.get('.detail-table tbody').text()).toContain('氨氮、化学需氧量')
  expect(wrapper.get('.detail-table tbody').text()).toContain('样品完整无异常')
  expect(wrapper.text()).not.toContain('sample_ids')
  expect(wrapper.find('.archive-object').exists()).toBe(false)
})

test('废气、客户送样和拒收样品使用各自的正式交接单变体', () => {
  const gas = mount(ArchiveFormalRecord, { props: { item: archiveItem('handover_sheet', {
    id: 'JJ2026-0004', contract_id: 'WT2026-0003', source: 'field', matrix: '废气',
    detail: [{ sampleId: 'G260901-1', matrix: '废气', items: ['颗粒物'], rejected: true, rejectReason: '容器破损' }],
  }) } })
  expect(gas.get('[data-form-number]').text()).toBe('HJ-TC-596')
  expect(gas.get('h3').text()).toBe('环境空气、废气样品交接单')
  expect(gas.text()).toContain('拒收：容器破损')

  const selfDelivered = mount(ArchiveFormalRecord, { props: { item: archiveItem('handover_sheet', {
    id: 'JJ2026-0005', contract_id: 'WT2026-0004', source: 'self', from_person: '张送样',
    detail: [{ sampleId: 'W260901-8', point: '总排口', items: ['COD'], container: '玻璃瓶' }],
  }) } })
  expect(selfDelivered.get('[data-form-number]').text()).toBe('HJ-TC-135-1')
  expect(selfDelivered.findAll('thead th').map(cell => cell.text())).toContain('点位')
  expect(selfDelivered.text()).toContain('送样人 / 时间')
})

test('冻结工作流使用业务记录表呈现关键信息和签批，不暴露内部 JSON 结构', () => {
  const cases = [
    ['sampling_workflow', '现场采样审核记录表', {
      roundId: 'WT2026-0002-R01', contractId: 'WT2026-0002',
      fieldInfo: { date: '2026-09-01', weather: '晴', temp: '23℃', point: '总排口' },
      plan: [{ matrix: '废水', items: ['氨氮'], qty: 3 }],
      sampleSlots: [{ officialSampleId: 'W260901-3', matrix: '废水', items: ['氨氮'], state: 'published' }],
      mobileConfirmations: [{ confirmerId: 'demo_admin', confirmedAt: '2026-09-01T00:27:00.000Z' }],
      roundSheets: [], attachments: [{ id: 'ATT-1', hash: 'b'.repeat(64) }],
    }],
    ['quality_plan_workflow', '质量控制安排表', {
      authorUsername: 'demo_admin', updatedAt: '2026-09-01T00:30:00.000Z',
      requirements: [{ qcType: '全程序空白', matrix: '废水', qty: 1, basis: '水/废水每批1个' }],
      adjustments: [],
    }],
  ] as const

  for (const [entityType, title, snapshot] of cases) {
    const item = archiveItem(entityType, snapshot as any)
    item.metadata.decisions = [
      { level: 'review', decision: 'approve', decided_by: 'demo_tech', decided_at: '2026-09-01T00:31:00.000Z' },
      { level: 'approve', decision: 'approve', decided_by: 'demo_qc', decided_at: '2026-09-01T00:32:00.000Z' },
    ]
    const wrapper = mount(ArchiveFormalRecord, { props: { item } })

    expect(wrapper.get('h3').text()).toBe(title)
    expect(wrapper.text()).toContain('复核')
    expect(wrapper.text()).toContain('审核')
    expect(wrapper.find('.archive-object').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/roundSheets|sampleSlots|mobileConfirmations|requirements|authorUsername/)
    expect(wrapper.text()).not.toContain('bbbbbbbbbbbbbbbb')
  }
})

test('第 1 至第 8 步的普通归档类型都有明确业务表名而不是通用记录内容', () => {
  const cases = [
    ['contract', '委托检测信息表', { id: 'WT-1', client: '甲厂', contact: '张经理', project: '例行监测', quote_json: '{"rows":[{"category":"废水","point":"总排口","items":["COD"],"qty":1}]}' }],
    ['contract_review', '检测业务合同评审记录表', { reviewInfo: { manpower: true, instruments: true, environment: true, method: true, subcontract: false }, acceptedBy: '王登记', acceptedAt: '2026-09-01T00:25:00.000Z', result: 'approve', approvedBy: '钱技术' }],
    ['scheme', '监测方案记录表', { id: 'FA-1', contract_id: 'WT-1', points: '[{"element":"废水","point":"总排口","items":["COD"],"freq":"1次/天"}]', limits: '[{"analyte":"COD","op":"≤","value":50,"unit":"mg/L"}]', reviewer: '钱技术' }],
    ['assignment', '专业复核与审核人员指派表', { contract_id: 'WT-1', scope: 'sampling', reviewer_username: 'reviewer', approver_username: 'approver', active: 1, assigned_by: 'planner' }],
    ['round', '现场采样任务指派表', { id: 'R-1', contract_id: 'WT-1', round_no: 1, due_date: '2026-09-01', sampler: '赵采样', items: '[{"matrix":"废水","items":["COD"],"qty":1}]' }],
    ['sample', '样品登记表', { id: 'W260901-1', client: '甲厂', matrix: '废水', items: ['COD'], source: 'field', status: 'testing' }],
    ['sample_handover', '样品流转交接记录表', { sample_id: 'W260901-1', action: '采样交接', from_person: '赵采样', to_person: '钱收样', condition: '完好', confirmed_by: '钱收样' }],
    ['test_notice', '检测任务通知单', { id: 'TZ-1', category: '废水', nature: '自行监测', source: '现场采样', groups: [{ sampleId: 'W260901-1', analytes: ['COD'] }], issuer: '吴质控' }],
    ['test_task', '检测任务指派表', { sample_id: 'W260901-1', analyte: 'COD', assignee: '王分析', assigned_by: '吴质控' }],
    ['pretreatment', '样品前处理记录表', { sample_id: 'W260901-1', method: '消解', reagent: '重铬酸钾', condition: '165℃ 15min', vol_final: '50mL', who: '王分析' }],
    ['qc_record', '质量控制结果记录表', { qc_type: '平行样', sample_id: 'W260901-1', analyte: 'COD', data: { first: 20, second: 20.4 }, result: 0.99, unit: '%', verdict: '合格', criterion: '相对偏差≤10%' }],
    ['report_batch', '报告批次范围表', { id: 'BATCH-1', contract_id: 'WT-1', name: '第一批报告', round_ids: ['R-1'] }],
  ] as const

  for (const [entityType, title, snapshot] of cases) {
    const wrapper = mount(ArchiveFormalRecord, { props: { item: archiveItem(entityType, snapshot as any) } })
    expect(wrapper.get('h3').text(), entityType).toBe(title)
    expect(wrapper.find('table').exists(), entityType).toBe(true)
    expect(wrapper.find('.archive-object').exists(), entityType).toBe(false)
    expect(wrapper.text(), entityType).not.toContain('记录内容')
  }
})

test('审计留痕把内部动作和变更 JSON 转成人能复核的表格', () => {
  const wrapper = mount(ArchiveFormalRecord, { props: { item: archiveItem('audit_entry', {
    record_id: 'W260901-1', action: 'submit', who: '林工程师', username: 'demo_admin',
    detail: '{"revision":2,"changes":[{"row":1,"col":"a","from":"1","to":"3"}]}',
    at: '2026-09-01T00:37:00.000Z',
  }) } })

  expect(wrapper.get('h3').text()).toBe('电子记录操作留痕表')
  expect(wrapper.text()).toContain('提交复核')
  expect(wrapper.text()).toContain('第 2 版')
  expect(wrapper.text()).toContain('第 2 行')
  expect(wrapper.text()).toContain('a：1 → 3')
  expect(wrapper.text()).not.toMatch(/record_id|"revision"|"changes"|"row"|"col"/)
})

test('未知历史类型仍有安全的正式表格回退，且内部完整性字段不外显', () => {
  const populated = mount(ArchiveFormalRecord, { props: { item: archiveItem('future_record', {
    result: '合格', payload_hash: 'internal-secret', nested: { value: 12.3, receipt_id: 'hidden-receipt' },
  }) } })
  expect(populated.get('h3').text()).toBe('future_record 冻结记录')
  expect(populated.text()).toContain('合格')
  expect(populated.text()).toContain('12.3')
  expect(populated.text()).not.toContain('internal-secret')
  expect(populated.text()).not.toContain('hidden-receipt')

  const empty = mount(ArchiveFormalRecord, { props: { item: archiveItem('future_record', {
    payload_hash: 'internal-secret',
  }) } })
  expect(empty.get('.empty-row').text()).toBe('以下空白')
  expect(empty.get('.empty-row').attributes('colspan')).toBe('2')
})

test('损坏或缺字段的历史快照可降级呈现，不输出 NaN 或原始 JSON', () => {
  for (const snapshot of [null, [], '{broken-json']) {
    const wrapper = mount(ArchiveFormalRecord, { props: { item: archiveItem('contract', snapshot as any) } })
    expect(wrapper.get('h3').text()).toBe('委托检测信息表')
    expect(wrapper.text()).not.toContain('NaN')
    expect(wrapper.text()).not.toContain('{broken-json')
  }
})

test('质量安排把人工调整和默认要求分表固化', () => {
  const wrapper = mount(ArchiveFormalRecord, { props: { item: archiveItem('quality_plan_workflow', {
    authorUsername: 'quality-1', requirements: [{ qcType: '全程序空白', matrix: '废水', qty: 1 }],
    adjustments: [{ qcType: '现场平行', matrix: '废水', analyte: 'COD', qty: 2, note: '加密抽查' }],
  }) } })
  expect(wrapper.findAll('.detail-section')).toHaveLength(2)
  expect(wrapper.text()).toContain('质量控制要求')
  expect(wrapper.text()).toContain('人工调整')
  expect(wrapper.text()).toContain('加密抽查')
})

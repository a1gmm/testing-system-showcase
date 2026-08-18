import type { Schema } from '../schemas'

function n(v: any): number | null { const x = parseFloat(v); return isFinite(x) ? x : null }
const r3 = (x: number) => Math.round(x * 1000) / 1000

// ── HJ604-2017 非甲烷总烃（废气）气相色谱法 双通道 ──
// 总烃(扣氧峰)、甲烷各自查曲线得 φ(μmol/mol)；ρ=φ×16/22.4(以甲烷计)；
// 非甲烷总烃 ρ_NMHC=(ρ_THC−ρ_CH4)×12/16(以碳计)
const nmhcGC: Schema = {
  id: 'nmhcGC',
  title: () => '非甲烷总烃 气相色谱法 原始记录表（双通道）',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 90 },
    { key: 'aThc', label: '总烃峰面积', kind: 'input', group: '总烃通道', w: 90 },
    { key: 'aO2', label: '氧峰面积', kind: 'input', group: '总烃通道', w: 80 },
    { key: 'phiThc', label: '总烃查得φ(扣氧)', unit: 'μmol/mol', kind: 'input', group: '总烃通道', w: 110 },
    { key: 'rhoThc', label: '总烃ρ', unit: 'mg/m³', kind: 'auto', group: '总烃通道', w: 80 },
    { key: 'aCh4', label: '甲烷峰面积', kind: 'input', group: '甲烷通道', w: 90 },
    { key: 'phiCh4', label: '甲烷查得φ', unit: 'μmol/mol', kind: 'input', group: '甲烷通道', w: 100 },
    { key: 'rhoCh4', label: '甲烷ρ', unit: 'mg/m³', kind: 'auto', group: '甲烷通道', w: 80 },
    { key: 'nmhc', label: '非甲烷总烃(以碳计)', unit: 'mg/m³', kind: 'auto', w: 110 },
    { key: 'note', label: '备注', kind: 'input', w: 70 },
  ],
  compute(row: Record<string, any>) {
    const phiT = n(row.phiThc), phiM = n(row.phiCh4)
    const rhoThc = phiT == null ? null : r3(phiT * 16 / 22.4)
    const rhoCh4 = phiM == null ? null : r3(phiM * 16 / 22.4)
    const nmhc = (rhoThc == null || rhoCh4 == null) ? null : r3((rhoThc - rhoCh4) * 12 / 16)
    return { rhoThc, rhoCh4, nmhc }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', fixed: true, wide: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '色谱柱', key: 'column' },
    { label: '柱温/检测器', key: 'detector' },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
  ],
  latex: '\\rho=\\varphi\\times\\dfrac{16}{22.4}\\;;\\quad \\rho_{NMHC}=(\\rho_{THC}-\\rho_{CH_4})\\times\\dfrac{12}{16}',
  regression: true,
  curveCheck: true,
  signRoles: ['检验', '复核', '审核'],
  seed: () => [{ id: '', aThc: '', aO2: '', phiThc: '', aCh4: '', phiCh4: '', note: '' }],
}

// ── HJ1261-2022 固定污染源废气 苯系物 气相色谱法（8组分，多组分标签页）──
// ρ=((A₁−a)/b)×(M/Vm)×D；此处以查得浓度 φ(μmol/mol) 录入：ρ=φ×M/Vm×D，Vm参比状态24.5
const benzeneSeriesGC: Schema = {
  id: 'benzeneSeriesGC',
  title: () => '固定污染源废气 苯系物 气相色谱法 原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'area', label: '峰面积A₁', kind: 'input', w: 90 },
    { key: 'phi', label: '查得浓度φ', unit: 'μmol/mol', kind: 'input', w: 100 },
    { key: 'M', label: '摩尔质量M', unit: 'g/mol', kind: 'input', w: 90 },
    { key: 'D', label: '稀释倍数D', kind: 'input', w: 70 },
    { key: 'rho', label: '结果ρ', unit: 'mg/m³', kind: 'auto', w: 90 },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute(row: Record<string, any>, ctx: any) {
    const phi = n(row.phi), M = n(row.M), D = n(row.D) ?? 1
    const Vm = n(ctx?.meta?.Vm) ?? 24.5
    if (phi == null || M == null) return { rho: null }
    return { rho: r3(phi * M / Vm * D) }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', fixed: true, wide: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '摩尔体积Vm', key: 'Vm', fixed: true },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
    { label: '各组分摩尔质量', key: 'mNote', fixed: true, wide: true },
  ],
  latex: '\\rho\\,(mg/m^3)=\\dfrac{A_1-a}{b}\\times\\dfrac{M}{V_m}\\times D',
  regression: true,
  curveCheck: true,
  signRoles: ['检验', '复核', '审核'],
  seed: () => [{ id: '', area: '', phi: '', M: '', D: 1, note: '' }],
}

export const gcForms: Record<string, Schema> = {
  'HJ-TC-230': nmhcGC,
  'HJ-TC-184': nmhcGC, // 非甲烷总烃·废气 HJ38（双通道同族）
  'HJ-TC-611': benzeneSeriesGC,
}

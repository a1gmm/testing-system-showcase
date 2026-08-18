import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../src/data/schemas'

// 计算正确性自检：给每个版式配"标准算例"，直接跑真实 compute 函数验证。
// 公式被改坏时这里立刻变红。ctx = { meta, reg(回归a/b/r) }。
type Ctx = { meta: Record<string, any>; reg: { a: number; b: number; r?: number } }
const ctx = (meta: Record<string, any> = {}, reg = { a: 0, b: 1 }): Ctx => ({ meta, reg })

const byCode = (code: string) => resolveSchema('原始记录', '', code)

interface Case { name: string; schema: any; row: Record<string, any>; ctx?: Ctx; key: string; expect: number }

const cases: Case[] = [
  // 通用分光光度：ρ=(A−A₀−a)/b×(定容/取样)×K。net=0.5,vdef=50,V=10,K=1 → 0.5×5=2.5
  { name: 'photometric ÷V', schema: resolveSchema('原始记录', '分光光度'),
    row: { a: 0.5, a0: 0, V: 10, K: 1 }, ctx: ctx({ vdef: 50 }), key: 'rho', expect: 2.5 },
  // 土壤金属AAS：w=(ρ×V×D)/(m×Wdm/100)。1×25×1/(0.2×0.95)=131.58
  { name: 'soilMetalAAS 407', schema: byCode('HJ-TC-407'),
    row: { rho: 1, vdef: 25, d: 1, m: 0.2, wdm: 95 }, key: 'w', expect: 131.58 },
  // 废水石墨炉AAS：ρ=ρ查×D。5×2=10
  { name: 'waterMetalGFAAS 725', schema: byCode('HJ-TC-725'),
    row: { rhoii: 5, d: 2 }, key: 'rho', expect: 10 },
  // 通用水样AAS：(ρ₁−ρ₀)×(V₁/V)×f。(5−1)×(50/10)×1=20
  { name: 'waterMetalAAS 466', schema: byCode('HJ-TC-466'),
    row: { rho1: 5, rho0: 1, v: 10, v1: 50, f: 1 }, key: 'rho', expect: 20 },
  // 原子荧光：ρ=ρ₁×f×V₁/V。2×1×50/5=20
  { name: 'afsMetal 577', schema: byCode('HJ-TC-577'),
    row: { rho1: 2, f: 1, v1: 50, v: 5 }, key: 'rho', expect: 20 },
  // 冷原子吸收测汞：同 photometric ÷V。0.5/1×(50/10)×1=2.5
  { name: 'mercuryCV 017', schema: byCode('HJ-TC-017'),
    row: { a: 0.5, a0: 0, V: 10, Vf: 50, K: 1 }, ctx: ctx({ vdef: 50 }), key: 'rho', expect: 2.5 },
  // COD重铬酸盐：(V₀−V₁)×c×8000/V×f。(25−15)×0.25×8000/50=400
  { name: 'codTitration 103', schema: byCode('HJ-TC-103'),
    row: { v0: 25, v1: 15, V: 50, f: 1 }, ctx: ctx({ c: 0.25 }), key: 'cod', expect: 400 },
  // 热灼减率：(m₁−m₂)/(m₁−m₀)×100。(30−25)/(30−20)×100=50
  { name: 'ignitionLoss 471', schema: byCode('HJ-TC-471'),
    row: { m0: 20, m1: 30, m2: 25 }, key: 'p', expect: 50 },
  // 双波长总氮 Ar：(0.5−0.2)−(0.01−0.01)=0.3
  { name: 'dualWaveSample 097 Ar', schema: byCode('HJ-TC-097'),
    row: { b220: 0.01, b275: 0.005, s220: 0.5, s275: 0.1, V: 10, K: 1 }, ctx: ctx({ vdef: 50 }), key: 'ar', expect: 0.3 },
  // 双波长总氮 ρ：0.3/1×(50/10)×1=1.5
  { name: 'dualWaveSample 097 ρ', schema: byCode('HJ-TC-097'),
    row: { b220: 0.01, b275: 0.005, s220: 0.5, s275: 0.1, V: 10, K: 1 }, ctx: ctx({ vdef: 50 }), key: 'rho', expect: 1.5 },
  // 非甲烷总烃双通道：ρ_THC=10×16/22.4=7.143；NMHC=(7.143−1.429)×12/16=4.286
  { name: 'nmhcGC 230 THC', schema: byCode('HJ-TC-230'),
    row: { phiThc: 10, phiCh4: 2 }, key: 'rhoThc', expect: 7.143 },
  { name: 'nmhcGC 230 NMHC', schema: byCode('HJ-TC-230'),
    row: { phiThc: 10, phiCh4: 2 }, key: 'nmhc', expect: 4.286 },
  // 废气光度：ρ=m/Vnd。5/10=0.5
  { name: 'photometricGas 440', schema: byCode('HJ-TC-440'),
    row: { m: 5, vnd: 10 }, key: 'rho', expect: 0.5 },
  // 废气重量：ΔW/Vnd。(150−100)/0.5=100
  { name: 'gravimetricGas 574', schema: byCode('HJ-TC-574'),
    row: { w1: 100, w2: 150, vnd: 0.5 }, key: 'rho', expect: 100 },
  // 叶绿素a：[11.85×0.5−1.54×0.1−0.08×0.05]×10/(1×1)=57.67
  { name: 'chlorophyll 601', schema: byCode('HJ-TC-601'),
    row: { a664: 0.5, a647: 0.1, a630: 0.05, a750: 0, ve: 10, vs: 1, d: 1 }, key: 'chla', expect: 57.67 },
  // 褪色法净信号：A₀−A=0.3（方向不能反）
  { name: 'decolorCalib 191 net', schema: byCode('HJ-TC-191'),
    row: { a0: 0.5, a: 0.2 }, key: 'net', expect: 0.3 },
  // 通用滴定：(消耗−空白)×C×M×1000/V。(12.4−0.2)×0.1×8×1000/50=195.2
  { name: 'titration', schema: resolveSchema('原始记录', '容量滴定'),
    row: { v1: 0, v2: 12.4, v0: 0.2, V: 50 }, ctx: ctx({ C: 0.1, M: 8 }), key: 'rho', expect: 195.2 },
  // 石油类红外：[0.1+0.05+(0.02−0.05)]×(50/500)=0.12×0.1=0.012
  { name: 'irOil 094', schema: byCode('HJ-TC-094'),
    row: { a2930: 0.1, a2960: 0.05, a3030: 0.02, vw: 500, v0: 50, d: 1, rho0: 0 },
    ctx: ctx({ coefX: 1, coefY: 1, coefZ: 1, coefF: 2 }), key: 'rho', expect: 0.012 },
  // 双波长校准净信号：Ar=A₂₂₀−2A₂₇₅=0.3
  { name: 'dualWaveCalib 098 Ar', schema: byCode('HJ-TC-098'),
    row: { a220: 0.5, a275: 0.1 }, key: 'ar', expect: 0.3 },
]

describe('版式计算自检（标准算例）', () => {
  for (const c of cases) {
    it(c.name, () => {
      const out = c.schema.compute(c.row, c.ctx ?? ctx())
      expect(out[c.key], `${c.name}: 期望 ${c.key}=${c.expect}，实得 ${out[c.key]}`).toBeCloseTo(c.expect, 2)
    })
  }
})

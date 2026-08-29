import { describe, expect, it } from 'vitest'
import { resolveSchema, type Schema } from '../src/data/schemas'
import { schemaColumns } from '../src/data/resultProjection'

type ExpectedContract = {
  code?: string
  method?: string
  id: string
  key: string
}

const contracts: ExpectedContract[] = [
  { method: '分光光度', id: 'photometric', key: 'rho' },
  { method: '容量滴定', id: 'titration', key: 'rho' },
  { method: '重量法', id: 'gravimetric', key: 'rho' },
  { method: '离子色谱', id: 'ic', key: 'rho' },
  { method: '气相色谱', id: 'chromatographySample', key: 'rho' },
  { method: '微生物', id: 'micro', key: 'result' },
  { method: '声级', id: 'noise', key: 'leq' },
  { method: '', id: 'generic', key: 'result' },
  { code: 'HJ-TC-550', id: 'phMeter', key: 'ph' },
  { code: 'HJ-TC-638', id: 'doMeter', key: 'do' },
  { code: 'HJ-TC-071', id: 'bod5', key: 'bod' },
  { code: 'HJ-TC-0418', id: 'conductivity', key: 'ec' },
  { code: 'HJ-TC-112', id: 'chroma', key: 'result' },
  { code: 'HJ-TC-041', id: 'photometricGas', key: 'rho' },
  { code: 'HJ-TC-037', id: 'mercuryCVGas', key: 'rho' },
  { code: 'HJ-TC-574', id: 'gravimetricGas', key: 'rho' },
  { code: 'HJ-TC-103', id: 'codTitration', key: 'cod' },
  { code: 'HJ-TC-601', id: 'chlorophyll', key: 'chla' },
  { code: 'HJ-TC-029', id: 'soilMetalAAS', key: 'w' },
  { code: 'HJ-TC-725', id: 'waterMetalGFAAS', key: 'rho' },
  { code: 'HJ-TC-466', id: 'waterMetalAAS_μgL', key: 'rho' },
  { code: 'HJ-TC-569', id: 'waterMetalAAS_mgL', key: 'rho' },
  { code: 'HJ-TC-017', id: 'mercuryCV', key: 'rho' },
  { code: 'HJ-TC-577', id: 'afsMetal', key: 'rho' },
  { code: 'HJ-TC-230', id: 'nmhcGC', key: 'nmhc' },
  { code: 'HJ-TC-611', id: 'benzeneSeriesGC', key: 'rho' },
  { code: 'HJ-TC-097', id: 'dualWaveSample', key: 'rho' },
  { code: 'HJ-TC-471', id: 'ignitionLoss', key: 'p' },
  { code: 'HJ-TC-565', id: 'soilPhotometric', key: 'w' },
  { code: 'HJ-TC-094', id: 'irOil', key: 'rho' },
  { code: 'HJ-TC-118', id: 'noxAir', key: 'rho' },
  { code: 'HJ-TC-278', id: 'sulfuricMist278', key: 'result' },
  { code: 'HJ-TC-066', id: 'electrodeSurfaceWaterF', key: 'rho' },
  { code: 'HJ-TC-068', id: 'electrodeGroundWaterF', key: 'rho' },
  { code: 'HJ-TC-056', id: 'electrodeAirF', key: 'rho' },
  { code: 'HJ-TC-128', id: 'electrodeWasteGasF', key: 'resultAvg' },
  { code: 'HJ-TC-119', id: 'ambientAirPM119', key: 'c' },
  { code: 'HJ-TC-139', id: 'ambientAirTSP139', key: 'c' },
  { code: 'HJ-TC-140', id: 'stackDust140', key: 'dustMeasured' },
  { code: 'HJ-TC-709', id: 'stackDust709', key: 'dustMeasured' },
  { code: 'HJ-TC-475', id: 'dustfall475', key: 'dustfall' },
]

function resolveContract(item: ExpectedContract): Schema {
  return resolveSchema('原始记录', item.method ?? '', item.code)
}

describe('report result schema coverage', () => {
  for (const contract of contracts) {
    it(`${contract.id} declares the real report result column`, () => {
      const schema = resolveContract(contract)
      expect(schema.id).toBe(contract.id)
      expect(schema.result?.key).toBe(contract.key)
      expect(schemaColumns(schema).some(column => column.key === contract.key)).toBe(true)
    })
  }
})

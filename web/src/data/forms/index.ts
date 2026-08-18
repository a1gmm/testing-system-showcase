import type { Schema } from '../schemas'
import { stackGasForms } from './stackGas'
import { olfactoryForms } from './olfactory'
import { oilRecoveryForms } from './oilRecovery'
import { samplingForms } from './sampling'
import { solutionPrepForms } from './solutionPrep'
import { electrodeForms } from './electrode'
import { filterForms } from './filter'
import { soilMetalForms } from './soilMetal'
import { waterMetalForms } from './waterMetal'
import { afsMetalForms } from './afsMetal'
import { gcForms } from './gcForms'
import { directForms } from './directForms'
import { gasForms } from './gasForms'
import { specialForms } from './specialForms'
import { fieldSurveyForms } from './fieldSurveys'

// 各家族 1:1 还原的固定版式表汇总（按表号精确命中，优先于按方法猜的通用 schema）
export const FORMS: Record<string, Schema> = {
  ...stackGasForms,
  ...olfactoryForms,
  ...oilRecoveryForms,
  ...samplingForms,
  ...solutionPrepForms,
  ...electrodeForms,
  ...filterForms,
  ...soilMetalForms,
  ...waterMetalForms,
  ...afsMetalForms,
  ...gcForms,
  ...directForms,
  ...gasForms,
  ...specialForms,
  ...fieldSurveyForms,
}

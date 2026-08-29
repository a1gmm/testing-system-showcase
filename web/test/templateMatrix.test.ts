import { describe, expect, test } from 'vitest'
import { templateMatchesSampleMatrix } from '../src/data/templateMatrix'

describe('模板基质安全推断', () => {
  test('已修订的水质色度表可用于水样', () => {
    expect(templateMatchesSampleMatrix({
      matrix: '', analyte: '色度', raw: '112-1色度原始记录',
      meta: { basis: 'HJ1182-2021', detectionLimit: '2倍' },
    }, '废水')).toBe(true)
  })

  test('缺基质且证据同时指向水和空气时失败关闭', () => {
    const ambiguous = { matrix: '', raw: '水质与环境空气共用草稿', meta: { detectionLimit: '0.1mg/L；0.1mg/m³' } }
    expect(templateMatchesSampleMatrix(ambiguous, '废水')).toBe(false)
    expect(templateMatchesSampleMatrix(ambiguous, '环境空气')).toBe(false)
  })

  test('没有任何介质证据时失败关闭', () => {
    expect(templateMatchesSampleMatrix({ matrix: '', raw: '通用记录表' }, '废水')).toBe(false)
  })

  test.each(['有组织废气', '无组织废气'])(
    '废气模板接受规范化后的样品别名 %s',
    sampleMatrix => {
      expect(templateMatchesSampleMatrix({ matrix: '废气' }, sampleMatrix)).toBe(true)
    },
  )

  test.each([
    ['环境空气', { raw: '环境空气采样原始记录', meta: { detectionLimit: '0.01mg/m³' } }],
    ['土壤', { raw: '土壤测定原始记录', meta: { detectionLimit: '1mg/kg' } }],
    ['固废', { raw: '固体废物浸出毒性原始记录' }],
    ['噪声', { raw: '环境噪声声级测量记录', meta: { detectionLimit: '30dB' } }],
  ])('缺少显式基质时可从单一证据推断 %s', (sampleMatrix, template) => {
    expect(templateMatchesSampleMatrix(template, sampleMatrix as string)).toBe(true)
  })

  test('未知样品基质失败关闭', () => {
    expect(templateMatchesSampleMatrix({ raw: '水质测定', meta: { detectionLimit: '1mg/L' } }, '生物')).toBe(false)
  })

  test('显式模板基质优先于互相冲突的文本证据', () => {
    const explicitWater = { matrix: '废水', raw: '环境空气字样', meta: { detectionLimit: '1mg/m³' } }
    expect(templateMatchesSampleMatrix(explicitWater, '废水')).toBe(true)
    expect(templateMatchesSampleMatrix(explicitWater, '废气')).toBe(false)
  })
})

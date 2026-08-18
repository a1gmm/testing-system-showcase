import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import FieldTaskWorkbench from '../src/offline/FieldTaskWorkbench.vue'
import { createFieldTaskDraft, type OfflineTaskPackage } from '../src/offline/fieldTaskDraft'

const packageData: OfflineTaskPackage = { signature: 'valid-signature', signedPayload: {
  schemaVersion: 1, roundId: 'ROUND-1', assigneeId: 'user-a', deviceId: 'mdm-1', deviceBindingPublicKeySpki: 'test', deviceBindingFingerprint: 'test', formCode: 'HJ-TC-136', ruleVersion: 'HJ-TC-136@provisional-v1', taskVersion: 'v1', taskVersionOrdinal: 1, samplingDate: '2026-08-16',
  sampleSlots: [{ sampleSlotId: '00000000-0000-4000-8000-000000000001', temporaryId:'00000000-0000-4000-8000-000000000101', qrPayload:'TC1:00000000-0000-4000-8000-000000000101', matrix: '废水', items: ['COD'] }],
  formSchema: { globalFields: ['org', 'orgSign', 'samplingDate'], rowFields: ['sampleSlotId', 'sampleNo', 'point', 'time', 'item', 'volume', 'preserve', 'waterColor', 'smell', 'oil', 'floating', 'anomaly', 'note'] },
  authorization: { scope: 'field-draft-write', deviceId: 'mdm-1', attestationId: 'att-1', nonce: 'n', issuedAt: '2026-08-16T08:00:00Z', serverTime: '2026-08-16T08:00:00Z', expiresAt: '2026-08-17T08:00:00Z' },
} }
const draft = createFieldTaskDraft(packageData, 1_000_000)

describe('mobile field task workbench', () => {
  test('each input is serialized to its sample slot and real save button flushes focused value', async () => {
    let revision = 0
    const saveField = vi.fn(async (command) => ({ ...draft, payload: { ...draft.payload, draftRevision: ++revision, localSavedAt: '2026-08-16T08:05:00.000Z' } }))
    const authorize = vi.fn(async () => true)
    const wrapper = mount(FieldTaskWorkbench, { props: { draft, online: false, editable: true, authorize, saveField } })
    await wrapper.get('[data-testid="row-0-point"]').setValue('1号排口')
    await wrapper.get('[data-testid="field-org-sign"]').setValue('客户签字')
    await wrapper.get('[data-primary-action="true"]').trigger('click')
    await vi.waitFor(() => expect(saveField).toHaveBeenCalledTimes(3))
    expect(saveField.mock.calls[0][0]).toMatchObject({ scope: 'row', sampleSlotId: '00000000-0000-4000-8000-000000000001', field: 'point', value: '1号排口', expectedRevision: 0 })
    expect(saveField.mock.calls[1][0]).toMatchObject({ scope: 'global', field: 'orgSign', value: '客户签字', expectedRevision: 1 })
    expect(saveField.mock.calls[2][0]).toMatchObject({ scope: 'global', field: 'orgSign', value: '客户签字', expectedRevision: 2 })
    expect(authorize).toHaveBeenCalledTimes(3)
    expect(wrapper.findAll('[data-primary-action="true"]')).toHaveLength(1)
    expect(wrapper.findAll('button').map(button => button.text())).not.toContain('正式提交')
  })

  test('live authorization denial blocks the next input without losing visible draft', async () => {
    const saveField = vi.fn(); const authorize = vi.fn(async () => false)
    const wrapper = mount(FieldTaskWorkbench, { props: { draft, online: false, editable: true, authorize, saveField } })
    await wrapper.get('[data-testid="row-0-point"]').setValue('不会落库')
    await vi.waitFor(() => expect(wrapper.text()).toContain('授权已失效'))
    expect(saveField).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('00000000-0000-4000-8000-000000000001')
  })

  test('readonly state and approved warm light surface remain explicit', () => {
    const wrapper = mount(FieldTaskWorkbench, { props: { draft, online: false, editable: false, readonlyReason: '任务已改派', authorize: vi.fn(), saveField: vi.fn() } })
    expect(wrapper.get('[data-testid="readonly-reason"]').text()).toContain('任务已改派')
    expect(wrapper.get('[data-testid="field-org"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="field-workbench"]').classes()).toContain('field-workbench--light')
    expect(wrapper.html()).not.toContain('dark')
  })

  test('sample-slot photo card shows truthful file-level state and never a formal-submit action', async () => {
    const addAttachment = vi.fn(async () => undefined)
    const wrapper = mount(FieldTaskWorkbench, { props: { draft, online: true, editable: true, authorize: vi.fn(async () => true), saveField: vi.fn(), attachmentController: {
      enabled: true,
      list: () => [{ attachmentId: 'photo-1', status: 'uploaded_staged', size: 1024 }, { attachmentId: 'photo-2', status: 'retryable_error', size: 2048 }],
      add: addAttachment, retry: vi.fn(), remove: vi.fn(), startUpload: vi.fn(),
    } } })
    expect(wrapper.text()).toContain('照片与附件')
    expect(wrapper.text()).toContain('已暂存 1 / 2 个文件')
    expect(wrapper.text()).toContain('整个文件重试')
    expect(wrapper.findAll('button').map(button => button.text())).not.toContain('正式提交')
    expect(wrapper.findAll('[data-primary-action="true"]')).toHaveLength(1)
  })

  test('sensitive photo gate is denied by default rather than a client flag', () => {
    const wrapper = mount(FieldTaskWorkbench, { props: { draft, online: false, editable: true, authorize: vi.fn(), saveField: vi.fn() } })
    expect(wrapper.text()).toContain('敏感照片本机保存尚未通过设备门禁')
    expect(wrapper.get('[data-testid="attachment-input-0"]').attributes('disabled')).toBeDefined()
  })

  test('explicit submission milestone creates only a pending-confirmation submission and keeps save as the sole primary action', async () => {
    const prepare = vi.fn(async () => undefined)
    const wrapper = mount(FieldTaskWorkbench, { props: { draft, online: true, editable: true, authorize: vi.fn(async()=>true), saveField: vi.fn(), submissionController: { status: 'queued', prepare } } })
    expect(wrapper.text()).toContain('已保存到本机')
    expect(wrapper.text()).toContain('尚未创建服务端提交')
    await wrapper.get('[data-testid="prepare-submission"]').trigger('click')
    expect(prepare).toHaveBeenCalledOnce()
    expect(wrapper.findAll('[data-primary-action="true"]')).toHaveLength(1)
    expect(wrapper.findAll('button').map(button=>button.text())).not.toContain('正式提交')
  })

  test('submission failure stays visible and does not masquerade as completion',async()=>{
    const wrapper=mount(FieldTaskWorkbench,{props:{draft,online:true,editable:true,authorize:vi.fn(async()=>true),saveField:vi.fn(),submissionController:{status:'queued',prepare:vi.fn(async()=>{throw new Error('ATTACHMENTS_NOT_READY')})}}})
    await wrapper.get('[data-testid="prepare-submission"]').trigger('click')
    await vi.waitFor(()=>expect(wrapper.get('[data-testid="submission-error"]').text()).toContain('未完成'))
    expect(wrapper.text()).toContain('尚未创建服务端提交')
  })
  test('frozen summary confirmation requires an explicit password and remains a secondary action',async()=>{const confirm=vi.fn(async()=>undefined),wrapper=mount(FieldTaskWorkbench,{props:{draft,online:true,editable:true,authorize:vi.fn(async()=>true),saveField:vi.fn(),confirmationController:{snapshot:{summaryHash:'a'.repeat(64),taskVersion:'v1',ruleVersion:'r1',draftRevision:3,confirmedBy:['user-a']},confirm}}});expect(wrapper.text()).toContain('已确认 1 / 2 人');expect(wrapper.text()).toContain('a'.repeat(64));expect(wrapper.get('[data-testid="confirm-frozen-snapshot"]').attributes('disabled')).toBeDefined();await wrapper.get('[data-testid="confirmation-password"]').setValue('secret');await wrapper.get('[data-testid="confirm-frozen-snapshot"]').trigger('click');expect(confirm).toHaveBeenCalledWith('secret');expect(wrapper.findAll('[data-primary-action="true"]')).toHaveLength(1)})
  test('readiness and departure checks distinguish milestones and location remains user-triggered',async()=>{const getCurrentPosition=vi.fn((done:any)=>done({coords:{latitude:31,longitude:121,accuracy:180},timestamp:1}));Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition}});const wrapper=mount(FieldTaskWorkbench,{props:{draft,online:false,editable:true,authorize:vi.fn(async()=>true),saveField:vi.fn(),submissionController:{status:'pending',prepare:vi.fn()}}});expect(wrapper.text()).toContain('出发前离线准备');expect(wrapper.text()).toContain('本机采集完成：未完成');expect(wrapper.text()).toContain('双人确认完成：未完成');expect(wrapper.text()).toContain('正式提交完成：未完成');expect(getCurrentPosition).not.toHaveBeenCalled();await wrapper.get('[data-testid="capture-location"]').trigger('click');await vi.waitFor(()=>expect(wrapper.text()).toContain('low_accuracy'));expect(wrapper.text()).toContain('定位失败不会阻断“保存本机”')})
})

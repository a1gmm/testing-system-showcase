import type { LocalSubmissionStatus } from './submissionOutbox'

export type FieldSubmissionUiStatus = 'idle' | LocalSubmissionStatus

const frozenStatuses = new Set<FieldSubmissionUiStatus>([
  'queued', 'submitting', 'unknown_commit', 'pending', 'finalizing', 'complete',
])

export function submissionLocksEditing(status: FieldSubmissionUiStatus, hasConfirmation = false) {
  return hasConfirmation || frozenStatuses.has(status)
}

export function submissionStatusText(status: FieldSubmissionUiStatus) {
  return ({
    idle: '尚未创建服务端提交',
    queued: '当前修订已冻结在本机，等待上传',
    submitting: '当前修订已冻结，正在创建服务端提交',
    unknown_commit: '当前修订已冻结，正在确认服务器结果，请勿重复操作',
    pending: '当前修订已上传，等待双人确认',
    finalizing: '当前修订已确认，服务器正在完成正式提交',
    complete: '已正式提交并取得永久服务端回执',
    invalid: '提交内容无效；旧提交已关闭，可修改后生成新修订',
    rejected: '服务器已拒绝旧提交；可修改后生成新修订',
  } satisfies Record<FieldSubmissionUiStatus, string>)[status]
}

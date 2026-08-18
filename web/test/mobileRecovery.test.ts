import{expect,test}from'vitest'
import{recoveryActionFor}from'../src/offline/mobileRecovery'

test('stable server error codes select recovery without parsing localized messages',()=>{
  expect(recoveryActionFor({response:{data:{error_code:'RULE_VERSION_RETIRED',message:'任意中文'}}})).toBe('recheck_rules')
  expect(recoveryActionFor({response:{data:{error_code:'TASK_VERSION_CONFLICT',message:'changed'}}})).toBe('rebuild_draft')
  expect(recoveryActionFor({response:{data:{error_code:'RULE_VALIDATION_FAILED'}}})).toBe('correct_fields')
})

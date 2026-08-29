import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createSample, generateReport, getReport, updateOrgProfile, upsertCustomer } from '../src/handlers.ts'
import { approveLaboratoryRecord } from './support/approved-laboratory-record.ts'

test('generated report freezes organization, customer, instrument, layout and content in ReportDocumentV1', () => {
  const db=openDb(':memory:')
  updateOrgProfile(db,{name:'生成时实验室',address:'旧实验室地址',phone:'111'},{name:'管理员',username:'admin'})
  upsertCustomer(db,{name:'不可变客户',contact:'旧联系人',phone:'222',address:'旧客户地址'})
  db.prepare(`INSERT INTO instruments(id,name,model,status,cert_until,cert_no,note) VALUES ('TC-FROZEN','旧仪器','MODEL-OLD','normal','2099-01-01','CERT-OLD','')`).run()
  const sample=createSample(db,{matrix:'废水',items:['COD'],client:'不可变客户'})
  approveLaboratoryRecord(db,{sampleId:sample.id,code:'HJ-TC-103',analyte:'COD',method:'重铬酸盐法',instrumentId:'TC-FROZEN',data:{rows:[],meta:{},resultSummary:{analyte:'COD',value:12,unit:'mg/L'}}})

  const generated=generateReport(db,sample.id,2026)
  assert.equal(generated.data.document.documentVersion,1)
  assert.equal(generated.data.document.layout,'default')
  assert.equal(generated.data.document.org.name,'生成时实验室')
  assert.equal(generated.data.document.customer.address,'旧客户地址')
  assert.equal(generated.data.document.instruments[0].model,'MODEL-OLD')
  assert.equal(generated.data.document.content.results[0].value,12)

  db.prepare(`UPDATE org_profile SET name='后来实验室',address='新地址' WHERE id=1`).run()
  db.prepare(`UPDATE customers SET contact='新联系人',phone='333',address='新客户地址' WHERE name='不可变客户'`).run()
  db.prepare(`UPDATE instruments SET name='新仪器',model='MODEL-NEW' WHERE id='TC-FROZEN'`).run()
  const reopened=getReport(db,generated.id)!
  assert.equal(reopened.data.document.org.name,'生成时实验室')
  assert.equal(reopened.data.document.customer.contact,'旧联系人')
  assert.equal(reopened.data.document.customer.address,'旧客户地址')
  assert.equal(reopened.data.document.instruments[0].model,'MODEL-OLD')
})

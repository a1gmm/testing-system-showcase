import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'

afterEach(()=>{vi.doUnmock('../src/api');vi.doUnmock('vue-router');vi.resetModules()})

function report(document:any){return{id:'BG2026-0001',sample_id:null,round_id:null,contract_id:'WT-1',client:'实时客户',title:'实时标题',conclusion:'实时结论',data:{document},status:'issued',checker:'复核',checked_at:'2026-01-01',issuer:'签发',issued_at:'2026-01-02',created_at:'2026-01-01'} as any}
function v1(){return{documentVersion:1,layout:'default',report:{id:'BG2026-0001',client:'快照客户',title:'快照标题',conclusion:'快照结论',createdAt:'2026-01-01'},org:{name:'快照实验室',name_en:'Frozen Lab',address:'实验室旧址',postcode:'1',phone:'2',fax:'3',cma_no:'4'},customer:{name:'快照客户',contact:'旧联系人',phone:'旧电话',address:'旧客户地址'},instruments:[{id:'TC-1',name:'旧仪器',model:'M1',cert_until:'2099-01-01',cert_no:'C1'}],technicalRules:[['冻结规则','冻结内容']],display:{gasBlocks:[]},content:{author:'编制',results:[{sampleId:'S1',matrix:'废水',pointName:'排口',analyte:'COD',method:'方法',value:'12',unit:'mg/L',instrumentId:'TC-1'}]}}}

describe('versioned report printing',()=>{
  test('V1 renders only the frozen document and never fetches mutable master data',async()=>{
    const getOrgProfile=vi.fn(),listInstruments=vi.fn(),getContract=vi.fn()
    vi.doMock('../src/api',()=>({api:{getReport:vi.fn(async()=>report(v1())),getOrgProfile,listInstruments,getContract}}))
    vi.doMock('vue-router',()=>({useRoute:()=>({params:{id:'BG2026-0001'}})}))
    const ReportPrint=(await import('../src/pages/ReportPrint.vue')).default,wrapper=mount(ReportPrint)
    await vi.waitFor(()=>expect(wrapper.text()).toContain('快照实验室'))
    expect(wrapper.text()).toContain('快照客户');expect(wrapper.text()).toContain('旧客户地址');expect(wrapper.text()).toContain('旧联系人');expect(wrapper.text()).toContain('M1旧仪器')
    expect(wrapper.text()).not.toContain('实时客户');expect(getOrgProfile).not.toHaveBeenCalled();expect(listInstruments).not.toHaveBeenCalled();expect(getContract).not.toHaveBeenCalled()
  })

  test('unknown document version fails closed before any print content or live fallback loads',async()=>{
    const getOrgProfile=vi.fn(),listInstruments=vi.fn(),getContract=vi.fn()
    vi.doMock('../src/api',()=>({api:{getReport:vi.fn(async()=>report({documentVersion:2})),getOrgProfile,listInstruments,getContract}}))
    vi.doMock('vue-router',()=>({useRoute:()=>({params:{id:'BG2026-0001'}})}))
    const ReportPrint=(await import('../src/pages/ReportPrint.vue')).default,wrapper=mount(ReportPrint)
    await vi.waitFor(()=>expect(wrapper.text()).toContain('暂不支持'))
    expect(wrapper.find('.page').exists()).toBe(false);expect(getOrgProfile).not.toHaveBeenCalled();expect(listInstruments).not.toHaveBeenCalled();expect(getContract).not.toHaveBeenCalled()
  })
})

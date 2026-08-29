import type { DB } from './db.ts'
import { roundGB } from './gbround.ts'

export const REPORT_DOCUMENT_VERSION = 1 as const

export const REPORT_TECHNICAL_RULES: readonly (readonly [string,string])[] = [
  ['CODcr','≥100mg/L ±15%；60~100mg/L ±20%；30~60mg/L ±30%；<30mg/L 用20-25mg/L标样替代 ±5mg/L'],
  ['氨氮','≥2mg/L ±15%；<2mg/L ±0.3mg/L（1.5mg/L标样替代）'],
  ['总磷','≥0.4mg/L ±15%；<0.4mg/L ±0.04mg/L'],
  ['总氮','≥2mg/L ±15%；<2mg/L ±0.3mg/L'],
  ['pH','绝对误差不超过±0.5'],
  ['超声波明渠流量计','10分钟累计流量比对误差±10%；液位比对误差12mm（6组）'],
  ['质控样（0.5倍量程标样）','相对误差≤±10%'],
  ['比对数量规则','比对试验总数不少于3对：3对至少2对满足、4对至少3对满足、5对以上至少4对满足'],
]

export type ReportLayoutV1='default'|'transposed'|'gas_organized'|'comparison'
export type ReportDocumentV1={
  documentVersion:typeof REPORT_DOCUMENT_VERSION
  layout:ReportLayoutV1
  report:{id:string;client:string;title:string;conclusion:string;createdAt:string}
  org:{name:string;name_en:string|null;address:string|null;postcode:string|null;phone:string|null;fax:string|null;cma_no:string|null}
  customer:{name:string;contact:string|null;phone:string|null;address:string|null}
  instruments:{id:string;name:string;model:string;cert_until:string|null;cert_no:string|null}[]
  technicalRules:(readonly [string,string])[]
  display:{gasBlocks:any[]}
  content:Record<string,unknown>
}

type ReportInput={id:string;contract_id:string|null;client:string;title:string;conclusion:string;created_at:string;data:any}
type OrgInput={name:string;name_en:string|null;address:string|null;postcode:string|null;phone:string|null;fax:string|null;cma_no:string|null}

function layoutFor(content:any):ReportLayoutV1{
  if(Array.isArray(content?.compareBlocks)&&content.compareBlocks.length)return'comparison'
  const results=(Array.isArray(content?.results)?content.results:[]).filter((row:any)=>!row.qcType)
  if(results.length&&results.every((row:any)=>row.matrix==='有组织废气'||row.matrix==='废气')&&!results.some((row:any)=>/风向/.test(row.pointName||'')))return'gas_organized'
  if(results.length&&results.every((row:any)=>['地下水','土壤'].includes(row.matrix)))return'transposed'
  return'default'
}

export function buildReportDocumentV1(db:DB,report:ReportInput,org:OrgInput):ReportDocumentV1{
  const content=structuredClone(report.data??{}) as Record<string,unknown>
  delete (content as any).document
  delete (content as any)._issuance
  const customer=db.prepare(`SELECT name,contact,phone,address FROM customers WHERE name=?`).get(report.client) as any
  const contract=report.contract_id?db.prepare(`SELECT contact,phone FROM contracts WHERE id=?`).get(report.contract_id) as any:null
  const ids=[...new Set((Array.isArray((content as any).results)?(content as any).results:[]).map((row:any)=>String(row.instrumentId||'')).filter(Boolean))] as string[]
  const instruments=ids.map(id=>db.prepare(`SELECT id,name,model,cert_until,cert_no FROM instruments WHERE id=?`).get(id) as any).filter(Boolean)
  const layout=layoutFor(content)
  const avg=(values:any[])=>{const numbers=values.map(Number).filter(Number.isFinite);return numbers.length?roundGB(numbers.reduce((sum,value)=>sum+value,0)/numbers.length,3):''}
  const gasBlocks=layout==='gas_organized'?(()=>{const byPoint=new Map<string,Map<string,any[]>>();for(const row of ((content as any).results??[]).filter((item:any)=>!item.qcType)){const point=row.pointName||'—';if(!byPoint.has(point))byPoint.set(point,new Map());const analytes=byPoint.get(point)!;if(!analytes.has(row.analyte))analytes.set(row.analyte,[]);analytes.get(row.analyte)!.push(row)}return[...byPoint.entries()].map(([point,groups])=>{const analytes=[...groups.entries()].map(([analyte,rows])=>({analyte,unit:rows[0]?.unit||'',sub:rows.some(row=>row.sub),samples:rows.map(row=>row.sampleId),values:rows.map(row=>row.value),avg:avg(rows.map(row=>row.value)),correcteds:rows.map(row=>row.corrected),avgCorrected:rows.some(row=>row.corrected!==''&&row.corrected!=null)?avg(rows.map(row=>row.corrected)):'',rates:rows.map(row=>row.rate),avgRate:rows.some(row=>row.rate!==''&&row.rate!=null)?avg(rows.map(row=>row.rate)):'',limit:rows[0]?.limit||'/'}));return{point,analytes,cols:Math.max(...analytes.map(item=>item.samples.length)),stack:((content as any).stacks??[]).find((stack:any)=>stack.name===point)||null}})})():[]
  return{
    documentVersion:REPORT_DOCUMENT_VERSION,
    layout,
    report:{id:report.id,client:report.client,title:report.title,conclusion:report.conclusion,createdAt:report.created_at},
    org:{name:org.name,name_en:org.name_en,address:org.address,postcode:org.postcode,phone:org.phone,fax:org.fax,cma_no:org.cma_no},
    customer:{name:report.client,contact:contract?.contact??customer?.contact??null,phone:contract?.phone??customer?.phone??null,address:customer?.address??null},
    instruments:instruments.map(item=>({id:item.id,name:item.name,model:item.model??'',cert_until:item.cert_until??null,cert_no:item.cert_no??null})),
    technicalRules:REPORT_TECHNICAL_RULES.map(row=>[...row] as const),
    display:{gasBlocks},
    content,
  }
}

export function isReportDocumentV1(value:unknown):value is ReportDocumentV1{
  return!!value&&typeof value==='object'&&(value as any).documentVersion===REPORT_DOCUMENT_VERSION&&typeof(value as any).layout==='string'&&!!(value as any).report&&!!(value as any).org&&!!(value as any).customer&&Array.isArray((value as any).instruments)&&!!(value as any).content
}

export type ReportDocumentV1={
  documentVersion:1
  layout:'default'|'transposed'|'gas_organized'|'comparison'
  report:{id:string;client:string;title:string;conclusion:string;createdAt:string}
  org:{name:string;name_en:string|null;address:string|null;postcode:string|null;phone:string|null;fax:string|null;cma_no:string|null}
  customer:{name:string;contact:string|null;phone:string|null;address:string|null}
  instruments:{id:string;name:string;model:string;cert_until:string|null;cert_no:string|null}[]
  technicalRules:[string,string][]
  display:{gasBlocks:any[]}
  content:Record<string,any>
}

export function parseReportDocument(value:unknown):ReportDocumentV1|null{
  if(!value||typeof value!=='object'||(value as any).documentVersion!==1)return null
  const document=value as any
  if(!['default','transposed','gas_organized','comparison'].includes(document.layout)||!document.report||!document.org||!document.customer||!Array.isArray(document.instruments)||!Array.isArray(document.technicalRules)||!document.content||!document.display)return null
  return document as ReportDocumentV1
}

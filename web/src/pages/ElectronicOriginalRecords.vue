<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api, type ArchiveItem, type ArchivePackage, type Report } from '../api'
import ArchiveFormalRecord from '../components/ArchiveFormalRecord.vue'
import ArchiveValue from '../components/ArchiveValue.vue'
import StructuredSheet from '../components/StructuredSheet.vue'
import {
  archiveAttachmentsForItem,
  attachmentPresentation,
  electronicRecordBookSections,
  resolveFrozenSheet,
  stageAnchor,
  type AttachmentPresentation,
  type FrozenSheet,
} from '../archive/electronicRecordBook'

const route = useRoute()
const loading = ref(true)
const error = ref('')
const report = ref<Report | null>(null)
const archive = ref<ArchivePackage | null>(null)
const isReportRoute = computed(() => route.name === 'report-original-records')
const sections = computed(() => electronicRecordBookSections(archive.value?.items || []))
const originalRecordCount = computed(() => sections.value.reduce((count, section) => count + section.items.length, 0))
const presentation = computed(() => new Map((archive.value?.items || []).map(item => [item.id, {
  sheet: resolveFrozenSheet(item),
  attachment: attachmentPresentation(item),
}])))

function sheetFor(item: ArchiveItem): FrozenSheet | null {
  return presentation.value.get(item.id)?.sheet || null
}
function attachmentFor(item: ArchiveItem): AttachmentPresentation | null {
  return presentation.value.get(item.id)?.attachment || null
}
function attachmentsFor(item: ArchiveItem): ArchiveItem[] {
  return archive.value ? archiveAttachmentsForItem(item, archive.value.items) : []
}
function fileUrl(attachment: AttachmentPresentation) {
  return api.attachmentUrl(attachment.attachmentId)
}
function fmt(value?: string | null) {
  return value ? value.slice(0, 19).replace('T', ' ') : '—'
}
function printBook() { window.print() }

async function load() {
  loading.value = true
  error.value = ''
  try {
    const id = String(route.params.id || '').trim()
    if (!id) throw new Error('缺少报告或归档版本编号')
    if (isReportRoute.value) {
      const exactReport = await api.getReport(id)
      report.value = exactReport
      if (!exactReport.archive_package_id) {
        throw new Error('该历史报告未绑定第 1–8 步冻结归档，无法生成完整电子原始记录')
      }
      archive.value = await api.getArchivePackage(exactReport.archive_package_id)
    } else {
      archive.value = await api.getArchivePackage(id)
    }
    if (!archive.value || !['confirmed', 'invalidated'].includes(archive.value.status)) {
      throw new Error('只有已冻结的归档版本可以生成完整电子原始记录')
    }
  } catch (reason: any) {
    archive.value = null
    error.value = reason?.response?.data?.error || reason?.message || '完整电子原始记录读取失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="reader-shell">
    <header class="reader-toolbar no-print">
      <a class="back-link" :href="isReportRoute ? '/reports' : '/archive-packages'">← 返回{{ isReportRoute ? '报告' : '归档队列' }}</a>
      <div>
        <b>完整电子原始记录</b>
        <span v-if="archive" class="mono">{{ archive.contract_id }} · 版本 {{ archive.version }}</span>
      </div>
      <button v-if="archive" type="button" data-print-record-book @click="printBook">打印 / 导出 PDF</button>
    </header>

    <div v-if="loading" class="reader-state">正在汇集报告对应的冻结原始记录…</div>
    <p v-else-if="error" class="reader-state error" role="alert">{{ error }}</p>

    <main v-else-if="archive" class="record-book" :data-electronic-record-book="archive.id">
      <section class="book-cover">
        <div class="cover-kicker">示例检测 · 电子归档</div>
        <h1>完整电子原始记录册</h1>
        <p>由系统第 1–8 环节的冻结电子记录自动汇编，无需另行上传整册扫描件。</p>
        <dl>
          <div v-if="report"><dt>报告编号</dt><dd class="mono">{{ report.id }}</dd></div>
          <div v-if="report"><dt>报告名称</dt><dd>{{ report.title }}</dd></div>
          <div><dt>委托单位</dt><dd>{{ report?.client || archive.contract_id }}</dd></div>
          <div><dt>归档范围</dt><dd>{{ archive.report_batch_id ? `报告批次 ${archive.report_batch_id}` : '项目全部期次' }}</dd></div>
          <div><dt>冻结版本</dt><dd class="mono">归档版本 {{ archive.version }}</dd></div>
          <div><dt>确认时间</dt><dd class="mono">{{ fmt(archive.confirmed_at) }}</dd></div>
          <div><dt>完整性</dt><dd>共 {{ originalRecordCount }} 项正式单据</dd></div>
          <div><dt>清单哈希</dt><dd class="mono hash">{{ archive.manifest_sha256 }}</dd></div>
        </dl>
        <div v-if="archive.status === 'invalidated'" class="history-warning" role="status">
          这是报告当时引用的历史冻结版本，后续上游记录已发生撤回或失效；历史证据仍保持只读可查。
        </div>
      </section>

      <div class="reader-layout">
        <nav class="book-toc no-print" aria-label="电子原始记录册目录">
          <div class="toc-head"><b>记录册目录</b><span>{{ originalRecordCount }} 项</span></div>
          <a v-for="section in sections" :key="section.key" :href="`#${stageAnchor(section.key)}`"
            :data-record-book-stage-link="section.key" :class="{ empty: !section.items.length }">
            <span class="stage-number">{{ section.number }}</span>
            <span><b>{{ section.label }}</b><small>{{ section.hint }}</small></span>
            <em>{{ section.items.length }}</em>
          </a>
        </nav>

        <div class="book-body">
          <section v-for="section in sections" :id="stageAnchor(section.key)" :key="section.key"
            class="book-stage" :data-record-book-stage="section.key">
            <header class="stage-head">
              <span class="stage-number">{{ section.number }}</span>
              <div><h2>{{ section.label }}</h2><p>{{ section.hint }} · {{ section.items.length }} 项</p></div>
            </header>
            <p v-if="!section.items.length" class="stage-empty">该冻结版本在此阶段没有单独归档条目。</p>

            <article v-for="item in section.items" :key="item.id" class="book-record" :data-record-book-item="item.id">
              <template v-if="sheetFor(item)">
                <header class="record-head">
                  <span class="record-order mono">{{ item.item_order }}</span>
                  <div><h3>{{ item.label }}</h3><p>电子原始表 · <template v-if="item.revision !== null">定稿版本 {{ item.revision }}</template><template v-else>归档快照</template></p></div>
                </header>
                <div class="frozen-sheet" :data-frozen-sheet-host="item.id" :data-template-file="sheetFor(item)?.file || ''">
                  <StructuredSheet
                    v-if="sheetFor(item)?.file"
                    :sample-id="sheetFor(item)?.sampleId"
                    :round-id="sheetFor(item)?.roundId"
                    :analyte="sheetFor(item)!.analyte"
                    :method="sheetFor(item)!.method"
                    :matrix="sheetFor(item)!.matrix"
                    :code="sheetFor(item)!.code"
                    :file="sheetFor(item)?.file"
                    :sheet-type="sheetFor(item)!.sheetType"
                    :template-name="sheetFor(item)!.name"
                    :tpl-meta="sheetFor(item)?.meta"
                    :frozen-data="sheetFor(item)!.data"
                    :frozen-instrument-id="sheetFor(item)?.instrumentId"
                    readonly />
                  <div v-else class="template-missing" role="status">
                    <b>未匹配到电子表格版式</b>
                    <p>这是历史冻结记录，原始值仍完整保留；为避免套用错误表格，系统按冻结字段只读展示。</p>
                    <ArchiveValue :value="sheetFor(item)!.data" field-key="frozen-data" />
                  </div>
                </div>
                <section v-if="Array.isArray(item.metadata?.decisions) && item.metadata.decisions.length" class="approval-trail">
                  <h4>复核与审核</h4>
                  <ArchiveValue :value="item.metadata.decisions" field-key="decisions" />
                </section>
                <details class="record-audit"><summary>版本与完整性信息</summary><p class="mono hash">{{ item.content_hash }}</p></details>
              </template>

              <ArchiveFormalRecord v-else :item="item" />

              <section v-if="attachmentsFor(item).length" class="record-attachments" :data-record-attachments-for="item.id">
                <h4>照片与附件</h4>
                <template v-for="attachment in attachmentsFor(item)" :key="attachment.id">
                  <div v-if="attachmentFor(attachment)" class="attachment-entry" :data-record-book-attachment="attachmentFor(attachment)!.attachmentId">
                    <header class="record-head">
                      <span class="record-order mono">附</span>
                      <div><h3>{{ attachmentFor(attachment)!.name }}</h3><p>所属单据附件 · {{ attachmentFor(attachment)!.mime || '原文件' }}</p></div>
                      <a class="file-action" :href="fileUrl(attachmentFor(attachment)!)" target="_blank" rel="noopener">打开 / 下载原文件</a>
                    </header>
                    <img v-if="attachmentFor(attachment)!.kind === 'image'" class="attachment-image"
                      :data-record-book-image="attachmentFor(attachment)!.attachmentId" :src="fileUrl(attachmentFor(attachment)!)" :alt="attachmentFor(attachment)!.name" />
                    <iframe v-else-if="attachmentFor(attachment)!.kind === 'pdf'" class="attachment-pdf"
                      :data-record-book-pdf="attachmentFor(attachment)!.attachmentId" :src="fileUrl(attachmentFor(attachment)!)"
                      :title="`${attachmentFor(attachment)!.name} 在线查看`" loading="lazy"></iframe>
                    <p v-else class="file-placeholder">该格式使用原文件查看；文件名和内容哈希已随归档版本冻结。</p>
                    <details class="record-audit"><summary>附件完整性信息</summary><p class="mono hash">{{ attachment.content_hash }}</p></details>
                  </div>
                </template>
              </section>
            </article>

            <section v-if="section.attachments.length" class="stage-attachments" :data-record-book-stage-attachments="section.key">
              <header><h3>本阶段照片与附件</h3><p>历史附件缺少可确认的所属单据，保留在对应业务阶段，不计入原始记录数量。</p></header>
              <template v-for="attachment in section.attachments" :key="attachment.id">
                <div v-if="attachmentFor(attachment)" class="attachment-entry" :data-record-book-attachment="attachmentFor(attachment)!.attachmentId">
                  <header class="record-head">
                    <span class="record-order mono">附</span>
                    <div><h3>{{ attachmentFor(attachment)!.name }}</h3><p>冻结附件 · {{ attachmentFor(attachment)!.mime || '原文件' }}</p></div>
                    <a class="file-action" :href="fileUrl(attachmentFor(attachment)!)" target="_blank" rel="noopener">打开 / 下载原文件</a>
                  </header>
                  <img v-if="attachmentFor(attachment)!.kind === 'image'" class="attachment-image"
                    :data-record-book-image="attachmentFor(attachment)!.attachmentId" :src="fileUrl(attachmentFor(attachment)!)" :alt="attachmentFor(attachment)!.name" />
                  <iframe v-else-if="attachmentFor(attachment)!.kind === 'pdf'" class="attachment-pdf"
                    :data-record-book-pdf="attachmentFor(attachment)!.attachmentId" :src="fileUrl(attachmentFor(attachment)!)"
                    :title="`${attachmentFor(attachment)!.name} 在线查看`" loading="lazy"></iframe>
                  <p v-else class="file-placeholder">该格式使用原文件查看；文件名和内容哈希已随归档版本冻结。</p>
                  <details class="record-audit"><summary>附件完整性信息</summary><p class="mono hash">{{ attachment.content_hash }}</p></details>
                </div>
              </template>
            </section>
          </section>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.reader-shell{min-height:100vh;background:var(--canvas,#F3F0EA);color:var(--ink,#1E2329)}
.reader-toolbar{position:sticky;top:0;z-index:20;min-height:60px;display:grid;grid-template-columns:minmax(160px,1fr) auto minmax(160px,1fr);align-items:center;gap:16px;padding:8px 24px;border-bottom:1px solid var(--line,#CBC5BA);background:rgba(255,254,252,.96);backdrop-filter:blur(10px)}
.reader-toolbar>div{display:grid;gap:2px;text-align:center}.reader-toolbar>div span{color:var(--muted,#62676E);font-size:12px}.back-link{color:var(--accent,#4F46E5);font-weight:600;text-decoration:none}.reader-toolbar button{justify-self:end;min-height:44px;padding:0 16px;border:1px solid var(--accent,#4F46E5);border-radius:7px;background:var(--accent,#4F46E5);color:#fff;font:600 14px inherit;cursor:pointer}
.reader-state{max-width:760px;margin:80px auto;padding:24px;border:1px solid var(--line);border-radius:10px;background:var(--surface,#FFFEFC);text-align:center;color:var(--muted)}.reader-state.error{border-color:var(--crit,#B42318);color:var(--crit,#B42318)}
.record-book{padding:32px 24px 64px}.book-cover{box-sizing:border-box;max-width:1040px;min-height:520px;margin:0 auto 32px;padding:56px 64px;border:1px solid var(--line);background:var(--surface,#FFFEFC);box-shadow:0 10px 32px rgba(30,35,41,.08)}
.cover-kicker{color:var(--accent,#4F46E5);font-size:13px;font-weight:700;letter-spacing:.16em}.book-cover h1{margin:72px 0 10px;text-align:center;font-size:34px;letter-spacing:.12em}.book-cover>p{margin:0 auto 56px;max-width:680px;text-align:center;color:var(--muted);line-height:1.7}.book-cover dl{display:grid;grid-template-columns:1fr 1fr;margin:0;border-top:1px solid var(--ink)}.book-cover dl>div{display:grid;grid-template-columns:100px minmax(0,1fr);min-height:46px;border-bottom:1px solid var(--line)}.book-cover dl>div:nth-child(odd){border-right:1px solid var(--line)}.book-cover dt,.book-cover dd{display:flex;align-items:center;margin:0;padding:8px 12px}.book-cover dt{background:var(--surface-2,#E9E5DD);color:var(--muted);font-size:13px}.book-cover dd{font-size:14px;overflow-wrap:anywhere}.history-warning{margin-top:20px;padding:12px 14px;border-left:4px solid var(--warn,#B05C00);background:var(--warn-soft,#FFF1DF);color:var(--warn,#B05C00);font-size:13px;line-height:1.6}
.reader-layout{display:grid;grid-template-columns:240px minmax(0,960px);align-items:start;justify-content:center;gap:24px}.book-toc{position:sticky;top:84px;border:1px solid var(--line);background:var(--surface)}.toc-head{display:flex;justify-content:space-between;padding:14px;border-bottom:1px solid var(--line)}.toc-head span{color:var(--muted);font:12px var(--font-mono,monospace)}.book-toc>a{display:grid;grid-template-columns:34px minmax(0,1fr) 24px;gap:8px;align-items:center;min-height:58px;padding:8px 10px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none}.book-toc>a:hover{background:var(--accent-soft,#EEEDFF)}.book-toc>a.empty{opacity:.55}.stage-number{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--accent);border-radius:7px;color:var(--accent);font:600 12px var(--font-mono,monospace)}.book-toc b,.book-toc small{display:block}.book-toc b{font-size:13px}.book-toc small{margin-top:2px;color:var(--muted);font-size:11px;line-height:1.3}.book-toc em{font-style:normal;text-align:right;color:var(--muted);font:12px var(--font-mono,monospace)}
.book-body{min-width:0}.book-stage{scroll-margin-top:82px;margin-bottom:32px}.stage-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border:1px solid var(--line);background:var(--surface-2,#E9E5DD)}.stage-head h2,.stage-head p{margin:0}.stage-head h2{font-size:20px}.stage-head p{margin-top:3px;color:var(--muted);font-size:12px}.stage-empty{margin:0;padding:24px;border:1px solid var(--line);border-top:0;background:var(--surface);color:var(--muted);text-align:center;font-size:13px}.book-record{margin-top:16px;border:1px solid var(--line);background:var(--surface,#FFFEFC);box-shadow:0 4px 14px rgba(30,35,41,.045)}.record-head{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line)}.record-head h3,.record-head p{margin:0}.record-head h3{font-size:16px}.record-head p{margin-top:3px;color:var(--muted);font-size:12px}.record-order{color:var(--accent);font-weight:600}.file-action{min-height:44px;display:inline-flex;align-items:center;padding:0 13px;border:1px solid var(--accent);border-radius:7px;color:var(--accent);font-size:13px;font-weight:600;text-decoration:none}.frozen-sheet{min-width:0}.approval-trail{padding:16px 20px;border-top:1px solid var(--line)}.approval-trail h4{margin:0 0 10px;font-size:14px}.record-audit{padding:12px 18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.record-audit summary{cursor:pointer;width:max-content}.record-audit p{margin:8px 0 0}.attachment-image{display:block;max-width:100%;max-height:900px;margin:20px auto;object-fit:contain}.attachment-pdf{display:block;width:100%;height:820px;border:0;background:var(--surface-2)}.file-placeholder{margin:0;padding:32px;text-align:center;color:var(--muted)}.mono{font-family:var(--font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}.hash{word-break:break-all}
.record-attachments{border-top:1px solid var(--line)}.record-attachments>h4{margin:0;padding:12px 18px;background:var(--surface-2);font-size:14px}.attachment-entry+.attachment-entry{border-top:1px solid var(--line)}.stage-attachments{margin-top:16px;border:1px solid var(--line);background:var(--surface)}.stage-attachments>header{padding:14px 18px;border-bottom:1px solid var(--line);background:var(--surface-2)}.stage-attachments>header h3,.stage-attachments>header p{margin:0}.stage-attachments>header h3{font-size:16px}.stage-attachments>header p{margin-top:4px;color:var(--muted);font-size:12px;line-height:1.5}
.template-missing{margin:18px;padding:16px;border-left:4px solid var(--warn,#B05C00);background:var(--warn-soft,#FFF1DF);color:var(--ink);font-size:13px;line-height:1.6}.template-missing>b{color:var(--warn,#B05C00)}.template-missing>p{margin:4px 0 14px;color:var(--muted)}
@media(max-width:900px){.reader-toolbar{grid-template-columns:1fr auto}.reader-toolbar>div{display:none}.record-book{padding:20px 12px 48px}.book-cover{min-height:0;padding:32px 24px}.book-cover h1{margin-top:42px;font-size:28px}.book-cover dl{grid-template-columns:1fr}.book-cover dl>div:nth-child(odd){border-right:0}.reader-layout{grid-template-columns:1fr}.book-toc{top:60px;z-index:10;display:flex;overflow-x:auto}.toc-head{display:none}.book-toc>a{min-width:176px;border-right:1px solid var(--line);border-bottom:0}.record-head{grid-template-columns:34px minmax(0,1fr)}.file-action{grid-column:1/-1;justify-content:center}.attachment-pdf{height:620px}}
@media(max-width:520px){.reader-toolbar{padding:8px 12px}.reader-toolbar button{padding:0 12px}.book-cover dl>div{grid-template-columns:88px minmax(0,1fr)}.book-cover h1{font-size:24px}.stage-head{padding:12px}.attachment-pdf{height:520px}}
@media print{.no-print{display:none!important}.reader-shell,.record-book{background:#fff}.record-book{padding:0}.book-cover{min-height:270mm;margin:0;border:0;box-shadow:none;break-after:page}.reader-layout{display:block}.book-stage{margin:0;break-before:auto}.stage-head,.stage-empty{display:none}.book-record{margin:0;border:0;box-shadow:none;break-before:page}.record-head{border:1px solid #777;border-bottom:0}.frozen-sheet,.approval-trail,.record-audit{border-left:1px solid #777;border-right:1px solid #777}.record-audit{border-bottom:1px solid #777;break-inside:avoid}.attachment-pdf{height:230mm}}
</style>

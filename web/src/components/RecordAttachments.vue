<script setup lang="ts">
// 记录附件：任意记录下面挂照片/小票，选传不强制。全站通用组件。
// 合规：删除是软删（后端留痕），记录定稿后 frozen=true 只读。
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, type Attachment, type AttachEntityType } from '../api'
import { can } from '../permissions'

const props = defineProps<{
  type: AttachEntityType
  id: string | number | null | undefined
  frozen?: boolean          // 记录已定稿 → 附件锁定，只读
}>()

const list = ref<Attachment[]>([])
const loading = ref(false)
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// 能否增删：走权限矩阵 can()（含质控员），不再手写角色清单——全站口径统一
const canEdit = computed(() => !props.frozen && props.id != null && can('attach_upload'))
const canDel = computed(() => !props.frozen && props.id != null && can('attach_delete'))

function isImg(a: Attachment) {
  return (a.mime || '').startsWith('image/') || /\.(jpe?g|png|gif|webp|heic)$/i.test(a.orig_name)
}
function fileUrl(a: Attachment) { return api.attachmentUrl(a.id) }

async function load() {
  if (props.id == null) { list.value = []; return }
  loading.value = true
  try { list.value = await api.listAttachments(props.type, props.id) }
  catch (e: any) { ElMessage.error('附件加载失败：' + (e?.response?.data?.error || e?.message || e)) }
  finally { loading.value = false }
}

function pick() { fileInput.value?.click() }
async function onPicked(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files || !files.length || props.id == null) return
  uploading.value = true
  try {
    for (const f of Array.from(files)) await api.uploadAttachment(props.type, props.id, f)
    ElMessage.success('附件已上传')
    await load()
  } catch (e: any) {
    ElMessage.error('上传失败：' + (e?.response?.data?.error || e?.message || e))
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function remove(a: Attachment) {
  try {
    await ElMessageBox.confirm(`删除附件「${a.orig_name}」？删除会留痕，文件不会彻底消失。`, '确认删除', { type: 'warning' })
  } catch { return }
  try {
    await api.deleteAttachment(a.id)
    ElMessage.success('已删除')
    await load()
  } catch (e: any) {
    ElMessage.error('删除失败：' + (e?.response?.data?.error || e?.message || e))
  }
}

onMounted(load)
watch(() => [props.type, props.id], load)
</script>

<template>
  <div class="attach">
    <div class="ah">
      <span class="atitle">附件</span>
      <span class="aopt">选填</span>
      <span v-if="frozen" class="afrozen">· 记录已定稿，附件已锁定</span>
      <span class="aspacer"></span>
      <el-button v-if="canEdit" size="small" :loading="uploading" @click="pick">＋ 上传/拍照</el-button>
      <input ref="fileInput" type="file" accept="image/*,.pdf" multiple capture="environment"
        style="display:none" @change="onPicked" />
    </div>

    <div v-loading="loading" class="agrid">
      <div v-if="!list.length" class="aempty">还没有附件{{ canEdit ? '，点右上「上传/拍照」，支持图片或 PDF' : '' }}</div>
      <div v-for="a in list" :key="a.id" class="acard">
        <a :href="fileUrl(a)" target="_blank" class="athumb" :title="a.orig_name">
          <img v-if="isImg(a)" :src="fileUrl(a)" :alt="a.orig_name" loading="lazy" />
          <span v-else class="afile">PDF</span>
        </a>
        <div class="ameta">
          <span class="aname" :title="a.orig_name">{{ a.orig_name }}</span>
          <span class="awho">{{ a.who }}</span>
        </div>
        <el-button v-if="canDel" class="adel" link size="small" type="danger" @click="remove(a)">删除</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.attach { margin-top: 10px; }
.ah { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.atitle { font-weight: 600; font-size: 14px; }
.aopt { font-size: 12px; color: #909399; background: #f4f4f5; padding: 1px 6px; border-radius: 4px; }
.afrozen { font-size: 12px; color: #e6a23c; }
.aspacer { flex: 1; }
.agrid { display: flex; flex-wrap: wrap; gap: 10px; min-height: 24px; }
.aempty { font-size: 13px; color: #909399; }
.acard { width: 96px; position: relative; }
.athumb {
  display: flex; align-items: center; justify-content: center;
  width: 96px; height: 96px; border: 1px solid #dcdfe6; border-radius: 6px;
  overflow: hidden; background: #fafafa; cursor: pointer;
}
.athumb img { width: 100%; height: 100%; object-fit: cover; }
.afile { font-size: 13px; font-weight: 600; color: #c0392b; }
.ameta { display: flex; flex-direction: column; margin-top: 3px; }
.aname { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.awho { font-size: 11px; color: #909399; }
.adel { position: absolute; top: 2px; right: 2px; background: rgba(255,255,255,.85); padding: 0 4px; border-radius: 4px; }
</style>

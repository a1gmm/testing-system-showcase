<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  api, ROLE_LABEL, hasRole, currentUser, PROFESSIONAL_SCOPES, PROFESSIONAL_SCOPE_LABEL,
  QUALIFICATION_CODES, QUALIFICATION_LABEL, type QualificationCode, type QualificationInput,
  type User, type UserQualification,
} from '../api'

const users = ref<User[]>([])
const qualificationByUser = ref<Record<string, UserQualification[]>>({})
const qualificationErrors = ref<Record<string, string>>({})
const qualificationLoading = ref<Record<string, boolean>>({})
const loading = ref(false)
const ROLE_KEYS = Object.keys(ROLE_LABEL)
const QUALIFICATION_GROUPS = PROFESSIONAL_SCOPES.map(scope => ({
  scope,
  label: PROFESSIONAL_SCOPE_LABEL[scope],
  codes: [`${scope}_review`, `${scope}_approve`] as QualificationCode[],
}))

function serverError(error: any) {
  return String(error?.response?.data?.error || error?.message || error || '保存失败，请稍后再试')
}

async function refresh() {
  loading.value = true
  try {
    const listed = await api.listUsers()
    // The personnel roster is useful on its own. Publish it before the independent
    // qualification requests so one unavailable row cannot erase the whole table.
    users.value = listed
    qualificationLoading.value = Object.fromEntries(listed.map(user => [user.username, true]))
    const results = await Promise.allSettled(listed.map(user => api.listUserQualifications(user.username)))
    const nextQualifications: Record<string, UserQualification[]> = {}
    const nextErrors: Record<string, string> = {}
    listed.forEach((user, index) => {
      const result = results[index]
      if (result.status === 'fulfilled') nextQualifications[user.username] = result.value
      else {
        if (qualificationByUser.value[user.username]) nextQualifications[user.username] = qualificationByUser.value[user.username]
        nextErrors[user.username] = `专业审核资格加载失败：${serverError(result.reason)}`
      }
    })
    qualificationByUser.value = nextQualifications
    qualificationErrors.value = nextErrors
    qualificationLoading.value = Object.fromEntries(listed.map(user => [user.username, false]))
  }
  catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
}

async function retryQualifications(user: User) {
  if (qualificationLoading.value[user.username]) return
  qualificationLoading.value = { ...qualificationLoading.value, [user.username]: true }
  try {
    const rows = await api.listUserQualifications(user.username)
    qualificationByUser.value = { ...qualificationByUser.value, [user.username]: rows }
    const nextErrors = { ...qualificationErrors.value }
    delete nextErrors[user.username]
    qualificationErrors.value = nextErrors
  } catch (error: any) {
    qualificationErrors.value = {
      ...qualificationErrors.value,
      [user.username]: `专业审核资格加载失败：${serverError(error)}`,
    }
  } finally {
    qualificationLoading.value = { ...qualificationLoading.value, [user.username]: false }
  }
}

// 新增人员（仅管理员）
const showAdd = ref(false)
const form = ref({ username: '', name: '', password: '', roles: [] as string[] })
function toggleRole(r: string) {
  const i = form.value.roles.indexOf(r)
  i >= 0 ? form.value.roles.splice(i, 1) : form.value.roles.push(r)
}
const addBusy = ref(false)   // 防连点：连点两下会报「用户名已存在」吓人
async function addUser() {
  if (addBusy.value) return
  if (!form.value.username || !form.value.name) return ElMessage.warning('用户名和姓名必填')
  // 初始密码和重置密码同一口径：至少 6 位
  if ((form.value.password || '').length < 6) return ElMessage.warning('初始密码至少 6 位')
  if (!form.value.roles.length) return ElMessage.warning('至少选一个岗位角色')
  addBusy.value = true
  try {
    await api.createUser(form.value)
    ElMessage.success('已添加 ' + form.value.name)
    form.value = { username: '', name: '', password: '', roles: [] }
    showAdd.value = false
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { addBusy.value = false }
}

// 编辑人员（仅管理员）：改姓名 + 岗位
const editing = ref<User | null>(null)
type QualificationDraft = {
  code: QualificationCode; selected: boolean; validFrom: string; validUntil: string; status: 'active' | 'inactive'
}
const edit = ref({ name: '', roles: [] as string[], qualifications: [] as QualificationDraft[] })
const editError = ref('')
const editBusy = ref(false)
function openEdit(u: User) {
  if (editBusy.value || qualificationErrors.value[u.username] || qualificationLoading.value[u.username]) return
  const existing = new Map((qualificationByUser.value[u.username] || []).map(item => [item.code, item]))
  editing.value = u
  edit.value = {
    name: u.name,
    roles: [...u.roles],
    qualifications: QUALIFICATION_CODES.map(code => {
      const item = existing.get(code)
      return {
        code, selected: !!item, validFrom: item?.valid_from || '', validUntil: item?.valid_until || '',
        status: item?.status || 'active',
      }
    }),
  }
  editError.value = ''
}
function toggleEditRole(r: string) {
  if (editBusy.value) return
  const i = edit.value.roles.indexOf(r)
  i >= 0 ? edit.value.roles.splice(i, 1) : edit.value.roles.push(r)
}
function editQualification(code: QualificationCode) {
  return edit.value.qualifications.find(item => item.code === code)!
}
function toggleEditQualification(code: QualificationCode) {
  if (editBusy.value) return
  const item = editQualification(code)
  item.selected = !item.selected
  if (item.selected) item.status = 'active'
}
async function saveEdit() {
  if (editBusy.value || !editing.value) return
  if (!edit.value.name) return ElMessage.warning('姓名必填')
  if (!edit.value.roles.length) return ElMessage.warning('至少选一个岗位角色')
  editError.value = ''
  const targetUsername = editing.value.username
  const qualificationInputs: QualificationInput[] = edit.value.qualifications
    .filter(item => item.selected)
    .map(item => ({
      code: item.code,
      validFrom: item.validFrom || null,
      validUntil: item.validUntil || null,
      status: item.status,
    }))
  const payload = {
    name: edit.value.name,
    roles: [...edit.value.roles],
    qualifications: qualificationInputs.map(item => ({ ...item })),
  }
  editBusy.value = true
  try {
    await api.updateUserPersonnel(targetUsername, payload)
    ElMessage.success('基础岗位和专业审核资格已保存')
    if (editing.value?.username === targetUsername) editing.value = null
    await refresh()
  } catch (e: any) {
    editError.value = serverError(e)
    ElMessage.error(editError.value)
  } finally {
    editBusy.value = false
  }
}
const today = new Date().toISOString().slice(0, 10)
function qualifications(user: User) { return qualificationByUser.value[user.username] || [] }
function qualificationValidity(item: UserQualification) {
  if (!item.valid_from && !item.valid_until) return '长期有效'
  return `${item.valid_from || '不限'} 至 ${item.valid_until || '不限'}`
}
function qualificationUnavailable(item: UserQualification) {
  return item.status !== 'active' || (!!item.valid_until && item.valid_until < today)
}
// 人员授权效期（2026新规"先授权后上岗"）：过期拦签发、进资源预警
async function editCert(u: User) {
  const { value: name } = await ElMessageBox.prompt('授权/上岗证名称（如 授权签字人授权书 / 上岗证）', `${u.name} · 授权登记`, { confirmButtonText: '下一步', cancelButtonText: '取消', inputValue: u.cert_name || '' }).catch(() => ({ value: null as any }))
  if (name == null) return
  const { value: until } = await ElMessageBox.prompt('授权有效期至（YYYY-MM-DD；清空=不设限）', `${u.name} · 授权登记`, { confirmButtonText: '保存', cancelButtonText: '取消', inputValue: u.cert_until || '', inputValidator: (v: string) => (!v || /^\d{4}-\d{2}-\d{2}$/.test(v) ? true : '格式 YYYY-MM-DD') }).catch(() => ({ value: null as any }))
  if (until == null) return
  try {
    await api.updateUser(u.username, { certName: name.trim(), certUntil: until.trim() })
    ElMessage.success('授权信息已保存'); await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
// 停用 / 启用
async function toggleStatus(u: User) {
  const to = u.status === 'active' ? 'disabled' : 'active'
  const ok = await ElMessageBox.confirm(`确定${to === 'disabled' ? '停用' : '启用'}「${u.name}」？${to === 'disabled' ? '停用后该账号无法登录。' : ''}`, to === 'disabled' ? '停用账号' : '启用账号', { type: 'warning' }).catch(() => null)
  if (!ok) return
  try { await api.updateUser(u.username, { status: to }); ElMessage.success(to === 'disabled' ? '已停用' : '已启用'); await refresh() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
// 管理员重置密码
async function resetPw(u: User) {
  const v = await ElMessageBox.prompt(`给「${u.name}」设置新密码（至少 6 位）`, '重置密码', { inputType: 'password', inputPattern: /.{6,}/, inputErrorMessage: '至少 6 位' }).catch(() => null)
  if (!v) return
  try { await api.resetPassword(u.username, (v as any).value); ElMessage.success('已重置，请把新密码告知本人') }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
// 本人改密码
async function changeMyPw() {
  const oldPw = await ElMessageBox.prompt('输入当前密码', '改我的密码 (1/2)', { inputType: 'password' }).catch(() => null)
  if (!oldPw) return
  const newPw = await ElMessageBox.prompt('输入新密码（至少 6 位）', '改我的密码 (2/2)', { inputType: 'password', inputPattern: /.{6,}/, inputErrorMessage: '至少 6 位' }).catch(() => null)
  if (!newPw) return
  try { await api.changePassword((oldPw as any).value, (newPw as any).value); ElMessage.success('密码已修改') }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}

onMounted(refresh)
</script>

<template>
  <div class="pagewrap wide">
    <div class="phead">
      <div>
        <h1 class="page">人员与权限</h1>
        <p class="sub">对应国标 6.2.1：关键岗位人员先授权后上岗，留痕落到真实账号</p>
      </div>
      <div class="pacts">
        <el-button @click="changeMyPw">改我的密码</el-button>
        <el-button v-if="hasRole('admin')" type="primary" @click="showAdd = !showAdd">添加人员</el-button>
      </div>
    </div>

    <section>
      <div class="sechead">
        <h2>人员台账</h2>
        <span class="seccount num">共 {{ users.length }} 人</span>
      </div>

      <div class="card tcard">
        <div v-if="showAdd" class="addbox">
          <div class="row3">
            <label>用户名<input v-model="form.username" placeholder="拼音，如 lisi" /></label>
            <label>姓名<input v-model="form.name" placeholder="李四" /></label>
            <label>初始密码（至少 6 位）<input v-model="form.password" placeholder="明文显示，便于当面告知；首次登录会强制改密" /></label>
          </div>
          <div class="rlabel">基础岗位（可多选）</div>
          <div class="rchips">
            <button v-for="r in ROLE_KEYS" :key="r" type="button" class="rchip" :class="{ on: form.roles.includes(r) }" :aria-pressed="form.roles.includes(r)" @click="toggleRole(r)">{{ ROLE_LABEL[r] }}</button>
          </div>
          <div class="addacts">
            <el-button size="small" @click="showAdd = false">取消</el-button>
            <el-button size="small" type="primary" :loading="addBusy" :disabled="addBusy" @click="addUser">保存</el-button>
          </div>
        </div>

        <div v-if="editing" class="addbox" data-testid="qualification-editor">
          <div class="rlabel editflag">编辑「{{ editing.username }}」</div>
          <p v-if="editError" class="form-error" role="alert">{{ editError }}</p>
          <div class="row3">
            <label>姓名<input v-model="edit.name" :disabled="editBusy" /></label>
          </div>
          <div class="edit-section">
            <div class="rlabel group-title">基础岗位（可多选）</div>
            <p class="group-help">岗位决定日常工作入口，不代表具备专业复核或审核资格。</p>
            <div class="rchips">
              <button v-for="r in ROLE_KEYS" :key="r" type="button" class="rchip" :class="{ on: edit.roles.includes(r) }" :aria-pressed="edit.roles.includes(r)" :disabled="editBusy" @click="toggleEditRole(r)">{{ ROLE_LABEL[r] }}</button>
            </div>
          </div>
          <div class="edit-section qualification-section">
            <div class="rlabel group-title">专业审核资格（可多选）</div>
            <p class="group-help">按专业范围分别授权。“复核”与“审核”是两个不同资格，项目仍需计划员另行指定具体人员。</p>
            <div class="qualification-grid">
              <section v-for="group in QUALIFICATION_GROUPS" :key="group.scope" class="qscope">
                <h3>{{ group.label }}</h3>
                <div class="qchoices">
                  <button
                    v-for="code in group.codes" :key="code" type="button"
                    class="qtoggle" :class="{ on: editQualification(code).selected }"
                    :aria-pressed="editQualification(code).selected"
                    :data-qualification-code="code"
                    :disabled="editBusy"
                    @click="toggleEditQualification(code)"
                  >{{ code.endsWith('_review') ? '复核' : '审核' }}</button>
                </div>
                <div v-for="code in group.codes" v-show="editQualification(code).selected" :key="`${code}-dates`" class="validity-row">
                  <strong>{{ QUALIFICATION_LABEL[code] }}</strong>
                  <label>生效日期<input v-model="editQualification(code).validFrom" type="date" :data-valid-from="code" :disabled="editBusy" /></label>
                  <label>失效日期<input v-model="editQualification(code).validUntil" type="date" :data-valid-until="code" :disabled="editBusy" /></label>
                </div>
              </section>
            </div>
          </div>
          <div class="addacts">
            <el-button size="small" :disabled="editBusy" @click="editing = null">取消</el-button>
            <el-button size="small" type="primary" data-testid="save-user-edit" :loading="editBusy" :disabled="editBusy" @click="saveEdit">保存</el-button>
          </div>
        </div>

        <div class="list" v-loading="loading">
          <table>
            <colgroup>
              <col class="person-col" />
              <col class="username-col" />
              <col class="roles-col" />
              <col />
              <col class="status-col" />
              <col class="cert-col" />
              <col class="joined-col" />
              <col v-if="hasRole('admin')" class="actions-col" />
            </colgroup>
            <thead><tr><th>姓名</th><th>用户名</th><th>基础岗位</th><th>专业审核资格</th><th>状态</th><th>上岗授权</th><th>入职</th><th v-if="hasRole('admin')">操作</th></tr></thead>
            <tbody>
              <tr v-for="u in users" :key="u.username" :class="{ off: u.status !== 'active' }">
                <td class="nm"><span class="av">{{ u.name[0] }}</span>{{ u.name }}</td>
                <td class="mono username">{{ u.username }}</td>
                <td class="roles"><span v-for="(r, n) in u.roles" :key="r" class="role" :class="{ key: r === 'admin' }"><i v-if="n">·</i>{{ ROLE_LABEL[r] || r }}</span></td>
                <td class="qualifications">
                  <div v-if="qualificationErrors[u.username]" class="qualification-error" role="status">
                    <span>{{ qualificationErrors[u.username] }}</span>
                    <button
                      type="button" class="lk retry-link" :data-testid="`retry-qualifications-${u.username}`"
                      :disabled="qualificationLoading[u.username] || editBusy"
                      @click="retryQualifications(u)"
                    >{{ qualificationLoading[u.username] ? '重试中…' : '重试' }}</button>
                  </div>
                  <span v-else-if="qualificationLoading[u.username]" class="dim" role="status">专业审核资格加载中…</span>
                  <div v-else class="qualification-list">
                    <span v-if="!qualifications(u).length" class="dim">未授权</span>
                    <span v-for="item in qualifications(u)" :key="item.code" class="qualification-item" :class="{ unavailable: qualificationUnavailable(item) }">
                      <b>{{ QUALIFICATION_LABEL[item.code] }}</b>
                      <span class="mono">{{ qualificationValidity(item) }}</span>
                      <em v-if="item.status !== 'active'">已停用</em>
                      <em v-else-if="item.valid_until && item.valid_until < today">已过期</em>
                    </span>
                  </div>
                </td>
                <td><span class="st"><span class="sdot" :class="u.status === 'active' ? 'good' : ''"></span>{{ u.status === 'active' ? '在岗' : '停用' }}</span></td>
                <td class="mono dim">
                  <template v-if="u.cert_until"><span :class="{ expired: u.cert_until < today }">{{ u.cert_until }}</span><span v-if="u.cert_name" class="dim"> {{ u.cert_name }}</span></template>
                  <span v-else class="dim">未设</span>
                </td>
                <td class="mono dim joined-at">{{ u.created_at?.slice(0, 10) }}</td>
                <td v-if="hasRole('admin')" class="acts">
                  <div class="action-grid" role="group" :aria-label="`管理 ${u.name}`">
                    <button type="button" class="lk" :aria-label="`编辑 ${u.name}`" :data-testid="`edit-user-${u.username}`" :disabled="editBusy || !!qualificationErrors[u.username] || !!qualificationLoading[u.username]" @click="openEdit(u)">编辑</button>
                    <button type="button" class="lk" :aria-label="`授权 ${u.name}`" @click="editCert(u)">授权</button>
                    <button type="button" class="lk" :aria-label="`重置${u.name}的密码`" @click="resetPw(u)">重置密码</button>
                    <button type="button" class="lk" :aria-label="`${u.status === 'active' ? '停用' : '启用'} ${u.name}`" :class="u.status === 'active' ? 'danger' : ''" @click="toggleStatus(u)" :disabled="u.username === currentUser?.username">{{ u.status === 'active' ? '停用' : '启用' }}</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!users.length && !loading"><td class="empty" colspan="8">还没有人员</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <p class="perm-note">
      <b>权限怎么管：</b>基础岗位与专业审核资格分别管理。专业资格按采样、质控、实验室、报告四个范围授权，复核资格不能代替审核资格；项目中的具体复核人和审核人仍由计划员指定，服务端会再次核验资格、有效期和三人分离。
    </p>
  </div>
</template>

<style scoped>
.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:26px;gap:16px}
.page{font-size:24px;line-height:1.25;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:14px;line-height:1.5}
.pacts{display:flex;gap:8px;flex:none}
section{margin-bottom:20px}
.seccount{font-size:14px;color:var(--faint)}

.tcard{overflow:hidden}
.addbox{padding:16px 18px;border-bottom:1px solid var(--line);background:var(--surface-2)}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px}
.row3 label{display:flex;flex-direction:column;gap:8px;font-size:14px;color:var(--muted)}
.row3 input{min-height:44px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:8px 10px;font-size:16px;font-family:inherit;background:var(--surface);color:var(--ink)}
.row3 input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.rlabel{font-size:14px;color:var(--muted);margin-bottom:8px}
.editflag{font-weight:600;color:var(--accent-ink);margin-bottom:8px}
.rchips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
.rchip{display:inline-flex;align-items:center;justify-content:center;min-height:44px;font-size:14px;padding:8px 12px;border-radius:var(--radius-sm);border:1px solid var(--line-strong);cursor:pointer;color:var(--muted);background:var(--surface);font-family:inherit;transition:border-color .15s ease,color .15s ease,background .15s ease}
.rchip:hover{border-color:var(--accent);color:var(--accent-ink)}
.rchip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.rchip:disabled{cursor:not-allowed;opacity:.62}
.addacts{display:flex;justify-content:flex-end;gap:8px}
.edit-section{padding-top:16px;margin-top:16px;border-top:1px solid var(--line)}
.group-title{font-size:16px;font-weight:600;color:var(--ink)}
.group-help{margin:0 0 12px;color:var(--muted);font-size:14px;line-height:1.5}
.form-error{margin:0 0 16px;padding:10px 12px;border-left:3px solid var(--crit);background:color-mix(in srgb,var(--crit) 8%,var(--surface));color:var(--crit);font-size:14px;line-height:1.5}
.qualification-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.qscope{margin:0;padding:12px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.qscope h3{margin:0 0 8px;font-size:16px;line-height:1.5}
.qchoices{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.qtoggle{min-height:44px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--muted);font:500 14px/1.4 inherit;cursor:pointer}
.qtoggle.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.qtoggle:disabled{cursor:not-allowed;opacity:.62}
.qtoggle:focus-visible,.rchip:focus-visible,.lk:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.validity-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.validity-row strong{grid-column:1/-1;font-size:14px;font-weight:600}
.validity-row label{display:flex;flex-direction:column;gap:8px;color:var(--muted);font-size:14px}
.validity-row input{box-sizing:border-box;width:100%;min-height:44px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 8px;background:var(--surface);color:var(--ink);font:500 14px/1.4 var(--font-mono,ui-monospace,monospace)}
.validity-row input:focus{outline:2px solid var(--accent);outline-offset:-1px}

.list{overflow-x:auto}
table{width:100%;min-width:1280px;border-collapse:collapse;font-size:14px}
.person-col{width:120px}
.username-col{width:120px}
.roles-col{width:220px}
.status-col{width:80px}
.cert-col{width:110px}
.joined-col{width:110px}
.actions-col{width:196px}
th{text-align:left;padding:11px 16px;font-size:14px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line);background:var(--surface-2);white-space:nowrap}
td{padding:11px 16px;border-bottom:1px solid var(--line)}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--surface-2)}
.nm{font-weight:600;white-space:nowrap}
.av{width:28px;height:28px;margin-right:9px;border-radius:50%;background:var(--surface-2);color:var(--muted);display:inline-grid;place-items:center;vertical-align:middle;font-size:12px;font-weight:600}
.username,.joined-at{white-space:nowrap}
/* 岗位角色：纯文字，关键角色点亮，避免整列彩色胶囊 */
.roles{font-size:14px;color:var(--muted);min-width:160px}
.role{white-space:nowrap}
.role i{font-style:normal;color:var(--line-strong);margin:0 6px}
.role.key{color:var(--accent-ink);font-weight:600}
.qualifications{min-width:230px}
.qualification-list{display:flex;align-items:flex-start;flex-wrap:wrap;gap:6px 14px}
.qualification-item{display:inline-flex;align-items:baseline;gap:6px;line-height:1.45;white-space:nowrap}
.qualification-item b{font-size:14px;font-weight:600;color:var(--ink)}
.qualification-item .mono{font-size:12px;color:var(--muted)}
.qualification-item em{font-size:12px;font-style:normal;color:var(--crit)}
.qualification-item.unavailable b,.qualification-item.unavailable .mono{color:var(--crit)}
.qualification-error{display:flex;align-items:flex-start;gap:8px;color:var(--crit);font-size:14px;line-height:1.5;white-space:normal}
.retry-link{flex:none;min-height:44px;margin:-10px 0;padding:8px 6px}
.st{display:inline-flex;align-items:center;gap:7px;font-size:14px;color:var(--muted);white-space:nowrap}
tr.off td{color:var(--faint)}
tr.off .av{color:var(--faint)}
.acts{min-width:196px;vertical-align:top}
.action-grid{display:grid;grid-template-columns:repeat(2,minmax(76px,1fr));gap:8px;align-content:start}
.lk{min-height:44px;background:none;border:0;color:var(--accent);font-size:14px;cursor:pointer;padding:8px 6px;font-family:inherit}
.lk:hover{text-decoration:underline}
.lk.danger{color:var(--crit)}
.lk:disabled{color:var(--faint);cursor:not-allowed;text-decoration:none}
.action-grid .lk{display:inline-flex;align-items:center;justify-content:center;min-width:76px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);font-weight:600;padding:8px 10px;transition:border-color .15s ease,background .15s ease,color .15s ease}
.action-grid .lk:hover{border-color:var(--accent);background:var(--accent-soft);text-decoration:none}
.action-grid .lk.danger:hover{border-color:var(--crit);background:var(--crit-soft)}
.action-grid .lk:disabled{border-color:var(--line);background:var(--surface-2)}
.dim{color:var(--faint);font-size:14px}
.empty{color:var(--faint);font-size:14px;text-align:center;padding:20px 18px}
tbody tr:has(.empty):hover{background:transparent}
.perm-note{font-size:14px;color:var(--muted);line-height:1.7;margin:0;padding:0 2px}
.perm-note b{color:var(--ink);font-weight:600}
.expired{color:var(--crit);font-weight:700}

@media (max-width:900px){
  .qualification-grid{grid-template-columns:1fr}
  .row3{grid-template-columns:1fr}
}
@media (max-width:640px){
  .phead{flex-direction:column;margin-bottom:24px}
  .pacts{width:100%;flex-wrap:wrap}
  .pacts :deep(button){min-height:44px;flex:1}
  .addbox{padding:16px}
  .validity-row{grid-template-columns:1fr}
  .validity-row strong{grid-column:auto}
  .addacts :deep(button){min-height:44px}
}
</style>

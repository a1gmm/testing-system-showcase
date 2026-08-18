<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, ROLE_LABEL, hasRole, currentUser, type User } from '../api'

const users = ref<User[]>([])
const loading = ref(false)
const ROLE_KEYS = Object.keys(ROLE_LABEL)

async function refresh() {
  loading.value = true
  try { users.value = await api.listUsers() }
  catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
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
const edit = ref({ name: '', roles: [] as string[] })
function openEdit(u: User) {
  editing.value = u
  edit.value = { name: u.name, roles: [...u.roles] }
}
function toggleEditRole(r: string) {
  const i = edit.value.roles.indexOf(r)
  i >= 0 ? edit.value.roles.splice(i, 1) : edit.value.roles.push(r)
}
async function saveEdit() {
  if (!editing.value) return
  if (!edit.value.name) return ElMessage.warning('姓名必填')
  if (!edit.value.roles.length) return ElMessage.warning('至少选一个岗位角色')
  try {
    await api.updateUser(editing.value.username, { name: edit.value.name, roles: edit.value.roles })
    ElMessage.success('已保存'); editing.value = null; await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
const today = new Date().toISOString().slice(0, 10)
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
  <div class="pagewrap">
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
          <div class="rlabel">岗位角色（可多选）</div>
          <div class="rchips">
            <span v-for="r in ROLE_KEYS" :key="r" class="rchip" :class="{ on: form.roles.includes(r) }" @click="toggleRole(r)">{{ ROLE_LABEL[r] }}</span>
          </div>
          <div class="addacts">
            <el-button size="small" @click="showAdd = false">取消</el-button>
            <el-button size="small" type="primary" :loading="addBusy" :disabled="addBusy" @click="addUser">保存</el-button>
          </div>
        </div>

        <div v-if="editing" class="addbox">
          <div class="rlabel editflag">编辑「{{ editing.username }}」</div>
          <div class="row3">
            <label>姓名<input v-model="edit.name" /></label>
          </div>
          <div class="rlabel">岗位角色（可多选）</div>
          <div class="rchips">
            <span v-for="r in ROLE_KEYS" :key="r" class="rchip" :class="{ on: edit.roles.includes(r) }" @click="toggleEditRole(r)">{{ ROLE_LABEL[r] }}</span>
          </div>
          <div class="addacts">
            <el-button size="small" @click="editing = null">取消</el-button>
            <el-button size="small" type="primary" @click="saveEdit">保存</el-button>
          </div>
        </div>

        <div class="list" v-loading="loading">
          <table>
            <thead><tr><th>姓名</th><th>用户名</th><th>岗位角色（决定能干什么）</th><th>状态</th><th>授权有效期</th><th>入职</th><th v-if="hasRole('admin')">操作</th></tr></thead>
            <tbody>
              <tr v-for="u in users" :key="u.username" :class="{ off: u.status !== 'active' }">
                <td class="nm"><span class="av">{{ u.name[0] }}</span>{{ u.name }}</td>
                <td class="mono">{{ u.username }}</td>
                <td class="roles"><span v-for="(r, n) in u.roles" :key="r" class="role" :class="{ key: r === 'admin' }"><i v-if="n">·</i>{{ ROLE_LABEL[r] || r }}</span></td>
                <td><span class="st"><span class="sdot" :class="u.status === 'active' ? 'good' : ''"></span>{{ u.status === 'active' ? '在岗' : '停用' }}</span></td>
                <td class="mono dim">
                  <template v-if="u.cert_until"><span :class="{ expired: u.cert_until < today }">{{ u.cert_until }}</span><span v-if="u.cert_name" class="dim"> {{ u.cert_name }}</span></template>
                  <span v-else class="dim">未设</span>
                </td>
                <td class="mono dim">{{ u.created_at?.slice(0, 10) }}</td>
                <td v-if="hasRole('admin')" class="acts">
                  <button class="lk" @click="openEdit(u)">编辑</button>
                  <button class="lk" @click="editCert(u)">授权</button>
                  <button class="lk" @click="resetPw(u)">重置密码</button>
                  <button class="lk" :class="u.status === 'active' ? 'danger' : ''" @click="toggleStatus(u)" :disabled="u.username === currentUser?.username">{{ u.status === 'active' ? '停用' : '启用' }}</button>
                </td>
              </tr>
              <tr v-if="!users.length && !loading"><td class="empty" colspan="7">还没有人员</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <p class="perm-note">
      <b>权限怎么管：</b>复核只有「复核员」能点，终审只有「审核员」能点，报告盖章只有「授权签字人」能点，方案审批只有「技术负责人」能点——点错了系统会用人话告诉你差哪个权限。系统管理员全能。
    </p>
  </div>
</template>

<style scoped>
.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:26px;gap:16px}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
.pacts{display:flex;gap:8px;flex:none}
section{margin-bottom:20px}
.seccount{font-size:12px;color:var(--faint)}

.tcard{overflow:hidden}
.addbox{padding:16px 18px;border-bottom:1px solid var(--line);background:var(--surface-2)}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px}
.row3 label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)}
.row3 input{border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 9px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
.row3 input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.rlabel{font-size:11.5px;color:var(--muted);margin-bottom:6px}
.editflag{font-weight:600;color:var(--accent-ink);margin-bottom:8px}
.rchips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
.rchip{font-size:12px;padding:4px 12px;border-radius:20px;border:1px solid var(--line-strong);cursor:pointer;color:var(--muted);background:var(--surface);transition:border-color .13s ease,color .13s ease}
.rchip:hover{border-color:var(--accent);color:var(--accent-ink)}
.rchip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.addacts{display:flex;justify-content:flex-end;gap:8px}

.list{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:11px 18px;font-size:12px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line);background:var(--surface-2);white-space:nowrap}
td{padding:11px 18px;border-bottom:1px solid var(--line)}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--surface-2)}
.nm{font-weight:600;display:flex;align-items:center;gap:9px}
.av{width:28px;height:28px;border-radius:50%;background:var(--surface-2);color:var(--muted);display:grid;place-items:center;font-size:12px;font-weight:600;flex:none}
/* 岗位角色：纯文字，关键角色点亮，避免整列彩色胶囊 */
.roles{font-size:12.5px;color:var(--muted)}
.role i{font-style:normal;color:var(--line-strong);margin:0 6px}
.role.key{color:var(--accent-ink);font-weight:600}
.st{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);white-space:nowrap}
tr.off td{color:var(--faint)}
tr.off .av{color:var(--faint)}
.acts{white-space:nowrap}
.lk{background:none;border:0;color:var(--accent);font-size:12.5px;cursor:pointer;padding:2px 6px;font-family:inherit}
.lk:hover{text-decoration:underline}
.lk.danger{color:var(--crit)}
.lk:disabled{color:var(--faint);cursor:not-allowed;text-decoration:none}
.dim{color:var(--faint);font-size:12px}
.empty{color:var(--faint);font-size:13px;text-align:center;padding:20px 18px}
tbody tr:has(.empty):hover{background:transparent}
.perm-note{font-size:12px;color:var(--muted);line-height:1.7;margin:0;padding:0 2px}
.perm-note b{color:var(--ink);font-weight:600}
.expired{color:var(--crit);font-weight:700}
</style>

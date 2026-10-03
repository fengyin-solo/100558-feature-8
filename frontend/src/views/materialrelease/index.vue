<template>
  <section class="page" data-module="materialrelease">
    <header class="page-head">
      <div>
        <h2>物料放行管理</h2>
        <p class="page-desc">放行按物料批号归属仓库与分工放行人管控，跨仓拒收；放行后转只读；冻结/解冻归口质量部，数量超限挡回，结论实时回写批生产记录台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记物料放行单</button>
        <button class="btn" type="button" @click="exportRows">导出物料放行清单</button>
      </div>
    </header>

    <p class="identity-note">
      当前操作人：<strong>{{ store.user.name }}</strong>（{{ store.user.roleLabel }}<template v-if="store.user.warehouse">｜{{ store.user.warehouse }}</template>）<template v-if="store.user.duty">｜{{ store.user.duty }}</template>。
      所有放行、拒绝、冻结、解冻动作均实名记入操作日志。
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="tab-bar">
      <button class="tab-btn" :class="{ active: tab === 'orders' }" type="button" @click="tab = 'orders'">放行单</button>
      <button class="tab-btn" :class="{ active: tab === 'ledger' }" type="button" @click="tab = 'ledger'">放行台账（与批生产记录共用数量）</button>
    </div>

    <template v-if="tab === 'orders'">
      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <div v-if="banner" class="page-banner" :class="banner.ok ? 'ok' : 'err'">{{ banner.text }}</div>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)" :class="{ 'readonly-row': String(row.status) === '已放行' }">
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in legalActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
              <button class="link" type="button" @click="openLog(row)">日志</button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无物料放行数据，可先登记物料放行单</td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-else>
      <table class="data-table ledger-table">
        <thead>
          <tr>
            <th>放行单号</th><th>物料批号</th><th>物料名称</th><th>归属仓库</th>
            <th>放行数量</th><th>放行上限</th><th>关联批记录</th><th>产品名称</th>
            <th>放行人</th><th>放行日期</th><th>状态</th><th>台账结论</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in ledger" :key="item.orderNo">
            <td>{{ item.orderNo }}</td>
            <td>{{ item.batchNo }}</td>
            <td>{{ item.materialName }}</td>
            <td>{{ item.warehouse }}</td>
            <td>{{ item.releaseQty }}</td>
            <td>{{ item.releaseLimit }}</td>
            <td>{{ item.linkedBatch }}</td>
            <td>{{ item.productName || '—' }}</td>
            <td>{{ item.confirmer || '—' }}</td>
            <td>{{ item.releaseDate || '—' }}</td>
            <td>{{ item.status }}</td>
            <td>{{ item.conclusion || '—' }}</td>
          </tr>
          <tr v-if="!ledger.length">
            <td colspan="12" class="empty-state">暂无放行台账数据</td>
          </tr>
        </tbody>
      </table>
      <p class="page-foot">放行数量只以放行单为唯一数据源，批生产记录台账与本页看到的数量始终是同一份。</p>
    </template>

    <footer class="page-foot">
      <span>共 {{ total }} 条物料放行记录</span>
    </footer>

    <!-- 动作原因弹窗 -->
    <div v-if="dialog.action" class="modal-mask" @click.self="closeDialog">
      <div class="modal-card">
        <h3>{{ dialog.action }} · {{ dialog.row?.['单据号'] }}</h3>
        <p class="modal-hint">
          物料批号 {{ dialog.row?.['物料批号'] }}｜归属仓库 {{ dialog.row?.['归属仓库'] }}｜分工放行人 {{ dialog.row?.['分工放行人'] }}｜当前状态 {{ dialog.row?.status }}
        </p>
        <label class="full">
          <span>{{ reasonLabel(dialog.action) }}</span>
          <textarea v-model="dialog.reason" rows="3" :placeholder="reasonPlaceholder(dialog.action)"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="confirmDialog">确认提交</button>
        </div>
      </div>
    </div>

    <!-- 登记弹窗 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <div class="modal-card">
        <h3>登记物料放行单</h3>
        <p class="modal-hint">批号前缀决定仓库归属（YL/MATE 原辅料仓、BC 包材仓、CP 成品仓），分工放行人自动带出。</p>
        <div class="form-grid">
          <label>
            <span>物料批号 *</span>
            <input v-model="form.batchNo" placeholder="如 YL-240930" @blur="deriveAssignment" />
          </label>
          <label>
            <span>检验单号 *</span>
            <input v-model="form.qcNo" placeholder="如 QC-240930" />
          </label>
          <label>
            <span>物料名称 *</span>
            <input v-model="form.materialName" />
          </label>
          <label>
            <span>供应商</span>
            <input v-model="form.supplier" />
          </label>
          <label>
            <span>放行数量 *</span>
            <input v-model.number="form.qty" type="number" min="0" />
          </label>
          <label>
            <span>放行上限 *</span>
            <input v-model.number="form.limit" type="number" min="0" />
          </label>
          <label>
            <span>单位</span>
            <input v-model="form.unit" placeholder="kg / 套 / 瓶 / L" />
          </label>
          <label>
            <span>关联批生产记录批号 *</span>
            <select v-model="form.linkedBatch">
              <option value="">请选择批记录</option>
              <option v-for="batch in batchOptions" :key="batch" :value="batch">{{ batch }}</option>
            </select>
          </label>
          <label class="full">
            <span>归属仓库 / 分工放行人（自动）</span>
            <input :value="`${derivedWarehouse} / ${derivedOfficer}`" disabled />
          </label>
        </div>
        <div v-if="createError" class="page-banner err">{{ createError }}</div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交登记</button>
        </div>
      </div>
    </div>

    <!-- 操作日志弹窗 -->
    <div v-if="logRow" class="modal-mask" @click.self="logRow = null">
      <div class="modal-card">
        <h3>操作日志 · {{ logRow['单据号'] }}</h3>
        <p class="modal-hint">谁、在什么时间、以什么角色做了什么、结果如何——偏差追责依据。</p>
        <ul class="log-list">
          <li
            v-for="(item, index) in (logRow['操作日志'] as ReleaseAudit[])"
            :key="index"
            :class="{ 'log-reject': item.result === '拒绝执行' || item.result === '挡回' }"
          >
            <div><strong>{{ item.action }}</strong> → {{ item.result }}</div>
            <div class="log-meta">{{ item.time }}｜{{ item.operator }}（{{ item.role }}）</div>
            <div v-if="item.reason" class="log-meta">说明：{{ item.reason }}</div>
          </li>
        </ul>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="logRow = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { createReleaseOrder, releaseLedger } from '@/api/release-service'
import { assignmentOf } from '@/data/access'
import { listRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, ReleaseAudit } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('materialrelease')
const columns = ["单据号", "物料批号", "物料名称", "供应商", "检验单号", "归属仓库", "分工放行人", "放行数量", "放行上限", "单位", "关联批记录", "放行人", "放行日期", "放行状态"]
const statuses = ["待放行", "已放行", "已拒绝", "已冻结", "待解冻审批"]

const rows = ref<EntryRow[]>([])
const ledger = ref(releaseLedger())
const total = ref(0)
const filters = ref<Record<string, string>>({})
const filterFields = ["物料批号", "物料名称", "归属仓库", "关联批记录"]
const tab = ref<'orders' | 'ledger'>('orders')
const banner = ref<{ ok: boolean; text: string } | null>(null)

const stats = computed(() => [
  { label: '待放行物料', value: rows.value.filter((row) => String(row.status) === '待放行').length },
  { label: '已放行物料', value: rows.value.filter((row) => String(row.status) === '已放行').length },
  { label: '已冻结/待解冻', value: rows.value.filter((row) => ['已冻结', '待解冻审批'].includes(String(row.status))).length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

/** 当前状态下在状态机内合法的动作（越级动作直接不出按钮；权限不足仍可点击，服务端拒绝并留痕说明原因）。 */
function legalActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待放行':
      return ['确认放行', '拒绝放行', '冻结物料']
    case '已放行':
      return ['确认放行', '冻结物料']
    case '已冻结':
      return ['申请解冻']
    case '待解冻审批':
      return ['解冻审批通过', '解冻审批驳回']
    default:
      return []
  }
}

function reasonLabel(action?: string): string {
  switch (action) {
    case '拒绝放行':
      return '拒绝原因 *（检验结论/不合格项）'
    case '冻结物料':
      return '冻结原因 *（质量部填写）'
    case '申请解冻':
      return '解冻申请理由与依据 *（重新提申请，须附复检/整改材料）'
    case '解冻审批通过':
      return '审批意见（可空，默认批准并回到待放行）'
    case '解冻审批驳回':
      return '驳回原因 *（依据不足请说明缺什么）'
    default:
      return '备注'
  }
}

function reasonPlaceholder(action?: string): string {
  switch (action) {
    case '确认放行':
      return '无需填写，确认后数量校验通过即放行'
    case '拒绝放行':
      return '如：微生物限度不合格、含量低于标准……'
    case '冻结物料':
      return '如：留样观察异常、投诉调查需要……'
    case '申请解冻':
      return '如：复检合格，附复测报告编号 QC-xxxx-R……'
    case '解冻审批驳回':
      return '如：复测项目不全，请补充无菌复检后重新申请'
    default:
      return ''
  }
}

const dialog = reactive<{ action: string; reason: string; row: EntryRow | null }>({
  action: '',
  reason: '',
  row: null,
})

const REASON_ACTIONS = new Set(['拒绝放行', '冻结物料', '申请解冻', '解冻审批通过', '解冻审批驳回'])

function runAction(action: string, row: EntryRow) {
  banner.value = null
  if (REASON_ACTIONS.has(action)) {
    dialog.action = action
    dialog.reason = ''
    dialog.row = row
    return
  }
  submitAction(action, row, '')
}

function closeDialog() {
  dialog.action = ''
  dialog.reason = ''
  dialog.row = null
}

function confirmDialog() {
  if (!dialog.row) {
    return
  }
  const action = dialog.action
  const row = dialog.row
  const reason = dialog.reason
  closeDialog()
  submitAction(action, row, reason)
}

function submitAction(action: string, row: EntryRow, reason: string) {
  const result = applyAction(meta.key, Number(row.id), action, store.user, reason)
  banner.value = { ok: result.ok, text: result.message }
  reload()
}

const logRow = ref<EntryRow | null>(null)
function openLog(row: EntryRow) {
  logRow.value = row
}

/* --------------------------------- 登记单 --------------------------------- */

const creating = ref(false)
const createError = ref('')
const batchOptions = computed(() => listRows('batchrecord').map((row) => String(row['批号'])))

const form = reactive({
  batchNo: '',
  qcNo: '',
  materialName: '',
  supplier: '',
  qty: 0 as number,
  limit: 0 as number,
  unit: 'kg',
  linkedBatch: '',
})

const derivedWarehouse = computed(() => (form.batchNo.trim() ? assignmentOf(form.batchNo.trim()).warehouse : '—'))
const derivedOfficer = computed(() => (form.batchNo.trim() ? assignmentOf(form.batchNo.trim()).officer : '—'))

function deriveAssignment() {
  // assignmentOf 已在计算属性里联动，保留钩子便于未来扩展（如校验批号是否在册）。
}

function openCreate() {
  createError.value = ''
  Object.assign(form, { batchNo: '', qcNo: '', materialName: '', supplier: '', qty: 0, limit: 0, unit: 'kg', linkedBatch: '' })
  creating.value = true
}

function submitCreate() {
  createError.value = ''
  const result = createReleaseOrder({ ...form }, store.user)
  if (!result.ok) {
    createError.value = result.message
    return
  }
  creating.value = false
  banner.value = { ok: true, text: result.message }
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  banner.value = null
  const payload = listEntries(meta.key, filters.value)
  rows.value = payload.items
  total.value = payload.total
  ledger.value = releaseLedger()
}

onMounted(reload)
</script>

<style scoped>
.identity-note { font-size: 12px; color: var(--muted); margin: 0 0 12px; }
</style>

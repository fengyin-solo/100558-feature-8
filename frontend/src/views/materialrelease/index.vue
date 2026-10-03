<template>
  <section class="page" data-module="materialrelease">
    <header class="page-head">
      <div>
        <h2>物料放行管理</h2>
        <p class="page-desc">维护物料放行单，围绕物料批号、所属仓库、供应商、检验单号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记物料放行单</button>
        <button class="btn" type="button" @click="exportRows">导出物料放行清单</button>
      </div>
    </header>

    <p class="actor-line">
      当前操作人：{{ actorLabel }}。放行按仓库归属管理：只有本仓库且分工到该批号的放行人能确认/拒绝放行；
      冻结与批准解冻归质量部；解冻须重新提申请；已放行记录只读，重复确认只算一次。
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

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无物料放行数据，可先登记物料放行单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条物料放行记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="releaseTarget" class="modal-mask">
      <div class="modal-card">
        <h3>确认放行</h3>
        <p class="modal-line">物料批号：{{ releaseTarget['物料批号'] }}（{{ releaseTarget['所属仓库'] }}）</p>
        <p class="modal-line">待放行数量：{{ releaseTarget['待放行数量'] }}</p>
        <label class="filter-item">
          <span>放行数量</span>
          <input v-model.number="releaseQuantity" type="number" min="0" step="any" />
        </label>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="confirmRelease">确认放行</button>
          <button class="btn ghost" type="button" @click="closeRelease">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runReleaseAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('materialrelease')
const session = useSessionStore()
const columns = ["物料批号", "物料名称", "所属仓库", "供应商", "检验单号", "关联批号", "待放行数量", "放行数量", "放行人", "放行日期"]
const actions = ["确认放行", "拒绝放行", "冻结物料", "申请解冻", "批准解冻"]
const statuses = ["待放行", "已放行", "已拒绝", "已冻结", "解冻申请中"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const releaseTarget = ref<EntryRow | null>(null)
const releaseQuantity = ref<number>(0)

const actorLabel = computed(() =>
  session.warehouse
    ? `${session.operator}（${session.role} · ${session.warehouse}）`
    : `${session.operator}（${session.role}）`,
)

const stats = computed(() => [
  { label: '待放行物料', value: rows.value.filter((row) => row.status === '待放行').length },
  { label: '已放行物料', value: rows.value.filter((row) => row.status === '已放行').length },
  { label: '已冻结物料', value: rows.value.filter((row) => row.status === '已冻结').length },
  {
    label: '累计放行数量',
    value: rows.value
      .filter((row) => row.status === '已放行')
      .reduce((sum, row) => sum + Number(row['放行数量'] ?? 0), 0),
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '物料放行单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  // 待放行的确认放行先录入放行数量，越界或超限会在服务端挡回。
  if (action === '确认放行' && String(row.status) === '待放行') {
    releaseTarget.value = row
    releaseQuantity.value = Number(row['待放行数量'] ?? 0)
    return
  }
  const result = runReleaseAction(Number(row.id), action, session.actor)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function confirmRelease() {
  if (!releaseTarget.value) {
    return
  }
  const result = runReleaseAction(
    Number(releaseTarget.value.id),
    '确认放行',
    session.actor,
    Number(releaseQuantity.value),
  )
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  releaseTarget.value = null
  reload()
}

function closeRelease() {
  releaseTarget.value = null
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '物料放行列表读取失败'
  }
}

onMounted(reload)
</script>

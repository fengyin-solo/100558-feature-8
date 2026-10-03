import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, Actor, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// —— 物料放行：按仓库归属与角色分工管起来的状态机 ——

const RELEASE_KEY = 'materialrelease'
const LEDGER_KEY = 'batchrecord'
const ROLE_RELEASER = '仓库放行人'
const ROLE_QA = '质量部'

// 状态顺着往下推进：每个动作只允许从指定状态发起，越级的一律拒收。
// 解冻不直接放行，必须先重新提申请，再由质量部批准回到待放行。
const RELEASE_FLOW: Record<string, { from: string; to: string }> = {
  确认放行: { from: '待放行', to: '已放行' },
  拒绝放行: { from: '待放行', to: '已拒绝' },
  冻结物料: { from: '待放行', to: '已冻结' },
  申请解冻: { from: '已冻结', to: '解冻申请中' },
  批准解冻: { from: '解冻申请中', to: '待放行' },
}

function today(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// 放行/拒绝/申请解冻：只有该批号所属仓库、且分工到该批号的放行人推得动。
function checkWarehouseReleaser(row: EntryRow, actor: Actor, action: string): ActionResult | null {
  if (actor.role !== ROLE_RELEASER) {
    return { ok: false, message: `「${action}」只有仓库放行人能操作，当前角色「${actor.role}」已被拒绝` }
  }
  const warehouse = String(row['所属仓库'] ?? '')
  if (actor.warehouse !== warehouse) {
    return {
      ok: false,
      message: `跨仓操作被拒绝：物料批号 ${row['物料批号']} 属于「${warehouse}」，当前账号归属「${actor.warehouse || '未分配仓库'}」，跨仓操作一律拒绝`,
    }
  }
  const assignee = String(row['放行人'] ?? '')
  if (assignee && actor.operator !== assignee) {
    return {
      ok: false,
      message: `仓库放行人按物料批号分工：批号 ${row['物料批号']} 由「${assignee}」负责，当前账号「${actor.operator}」无权操作`,
    }
  }
  return null
}

// 放行数量越界（不是正数）或超限（超过待放行数量）的挡回。
function checkReleaseQuantity(row: EntryRow, quantity: number | undefined): ActionResult | null {
  if (quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
    return {
      ok: false,
      message: `放行数量越界：须为大于 0 的数值，本次提交「${quantity ?? '空'}」，已挡回`,
    }
  }
  const available = Number(row['待放行数量'] ?? 0)
  if (quantity > available) {
    return {
      ok: false,
      message: `放行数量超限：批号 ${row['物料批号']} 待放行数量 ${available}，本次提交 ${quantity}，已挡回`,
    }
  }
  return null
}

// 结论回写到批生产记录台账：按关联批号找到台账记录，写入放行/拒绝结论。
function writeBackLedger(row: EntryRow, conclusion: string, actor: Actor): void {
  const batchNo = String(row['关联批号'] ?? '')
  if (!batchNo) {
    return
  }
  const rows = listRows(LEDGER_KEY)
  const index = rows.findIndex((item) => String(item['批号']) === batchNo)
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = {
    ...next[index],
    物料放行结论: `${conclusion}（${actor.operator}，${today()}）`,
  }
  saveRows(LEDGER_KEY, next)
}

export function runReleaseAction(
  id: number,
  action: string,
  actor: Actor,
  quantity?: number,
): ActionResult {
  const flow = RELEASE_FLOW[action]
  if (!flow) {
    return { ok: false, message: `物料放行单没有登记「${action}」这个动作` }
  }
  const rows = listRows(RELEASE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的物料放行单` }
  }
  const row = rows[index]
  const current = String(row.status)

  // 放行后转只读，其余角色碰不得；同一张放行单重复确认只算一次，不重复回写台账。
  if (current === '已放行') {
    if (action === '确认放行') {
      return { ok: true, message: `放行单 ${row['物料批号']} 已确认放行，重复确认只算一次，结论与数量不重复入账` }
    }
    return { ok: false, message: `放行单 ${row['物料批号']} 已放行，记录已转只读，任何角色都不能再执行「${action}」` }
  }
  if (current === '已拒绝') {
    return { ok: false, message: `放行单 ${row['物料批号']} 已拒绝并终结，记录只读，不能执行「${action}」` }
  }

  // 状态顺着往下推进，越级的拒收。
  if (current !== flow.from) {
    return {
      ok: false,
      message: `状态越级被拒收：「${action}」只能从「${flow.from}」发起，当前状态是「${current}」`,
    }
  }

  // 冻结与批准解冻的权限收在质量部；其余动作按仓库归属 + 批号分工校验。
  if (action === '冻结物料' || action === '批准解冻') {
    if (actor.role !== ROLE_QA) {
      return { ok: false, message: `「${action}」权限收在质量部，当前角色「${actor.role}」无权操作` }
    }
  } else {
    const denied = checkWarehouseReleaser(row, actor, action)
    if (denied) {
      return denied
    }
  }

  if (action === '确认放行') {
    const invalid = checkReleaseQuantity(row, quantity)
    if (invalid) {
      return invalid
    }
  }

  const updated: EntryRow = { ...row, status: flow.to }
  if (action === '确认放行') {
    updated['放行数量'] = quantity as number
    updated['放行日期'] = today()
    updated.pending = false
    updated.abnormal = false
  } else if (action === '拒绝放行') {
    updated.pending = false
    updated.abnormal = true
  } else if (action === '冻结物料') {
    updated['冻结人'] = actor.operator
    updated.pending = true
    updated.abnormal = true
  } else if (action === '申请解冻') {
    updated['解冻申请人'] = actor.operator
    updated.pending = true
    updated.abnormal = true
  } else if (action === '批准解冻') {
    updated['批准解冻人'] = actor.operator
    updated.pending = true
    updated.abnormal = false
  }

  const next = [...rows]
  next[index] = updated
  saveRows(RELEASE_KEY, next)

  // 放行/拒绝是结论性动作，回写批生产记录台账；冻结与解冻不写结论。
  if (action === '确认放行' || action === '拒绝放行') {
    writeBackLedger(updated, flow.to, actor)
  }
  return { ok: true, message: `物料放行单 ${row['物料批号']} 已${action}，当前状态「${flow.to}」` }
}

// 批生产记录台账：放行数量与物料放行模块共用一份数据，
// 这里按关联批号实时汇总已放行数量，不另存副本，多处看到的就是同一份。
export function releasedQuantityByBatch(): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of listRows(RELEASE_KEY)) {
    if (String(row.status) !== '已放行') {
      continue
    }
    const batchNo = String(row['关联批号'] ?? '')
    if (!batchNo) {
      continue
    }
    totals.set(batchNo, (totals.get(batchNo) ?? 0) + Number(row['放行数量'] ?? 0))
  }
  return totals
}

export function listBatchLedger(filters: Record<string, string> = {}): PageResult {
  const totals = releasedQuantityByBatch()
  const matched = filterRows(listRows(LEDGER_KEY), filters).map((row) => ({
    ...row,
    放行数量: totals.get(String(row['批号'] ?? '')) ?? 0,
  }))
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === RELEASE_KEY) {
    return { ok: false, message: '物料放行单的状态流转必须带操作人身份走放行流程，已拦截' }
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

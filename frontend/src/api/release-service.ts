import { assignmentOf, isQuality, type UserAccount } from '@/data/access'
import { allRows, listRows, saveAll } from '@/data/local-store'
import type { ActionResult, EntryRow, ReleaseAudit, ReleaseLedgerEntry } from '@/data/types'

/**
 * 物料放行专用服务：
 * - 放行按「物料批号 → 归属仓库 → 分工放行人」收口，跨仓/非分工人员一律拒绝并说明原因；
 * - 放行后转只读，仅质量部可再冻结；冻结/解冻审批权限收在质量部，解冻必须重新提申请；
 * - 状态沿状态机逐级推进，越级操作拒收；同一张放行单重复确认只算一次；
 * - 放行数量以放行单为唯一数据源，超上限/越界挡回；结论实时回写批生产记录台账。
 */

export const RELEASE_KEY = 'materialrelease'
const BATCH_KEY = 'batchrecord'

export const RELEASE_STATUSES = ['待放行', '已放行', '已拒绝', '已冻结', '待解冻审批'] as const

const LEDGER_FIELD = '放行台账回写'

type AuditInput = Omit<ReleaseAudit, 'time'>

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function dayText(): string {
  return nowText().slice(0, 10)
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function asNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

/** 从「500 kg」「1,000 套」这类投料量文本里取出数字用于越界比对。 */
function leadingNumber(text: string): number {
  const match = text.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : NaN
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function appendLog(row: EntryRow, entry: AuditInput): void {
  const logs = Array.isArray(row['操作日志']) ? (row['操作日志'] as ReleaseAudit[]) : []
  logs.push({ time: nowText(), ...entry })
  row['操作日志'] = logs
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function findBatchRow(rows: EntryRow[], batchNo: string): EntryRow | undefined {
  if (!batchNo) {
    return undefined
  }
  return rows.find((row) => asText(row['批号']) === batchNo)
}

/** 台账结论文本：结论回写到批生产记录，数量永远引用放行单本体（共用一份）。 */
function ledgerText(row: EntryRow): string {
  const qty = `${asText(row['放行数量'])}${asText(row['单位'])}`
  const limit = `${asText(row['放行上限'])}${asText(row['单位'])}`
  switch (String(row.status)) {
    case '已放行':
      return `已放行 ${qty} / 上限 ${limit}｜放行人 ${asText(row['放行人'])}｜${asText(row['放行日期'])}｜结论：${asText(row['台账结论'])}`
    case '已拒绝':
      return `已拒绝｜放行人 ${asText(row['放行人'])}｜${asText(row['放行日期'])}｜结论：${asText(row['台账结论'])}`
    case '已冻结':
      return `已冻结｜冻结人 ${asText(row['冻结人'])}｜${asText(row['冻结时间'])}｜原因：${asText(row['冻结原因'])}`
    case '待解冻审批':
      return `已冻结（解冻申请审批中）｜冻结人 ${asText(row['冻结人'])}｜${asText(row['冻结时间'])}｜申请人 ${asText(row['解冻申请人'])}｜${asText(row['解冻申请时间'])}`
    default:
      return `待放行｜申请放行数量 ${qty} / 上限 ${limit}｜分工放行人 ${asText(row['分工放行人'])}（${asText(row['归属仓库'])}）`
  }
}

/** 把放行结论写回批生产记录台账；放行单本身始终落库，关联批号缺失时仅给出业务提示。 */
function writeBack(releaseRows: EntryRow[], row: EntryRow): string | null {
  const batchRows = listRows(BATCH_KEY)
  const linked = asText(row['关联批记录'])
  const target = findBatchRow(batchRows, linked)
  if (!target) {
    saveAll({ ...allRows(), [RELEASE_KEY]: releaseRows })
    return `关联批生产记录「${linked || '未填写'}」不存在，结论暂未回写台账，请先维护对应批记录`
  }
  target[LEDGER_FIELD] = ledgerText(row)
  saveAll({ ...allRows(), [RELEASE_KEY]: releaseRows, [BATCH_KEY]: batchRows })
  return null
}

function persistPair(releaseRows: EntryRow[]): void {
  saveAll({ ...allRows(), [RELEASE_KEY]: releaseRows })
}

/* ---------------------------------- 鉴权 ---------------------------------- */

function denyRelease(row: EntryRow, user: UserAccount, action: string): string | null {
  const batchNo = asText(row['物料批号'])
  const warehouse = asText(row['归属仓库'])
  const officer = asText(row['分工放行人'])
  if (isQuality(user)) {
    return `质量部不承担仓库放行职责：物料批号 ${batchNo} 归属「${warehouse}」，仅该批号分工放行人「${officer}」可执行「${action}」`
  }
  if (user.role === 'warehouse_keeper') {
    return `仓库管理员无放行权限：物料批号 ${batchNo} 的「${action}」仅由分工放行人「${officer}」执行`
  }
  if (user.role === 'warehouse_officer') {
    if (user.warehouse !== warehouse) {
      return `跨仓操作已拒绝：物料批号 ${batchNo} 归属「${warehouse}」，当前账号属「${user.warehouse ?? '未分配仓库'}」，仅该仓分工放行人「${officer}」可操作`
    }
    if (user.name !== officer) {
      return `放行被拒绝：物料批号 ${batchNo} 分工给放行人「${officer}」，你不在该批号的分工名单内`
    }
  }
  return null
}

function denyFreeze(user: UserAccount): string | null {
  if (!isQuality(user)) {
    return '冻结权限已收归质量部，仓库及其他角色无权执行冻结'
  }
  return null
}

function denyThawApply(row: EntryRow, user: UserAccount): string | null {
  const batchNo = asText(row['物料批号'])
  const warehouse = asText(row['归属仓库'])
  if (isQuality(user)) {
    return '解冻必须由归属仓库重新提出申请，质量部只受理审批，不代为申请'
  }
  if (user.warehouse !== warehouse) {
    return `跨仓操作已拒绝：物料批号 ${batchNo} 归属「${warehouse}」，解冻申请只能由该仓人员发起`
  }
  return null
}

function denyThawApprove(user: UserAccount): string | null {
  if (!isQuality(user)) {
    return '解冻审批权限在质量部，仓库角色无权审批解冻'
  }
  return null
}

/* -------------------------------- 数量校验 -------------------------------- */

function validateQuantity(row: EntryRow): string | null {
  const qty = asNumber(row['放行数量'])
  const limit = asNumber(row['放行上限'])
  if (!Number.isFinite(qty) || qty <= 0) {
    return `放行数量「${asText(row['放行数量'])}」越界：必须为大于 0 的数字，已挡回`
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return `放行上限「${asText(row['放行上限'])}」越界：必须为大于 0 的数字，已挡回`
  }
  if (qty > limit) {
    return `放行数量 ${qty}${asText(row['单位'])} 超过本单放行上限 ${limit}${asText(row['单位'])}，已挡回`
  }
  const batch = findBatchRow(listRows(BATCH_KEY), asText(row['关联批记录']))
  if (batch) {
    const feed = leadingNumber(asText(batch['投料量']))
    if (Number.isFinite(feed) && qty > feed) {
      return `放行数量 ${qty}${asText(row['单位'])} 超过批生产记录「${asText(batch['批号'])}」投料量 ${asText(batch['投料量'])}，已挡回`
    }
  }
  return null
}

/* --------------------------------- 动作流 --------------------------------- */

export function runReleaseAction(id: number, action: string, reason: string, user: UserAccount): ActionResult {
  const rows = listRows(RELEASE_KEY).map((row) => ({ ...row, 操作日志: Array.isArray(row['操作日志']) ? [...(row['操作日志'] as ReleaseAudit[])] : [] }))
  const row = findRow(rows, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的物料放行单`)
  }
  const status = String(row.status)

  // 已放行单据转只读：同一放行人重复确认只算一次、不重复回写；其余角色一律碰不得。
  if (status === '已放行' && action === '确认放行') {
    if (user.name === asText(row['分工放行人'])) {
      return {
        ok: true,
        message: `该放行单已于 ${asText(row['放行日期'])} 由 ${asText(row['放行人'])} 确认放行，重复确认只计一次，不重复回写台账`,
      }
    }
    return fail(`放行单已放行并转只读：仅分工放行人「${asText(row['分工放行人'])}」可查看，质量部可执行冻结，你无权再操作`)
  }

  // 状态机：只允许逐级推进，越级直接拒收。
  const allowed: Record<string, string[]> = {
    待放行: ['确认放行', '拒绝放行', '冻结物料'],
    已放行: ['冻结物料'],
    已拒绝: [],
    已冻结: ['申请解冻'],
    待解冻审批: ['解冻审批通过', '解冻审批驳回'],
  }
  if (!allowed[status]?.includes(action)) {
    return fail(`越级操作拒收：当前状态「${status}」不允许执行「${action}」，放行状态只能沿流程逐级推进`)
  }

  // 鉴权。
  let denied: string | null = null
  if (action === '确认放行' || action === '拒绝放行') {
    denied = denyRelease(row, user, action)
  } else if (action === '冻结物料') {
    denied = denyFreeze(user)
  } else if (action === '申请解冻') {
    denied = denyThawApply(row, user)
  } else if (action === '解冻审批通过' || action === '解冻审批驳回') {
    denied = denyThawApprove(user)
  }
  if (denied) {
    // 越权尝试也留痕，偏差追责有据可查。
    appendLog(row, { action, operator: user.name, role: user.roleLabel, result: '拒绝执行', reason: denied })
    persistPair(rows)
    return fail(denied)
  }

  let message = ''
  if (action === '确认放行') {
    const invalid = validateQuantity(row)
    if (invalid) {
      appendLog(row, { action, operator: user.name, role: user.roleLabel, result: '挡回', reason: invalid })
      persistPair(rows)
      return fail(invalid)
    }
    row.status = '已放行'
    row.pending = false
    row.abnormal = false
    row['放行人'] = user.name
    row['放行日期'] = dayText()
    row['放行状态'] = '已放行'
    row['台账结论'] = '合格放行'
    appendLog(row, { action, operator: user.name, role: user.roleLabel, result: '已放行' })
    const warn = writeBack(rows, row)
    message = `放行单 ${asText(row['单据号'])} 已确认放行，结论已回写批生产记录台账${warn ? `；但${warn}` : ''}`
  } else if (action === '拒绝放行') {
    if (!reason.trim()) {
      return fail('拒绝放行必须填写原因（检验结论/不合格项），否则拒收')
    }
    row.status = '已拒绝'
    row.pending = false
    row.abnormal = true
    row['放行人'] = user.name
    row['放行日期'] = dayText()
    row['放行状态'] = '已拒绝'
    row['台账结论'] = `拒绝放行（${reason.trim()}）`
    appendLog(row, { action, operator: user.name, role: user.roleLabel, result: '已拒绝', reason: reason.trim() })
    const warn = writeBack(rows, row)
    message = `放行单已拒绝并转只读，结论已回写批生产记录台账${warn ? `；但${warn}` : ''}`
  } else if (action === '冻结物料') {
    if (!reason.trim()) {
      return fail('冻结必须由质量部填写冻结原因，否则拒收')
    }
    row.status = '已冻结'
    row.pending = true
    row.abnormal = true
    row['放行状态'] = '已冻结'
    row['冻结人'] = user.name
    row['冻结时间'] = nowText()
    row['冻结原因'] = reason.trim()
    row['解冻申请人'] = ''
    row['解冻申请时间'] = ''
    row['解冻申请原因'] = ''
    appendLog(row, { action, operator: user.name, role: user.roleLabel, result: '已冻结', reason: reason.trim() })
    const warn = writeBack(rows, row)
    message = `质量部已冻结物料批号 ${asText(row['物料批号'])}，仓库须重新提交解冻申请${warn ? `；但${warn}` : ''}`
  } else if (action === '申请解冻') {
    if (!reason.trim()) {
      return fail('解冻申请必须填写申请理由/附件依据，否则拒收')
    }
    row.status = '待解冻审批'
    row['放行状态'] = '待解冻审批'
    row['解冻申请人'] = user.name
    row['解冻申请时间'] = nowText()
    row['解冻申请原因'] = reason.trim()
    appendLog(row, { action, operator: user.name, role: user.roleLabel, result: '待解冻审批', reason: reason.trim() })
    const warn = writeBack(rows, row)
    message = `解冻申请已提交质量部审批，审批通过后放行单回到「待放行」，须由分工放行人重新确认${warn ? `；但${warn}` : ''}`
  } else if (action === '解冻审批通过') {
    row.status = '待放行'
    row.pending = true
    row.abnormal = false
    row['放行状态'] = '待放行'
    row['放行人'] = ''
    row['放行日期'] = ''
    row['台账结论'] = ''
    row['冻结人'] = ''
    row['冻结时间'] = ''
    row['冻结原因'] = ''
    row['解冻申请人'] = ''
    row['解冻申请时间'] = ''
    row['解冻申请原因'] = ''
    appendLog(row, { action, operator: user.name, role: user.roleLabel, result: '待放行', reason: reason.trim() || '解冻申请批准，重新进入放行流程' })
    const warn = writeBack(rows, row)
    message = `解冻申请已批准，放行单回到「待放行」，须由分工放行人「${asText(row['分工放行人'])}」重新确认放行${warn ? `；但${warn}` : ''}`
  } else if (action === '解冻审批驳回') {
    row.status = '已冻结'
    row['解冻申请人'] = ''
    row['解冻申请时间'] = ''
    row['解冻申请原因'] = ''
    appendLog(row, { action, operator: user.name, role: user.roleLabel, result: '已冻结', reason: reason.trim() || '解冻依据不足，驳回申请' })
    const warn = writeBack(rows, row)
    message = `解冻申请已驳回，物料维持冻结，仓库可补正依据后重新申请${warn ? `；但${warn}` : ''}`
  }

  return { ok: true, message }
}

/* --------------------------------- 登记单 --------------------------------- */

export type CreateReleaseInput = {
  batchNo: string
  materialName: string
  supplier: string
  qcNo: string
  qty: number
  limit: number
  unit: string
  linkedBatch: string
}

export function createReleaseOrder(input: CreateReleaseInput, user: UserAccount): ActionResult {
  const batchNo = input.batchNo.trim()
  if (!batchNo) {
    return fail('物料批号不能为空')
  }
  const assignment = assignmentOf(batchNo)
  if (user.role === 'warehouse_keeper' || user.role === 'warehouse_officer') {
    if (user.warehouse !== assignment.warehouse) {
      return fail(`跨仓登记被拒绝：物料批号 ${batchNo} 按归属规则属「${assignment.warehouse}」，请由该仓人员登记`)
    }
  } else if (isQuality(user)) {
    return fail('质量部不登记仓库放行单，请由归属仓库人员发起登记')
  }
  if (!input.materialName.trim() || !input.qcNo.trim()) {
    return fail('物料名称与检验单号为必填项')
  }
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    return fail('放行数量越界：必须为大于 0 的数字')
  }
  if (!Number.isFinite(input.limit) || input.limit <= 0) {
    return fail('放行上限越界：必须为大于 0 的数字')
  }
  if (input.qty > input.limit) {
    return fail(`放行数量 ${input.qty}${input.unit} 超过放行上限 ${input.limit}${input.unit}，登记已挡回`)
  }
  const batchRows = listRows(BATCH_KEY)
  if (!input.linkedBatch.trim()) {
    return fail('必须关联批生产记录批号，否则无法回写台账')
  }
  if (!findBatchRow(batchRows, input.linkedBatch.trim())) {
    return fail(`批生产记录「${input.linkedBatch.trim()}」不存在，无法登记放行单`)
  }

  const rows = listRows(RELEASE_KEY)
  const duplicate = rows.find(
    (row) => asText(row['物料批号']) === batchNo && ['待放行', '已冻结', '待解冻审批'].includes(String(row.status)),
  )
  if (duplicate) {
    return fail(`物料批号 ${batchNo} 已有在途放行单 ${asText(duplicate['单据号'])}（${String(duplicate.status)}），不得重复登记`)
  }

  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: '待放行',
    pending: true,
    abnormal: false,
    单据号: `RL-${dayText().replace(/-/g, '')}-${String(id).padStart(2, '0')}`,
    物料批号: batchNo,
    物料名称: input.materialName.trim(),
    供应商: input.supplier.trim() || '待补录',
    检验单号: input.qcNo.trim(),
    放行数量: input.qty,
    放行上限: input.limit,
    单位: input.unit.trim() || 'kg',
    归属仓库: assignment.warehouse,
    分工放行人: assignment.officer,
    关联批记录: input.linkedBatch.trim(),
    放行人: '',
    放行日期: '',
    放行状态: '待放行',
    台账结论: '',
    冻结人: '',
    冻结时间: '',
    冻结原因: '',
    解冻申请人: '',
    解冻申请时间: '',
    解冻申请原因: '',
    操作日志: [],
  }
  appendLog(row, { action: '登记放行单', operator: user.name, role: user.roleLabel, result: '待放行' })
  persistPair([...rows, row])
  return { ok: true, message: `放行单 ${asText(row['单据号'])} 已登记：批号 ${batchNo} 归属「${assignment.warehouse}」，分工放行人「${assignment.officer}」` }
}

/* --------------------------------- 台账视图 -------------------------------- */

/** 台账（放行数量多处共用这一份）：由放行单实时派生，批记录页与放行台账页看到的永远一致。 */
export function releaseLedger(): ReleaseLedgerEntry[] {
  return listRows(RELEASE_KEY).map((row) => ({
    orderNo: asText(row['单据号']),
    batchNo: asText(row['物料批号']),
    materialName: asText(row['物料名称']),
    warehouse: asText(row['归属仓库']),
    linkedBatch: asText(row['关联批记录']),
    productName: asText(findBatchRow(listRows(BATCH_KEY), asText(row['关联批记录']))?.['产品名称']),
    releaseQty: asNumber(row['放行数量']) || 0,
    releaseLimit: asNumber(row['放行上限']) || 0,
    confirmer: asText(row['放行人']),
    releaseDate: asText(row['放行日期']),
    status: String(row.status),
    conclusion: asText(row['台账结论']),
  }))
}

/** 批记录页按批号取共用的放行数量（唯一数据源在放行单）。 */
export function releasedQtyOfBatch(batchNo: string): { qty: number; unit: string; status: string; orderNo: string } | null {
  const row = listRows(RELEASE_KEY).find((item) => asText(item['关联批记录']) === batchNo)
  if (!row) {
    return null
  }
  return {
    qty: asNumber(row['放行数量']) || 0,
    unit: asText(row['单位']),
    status: String(row.status),
    orderNo: asText(row['单据号']),
  }
}

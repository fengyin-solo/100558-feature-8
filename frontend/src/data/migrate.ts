import { assignmentOf, inferWarehouse, officerOf } from './access'
import type { EntryRow, ReleaseAudit } from './types'

/**
 * 存量数据迁移：
 * 用户浏览器里可能还是改造前的旧结构（无仓库归属、无分工、无日志）。
 * 读取时一次性按旧记录回填，回填结果直接持久化；迁移幂等，已带迁移标记的行不重复处理。
 */
const MIGRATION_TAG = '存量回填v1'

const RELEASE_TERMINAL_STATUSES = ['已放行', '已拒绝']
const RELEASE_ABNORMAL_STATUSES = ['已拒绝', '已冻结', '待解冻审批']

function text(row: EntryRow, field: string): string {
  const value = row[field]
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function migrateMaterialRow(row: EntryRow): EntryRow {
  // 已迁移或本就是新结构（带单据号、仓库归属、操作日志）的行只做状态旗标归一，不回填。
  const isModern =
    row['迁移标记'] === MIGRATION_TAG ||
    (text(row, '单据号') !== '' && text(row, '归属仓库') !== '' && Array.isArray(row['操作日志']))
  if (isModern) {
    return normalizeReleaseFlags(row)
  }
  const batchNo = text(row, '物料批号') || `旧批号-${row.id}`
  const assignment = assignmentOf(batchNo)
  const qty = Number(row['放行数量'])
  const status = RELEASE_TERMINAL_STATUSES.includes(String(row.status)) ||
    ['待放行', '已冻结', '待解冻审批'].includes(String(row.status))
    ? String(row.status)
    : '待放行'
  const oldOfficer = text(row, '放行人')
  const releaseDate = text(row, '放行日期')

  const next: EntryRow = {
    ...row,
    status,
    单据号: text(row, '单据号') || `RL-LEGACY-${String(row.id).padStart(3, '0')}`,
    物料批号: batchNo,
    物料名称: text(row, '物料名称') || '存量物料（待补录）',
    供应商: text(row, '供应商') || '存量供应商（待补录）',
    检验单号: text(row, '检验单号') || `QC-LEGACY-${String(row.id).padStart(3, '0')}`,
    放行数量: Number.isFinite(qty) && qty > 0 ? qty : 0,
    放行上限: Number(row['放行上限']) > 0 ? Number(row['放行上限']) : Number.isFinite(qty) && qty > 0 ? qty : 100,
    单位: text(row, '单位'),
    归属仓库: text(row, '归属仓库') || assignment.warehouse || inferWarehouse(batchNo),
    分工放行人: text(row, '分工放行人') || assignment.officer || officerOf(inferWarehouse(batchNo)),
    关联批记录: text(row, '关联批记录'),
    放行人: status === '已放行' ? oldOfficer || assignment.officer : oldOfficer,
    放行日期: status === '已放行' && !releaseDate ? '存量日期待补录' : releaseDate,
    放行状态: status,
    台账结论:
      text(row, '台账结论') ||
      (status === '已放行'
        ? '合格放行（按旧记录回填）'
        : status === '已拒绝'
          ? '拒绝放行（按旧记录回填）'
          : ''),
    冻结人: text(row, '冻结人'),
    冻结时间: text(row, '冻结时间'),
    解冻申请人: text(row, '解冻申请人'),
    解冻申请时间: text(row, '解冻申请时间'),
    迁移标记: MIGRATION_TAG,
  }

  const logs: ReleaseAudit[] = Array.isArray(row['操作日志'])
    ? (row['操作日志'] as ReleaseAudit[])
    : buildLegacyLogs(row, next)
  next['操作日志'] = logs
  return normalizeReleaseFlags(next)
}

function buildLegacyLogs(legacy: EntryRow, filled: EntryRow): ReleaseAudit[] {
  const logs: ReleaseAudit[] = [
    {
      time: '存量数据',
      action: '登记放行单（旧记录回填）',
      operator: '系统迁移',
      role: '数据迁移',
      result: '待放行',
      reason: `按旧记录回填：仓库 ${filled['归属仓库']}、分工放行人 ${filled['分工放行人']}`,
    },
  ]
  const legacyOperator = text(legacy, '放行人') || text(filled, '分工放行人')
  if (filled.status === '已放行') {
    logs.push({
      time: text(filled, '放行日期') || '存量数据',
      action: '确认放行（旧记录回填）',
      operator: legacyOperator,
      role: `${text(filled, '归属仓库')}放行人`,
      result: '已放行',
    })
  } else if (filled.status === '已拒绝') {
    logs.push({
      time: text(filled, '放行日期') || '存量数据',
      action: '拒绝放行（旧记录回填）',
      operator: legacyOperator,
      role: `${text(filled, '归属仓库')}放行人`,
      result: '已拒绝',
    })
  } else if (filled.status === '已冻结') {
    logs.push({
      time: text(filled, '冻结时间') || '存量数据',
      action: '冻结物料（旧记录回填）',
      operator: text(filled, '冻结人') || '质量部（待补录）',
      role: '质量部',
      result: '已冻结',
    })
  }
  return logs
}

function normalizeReleaseFlags(row: EntryRow): EntryRow {
  const status = String(row.status)
  return {
    ...row,
    pending: status === '待放行' || status === '已冻结' || status === '待解冻审批',
    abnormal: RELEASE_ABNORMAL_STATUSES.includes(status),
  }
}

export function migrateRows(raw: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const output: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(raw)) {
    if (key === 'materialrelease') {
      output[key] = rows.map(migrateMaterialRow)
      continue
    }
    if (key === 'batchrecord') {
      output[key] = rows.map((row) =>
        row['迁移标记'] === MIGRATION_TAG
          ? row
          : { ...row, 放行台账回写: typeof row['放行台账回写'] === 'string' ? row['放行台账回写'] : '', 迁移标记: MIGRATION_TAG },
      )
      continue
    }
    output[key] = rows
  }
  return output
}

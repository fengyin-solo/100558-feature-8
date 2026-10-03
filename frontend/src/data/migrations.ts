import type { EntryRow } from './types'

// 存量数据迁移：旧记录没有所属仓库、待放行数量、关联批号这些字段，
// 首次打开时按旧记录里的既有信息回填，让新的放行权限模型直接生效。
export const STORAGE_VERSION = 2

const WAREHOUSES = ['原料库', '辅料库', '包材库']
// 仓库放行人按物料批号分工：迁移时每个仓库先归到一名默认放行人名下。
const WAREHOUSE_RELEASERS: Record<string, string> = {
  原料库: '王强',
  辅料库: '赵磊',
  包材库: '陈晨',
}

function rowsOf(value: unknown): EntryRow[] {
  return Array.isArray(value) ? (value as EntryRow[]) : []
}

function toNumber(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

// 旧放行单按顺序落仓；旧「放行数量」视为待放行总量，已放行的才保留为已放行数量。
function migrateReleaseRows(releaseRows: EntryRow[], batchRows: EntryRow[]): EntryRow[] {
  return releaseRows.map((row, index) => {
    if (row['所属仓库'] !== undefined && row['待放行数量'] !== undefined) {
      return row
    }
    const warehouse = WAREHOUSES[index % WAREHOUSES.length]
    const legacyQty = toNumber(row['放行数量'])
    const released = String(row.status) === '已放行'
    const batch = batchRows[index]
    return {
      ...row,
      所属仓库: warehouse,
      待放行数量: legacyQty,
      放行数量: released ? legacyQty : 0,
      放行人: WAREHOUSE_RELEASERS[warehouse],
      放行日期: released ? String(row['放行日期'] ?? '') : '',
      关联批号: batch ? String(batch['批号'] ?? '') : '',
    }
  })
}

// 旧台账没有放行结论：按旧放行单的状态回填，已放行/已拒绝的补写结论。
function backfillLedger(releaseRows: EntryRow[], batchRows: EntryRow[]): EntryRow[] {
  return batchRows.map((batch) => {
    if (batch['物料放行结论'] !== undefined) {
      return batch
    }
    const linked = releaseRows.find(
      (row) =>
        String(row['关联批号'] ?? '') !== '' &&
        row['关联批号'] === batch['批号'] &&
        (row.status === '已放行' || row.status === '已拒绝'),
    )
    const conclusion = linked
      ? `${linked.status}（${linked['放行人']}，${linked['放行日期'] || '—'}）`
      : ''
    return { ...batch, 物料放行结论: conclusion }
  })
}

export function migrateEntries(entries: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const releaseRows = migrateReleaseRows(rowsOf(entries['materialrelease']), rowsOf(entries['batchrecord']))
  return {
    ...entries,
    materialrelease: releaseRows,
    batchrecord: backfillLedger(releaseRows, rowsOf(entries['batchrecord'])),
  }
}

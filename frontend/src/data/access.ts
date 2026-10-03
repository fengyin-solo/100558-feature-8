import type { BatchAssignment } from './types'

/** 角色：质量部把持冻结与解冻审批；仓库放行人按仓库/批号分工；仓库管理员只能发起解冻申请。 */
export type RoleCode = 'qa_manager' | 'qa_inspector' | 'warehouse_officer' | 'warehouse_keeper'

export type UserAccount = {
  name: string
  role: RoleCode
  roleLabel: string
  /** 仓库放行人/管理员所属仓库；质量部不归属任何仓库。 */
  warehouse?: string
  /** 质量部职责描述，用于权限提示。 */
  duty?: string
}

/** 仓库主数据：物料批号先落到仓库，权限再按仓库切分。 */
export const WAREHOUSES = ['原辅料仓', '包材仓', '成品仓'] as const

export const USERS: UserAccount[] = [
  { name: '周严', role: 'qa_manager', roleLabel: '质量部经理', duty: '冻结权限与解冻审批归口质量部' },
  { name: '秦检', role: 'qa_inspector', roleLabel: '质量部专员', duty: '执行质量部的冻结与解冻审批' },
  { name: '王原', role: 'warehouse_officer', roleLabel: '原辅料仓放行人', warehouse: '原辅料仓' },
  { name: '李包', role: 'warehouse_officer', roleLabel: '包材仓放行人', warehouse: '包材仓' },
  { name: '赵成', role: 'warehouse_officer', roleLabel: '成品仓放行人', warehouse: '成品仓' },
  { name: '陈管', role: 'warehouse_keeper', roleLabel: '原辅料仓管理员', warehouse: '原辅料仓' },
  { name: '钱管', role: 'warehouse_keeper', roleLabel: '包材仓管理员', warehouse: '包材仓' },
  { name: '孙管', role: 'warehouse_keeper', roleLabel: '成品仓管理员', warehouse: '成品仓' },
]

export const USER_BY_NAME = new Map(USERS.map((user) => [user.name, user]))

export function isQuality(user?: UserAccount | null): boolean {
  return !!user && (user.role === 'qa_manager' || user.role === 'qa_inspector')
}

/** 批号前缀 → 归属仓库，登记放行单选批号时自动带出仓库归属与分工放行人。 */
const PREFIX_WAREHOUSE: Array<[string[], string]> = [
  [['YL', 'MATE'], '原辅料仓'],
  [['BC'], '包材仓'],
  [['CP'], '成品仓'],
]

/** 迁移旧记录时按批号推断仓库归属。 */
export function inferWarehouse(batchNo: string): string {
  const head = batchNo.trim().toUpperCase()
  for (const [prefixes, warehouse] of PREFIX_WAREHOUSE) {
    if (prefixes.some((prefix) => head.startsWith(prefix))) {
      return warehouse
    }
  }
  return '原辅料仓'
}

export function officerOf(warehouse: string): string {
  const user = USERS.find((item) => item.role === 'warehouse_officer' && item.warehouse === warehouse)
  return user?.name ?? ''
}

/**
 * 按物料批号的分工表：仓库放行人具体负责哪些批号。
 * 命中分工表时只有分工人可放行；未登记分工的批号退回「该仓库放行人」兜底（含迁移回填的旧记录）。
 */
export const BATCH_ASSIGNMENTS: BatchAssignment[] = [
  { batchNo: 'YL-240901', warehouse: '原辅料仓', officer: '王原' },
  { batchNo: 'YL-240905', warehouse: '原辅料仓', officer: '王原' },
  { batchNo: 'YL-240909', warehouse: '原辅料仓', officer: '王原' },
  { batchNo: 'BC-240912', warehouse: '包材仓', officer: '李包' },
  { batchNo: 'CP-240918', warehouse: '成品仓', officer: '赵成' },
]

export function assignmentOf(batchNo: string): BatchAssignment {
  const hit = BATCH_ASSIGNMENTS.find((item) => item.batchNo === batchNo)
  if (hit) {
    return hit
  }
  const warehouse = inferWarehouse(batchNo)
  return { batchNo, warehouse, officer: officerOf(warehouse) }
}

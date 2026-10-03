/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 业务字段随模块不同而不同（物料放行单还挂着操作日志等结构），统一收敛到 unknown 索引。
  [field: string]: unknown
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 物料放行单操作日志：谁在什么时间以什么角色做了什么，偏差追责就靠它。 */
export type ReleaseAudit = {
  time: string
  action: string
  operator: string
  role: string
  result: string
  reason?: string
}

/** 物料批号分工：一个批号固定归属一个仓库、一名放行人。 */
export type BatchAssignment = {
  batchNo: string
  warehouse: string
  officer: string
}

/** 放行台账（批生产记录页共用）：数量只取放行单这一份，台账不另存副本。 */
export type ReleaseLedgerEntry = {
  orderNo: string
  batchNo: string
  materialName: string
  warehouse: string
  linkedBatch: string
  productName: string
  releaseQty: number
  releaseLimit: number
  confirmer: string
  releaseDate: string
  status: string
  conclusion: string
}

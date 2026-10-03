import { migrateRows } from './migrate'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pharma-cleanroom:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function persist(data: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(SEED_ROWS)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = clone(SEED_ROWS)
    persist(seeded)
    return seeded
  }
  let parsed: Record<string, EntryRow[]>
  try {
    parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  } catch {
    const fallback = clone(SEED_ROWS)
    persist(fallback)
    return fallback
  }
  // 旧版本数据缺字段时按旧记录补齐，新版本数据只做幂等归一。
  const merged = { ...clone(SEED_ROWS), ...parsed }
  const migrated = migrateRows(merged)
  persist(migrated)
  return migrated
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(next)
}

export function saveAll(data: Record<string, EntryRow[]>): void {
  cache = data
  persist(data)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

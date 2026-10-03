import { migrateEntries, STORAGE_VERSION } from './migrations'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 存储带版本号；读到旧版（无版本号）的存量数据时先按旧记录回填迁移，再继续用。
const STORAGE_KEY = 'pharma-cleanroom:entries'

type StorageShape = {
  version: number
  entries: Record<string, EntryRow[]>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function persist(entries: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const payload: StorageShape = { version: STORAGE_VERSION, entries }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

function sanitize(value: unknown): Record<string, EntryRow[]> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const clean: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(rows)) {
      clean[key] = rows as EntryRow[]
    }
  }
  return clean
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      persist(fallback)
      return fallback
    }
    // 旧版存量数据：整个对象就是各模块记录，没有版本号，按旧记录回填迁移。
    const entries =
      'entries' in parsed
        ? sanitize((parsed as StorageShape).entries)
        : migrateEntries(sanitize(parsed))
    const merged = { ...fallback, ...entries }
    persist(merged)
    return merged
  } catch {
    persist(fallback)
    return fallback
  }
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

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

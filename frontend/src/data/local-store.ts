import { SEED_ROWS } from './seed'
import { emptyRecoveryState, type RecoveryState } from './recovery'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'data-product-ops:entries'
// 回收批次与释放台账和业务记录放在同一个对象里，提交时只写一次 localStorage，
// 保证「活动结束 + 预算释放」要么都生效、要么都不生效。
const RECOVERY_KEY = '__recovery__'

type RawStore = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fallbackRaw(): RawStore {
  return { ...clone(SEED_ROWS), [RECOVERY_KEY]: emptyRecoveryState() }
}

function readRaw(): RawStore {
  const fallback = fallbackRaw()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as RawStore
    // 旧版本的存储里没有回收键，合并 fallback 时自动补上（向前兼容）；
    // 示例数据升级后旧记录缺新字段，也以本版本示例字段为准补齐。
    const merged: RawStore = { ...fallback, ...parsed }
    for (const [key, rows] of Object.entries(merged)) {
      if (key === RECOVERY_KEY || !Array.isArray(rows)) continue
      const seedRows = (SEED_ROWS[key] ?? []) as EntryRow[]
      const seedById = new Map(seedRows.map((row) => [Number(row.id), row]))
      merged[key] = (rows as EntryRow[]).map((row) => {
        const seed = seedById.get(Number(row.id))
        return seed ? { ...seed, ...row } : row
      })
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function writeRaw(raw: RawStore): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(raw))
  }
}

function entriesOf(raw: RawStore): Record<string, EntryRow[]> {
  const entries: Record<string, EntryRow[]> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key !== RECOVERY_KEY) {
      entries[key] = value as EntryRow[]
    }
  }
  return entries
}

export function allRows(): Record<string, EntryRow[]> {
  return entriesOf(readRaw())
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const raw = readRaw()
  raw[key] = rows
  writeRaw(raw)
}

export function readRecoveryState(): RecoveryState {
  const raw = readRaw()
  const stored = raw[RECOVERY_KEY] as RecoveryState | undefined
  return stored ? clone(stored) : emptyRecoveryState()
}

export function saveRecoveryState(state: RecoveryState): void {
  const raw = readRaw()
  raw[RECOVERY_KEY] = state
  writeRaw(raw)
}

/** 一次写入多张业务表 + 回收状态，作为回收提交的原子操作。 */
export function commitTransaction(patch: Record<string, EntryRow[]>, recovery: RecoveryState): void {
  const raw = readRaw()
  for (const [key, rows] of Object.entries(patch)) {
    raw[key] = rows
  }
  raw[RECOVERY_KEY] = recovery
  writeRaw(raw)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

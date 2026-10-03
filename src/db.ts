import Dexie, { type Table } from 'dexie'
import type { Debt, Purchase, ShoppingItem, Task } from './types'

type LocalSettings = { key: string; value: string }

export type OutboxItem = {
  id?: number
  entity: 'task' | 'shopping' | 'purchase' | 'debt'
  operation: 'upsert' | 'delete'
  recordId: string
  payload?: Task | ShoppingItem | Purchase | Debt
  createdAt: string
  /** Server rejections so far. Reset by a manual retry. */
  retryCount?: number
  /** Set at MAX_RETRIES. Surfaced in the UI; no longer attempted automatically. */
  flagged?: boolean
  /** Most recent failure message, for display. */
  lastError?: string
}

class TandaanDB extends Dexie {
  tasks!: Table<Task, string>
  shopping!: Table<ShoppingItem, string>
  purchases!: Table<Purchase, string>
  debts!: Table<Debt, string>
  settings!: Table<LocalSettings, string>
  outbox!: Table<OutboxItem, number>

  constructor() {
    super('tandaan')
    this.version(1).stores({ tasks: 'id, updatedAt, dueDate, isCompleted', settings: 'key' })
    this.version(2).stores({ tasks: 'id, updatedAt, dueDate, isCompleted', settings: 'key', outbox: '++id, entity, operation, recordId, createdAt' })
    this.version(3).stores({ tasks: 'id, updatedAt, dueDate, isCompleted', shopping: 'id, updatedAt, isPurchased', purchases: 'id, updatedAt, purchasedAt', settings: 'key', outbox: '++id, entity, operation, recordId, createdAt' })
    this.version(4).stores({ tasks: 'id, updatedAt, dueDate, isCompleted, reminderAt', shopping: 'id, updatedAt, isPurchased', purchases: 'id, updatedAt, purchasedAt', settings: 'key', outbox: '++id, entity, operation, recordId, createdAt' })
    this.version(5).stores({ tasks: 'id, updatedAt, dueDate, isCompleted, reminderAt', shopping: 'id, updatedAt, isPurchased', purchases: 'id, updatedAt, purchasedAt', debts: 'id, updatedAt, dueDate, direction', settings: 'key', outbox: '++id, entity, operation, recordId, createdAt' })
  }
}

export const db = new TandaanDB()

export async function getLocalName() {
  const row = await db.settings.get('displayName')
  return row?.value ?? ''
}

export async function setLocalName(name: string) {
  await db.settings.put({ key: 'displayName', value: name })
}

export async function getLocalTheme() {
  const row = await db.settings.get('theme')
  return row?.value ?? ''
}

export async function setLocalTheme(theme: string) {
  await db.settings.put({ key: 'theme', value: theme })
}

// Pastel colour variant is device-local, like the custom background. It is
// intentionally not synced to Supabase.
export async function getLocalThemeColor() {
  const row = await db.settings.get('themeColor')
  return row?.value ?? ''
}

export async function setLocalThemeColor(color: string) {
  await db.settings.put({ key: 'themeColor', value: color })
}

export async function getLocalThemeCustomizations<T = unknown>(): Promise<T | null> {  const row = await db.settings.get('themeCustomizations')
  if (!row?.value) return null
  try {
    return JSON.parse(row.value) as T
  } catch {
    return null
  }
}

export async function setLocalThemeCustomizations(value: unknown) {
  await db.settings.put({ key: 'themeCustomizations', value: JSON.stringify(value) })
}

export async function queueUpsert(entity: OutboxItem['entity'], payload: OutboxItem['payload']) {
  if (!payload) return
  await db.outbox.add({ entity, operation: 'upsert', recordId: payload.id, payload, createdAt: new Date().toISOString() })
}

export async function queueDelete(entity: OutboxItem['entity'], id: string) {
  await db.outbox.add({ entity, operation: 'delete', recordId: id, createdAt: new Date().toISOString() })
}

export const queueTaskUpsert = (task: Task) => queueUpsert('task', task)
export const queueTaskDelete = (id: string) => queueDelete('task', id)

export const queueDebtUpsert = (debt: Debt) => queueUpsert('debt', debt)
export const queueDebtDelete = (id: string) => queueDelete('debt', id)

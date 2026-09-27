import Dexie, { type Table } from 'dexie'
import type { Purchase, ShoppingItem, Task } from './types'

type LocalSettings = { key: string; value: string }

type OutboxItem = {
  id?: number
  entity: 'task' | 'shopping' | 'purchase'
  operation: 'upsert' | 'delete'
  recordId: string
  payload?: Task | ShoppingItem | Purchase
  createdAt: string
}

class TandaanDB extends Dexie {
  tasks!: Table<Task, string>
  shopping!: Table<ShoppingItem, string>
  purchases!: Table<Purchase, string>
  settings!: Table<LocalSettings, string>
  outbox!: Table<OutboxItem, number>

  constructor() {
    super('tandaan')
    this.version(1).stores({ tasks: 'id, updatedAt, dueDate, isCompleted', settings: 'key' })
    this.version(2).stores({ tasks: 'id, updatedAt, dueDate, isCompleted', settings: 'key', outbox: '++id, entity, operation, recordId, createdAt' })
    this.version(3).stores({ tasks: 'id, updatedAt, dueDate, isCompleted', shopping: 'id, updatedAt, isPurchased', purchases: 'id, updatedAt, purchasedAt', settings: 'key', outbox: '++id, entity, operation, recordId, createdAt' })
    this.version(4).stores({ tasks: 'id, updatedAt, dueDate, isCompleted, reminderAt', shopping: 'id, updatedAt, isPurchased', purchases: 'id, updatedAt, purchasedAt', settings: 'key', outbox: '++id, entity, operation, recordId, createdAt' })
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

export async function queueUpsert(entity: OutboxItem['entity'], payload: OutboxItem['payload']) {
  if (!payload) return
  await db.outbox.add({ entity, operation: 'upsert', recordId: payload.id, payload, createdAt: new Date().toISOString() })
}

export async function queueDelete(entity: OutboxItem['entity'], id: string) {
  await db.outbox.add({ entity, operation: 'delete', recordId: id, createdAt: new Date().toISOString() })
}

export const queueTaskUpsert = (task: Task) => queueUpsert('task', task)
export const queueTaskDelete = (id: string) => queueDelete('task', id)

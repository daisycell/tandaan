import Dexie, { type Table } from 'dexie'
import type { Task } from './types'

type LocalSettings = { key: string; value: string }

type OutboxItem = {
  id?: number
  entity: 'task'
  operation: 'upsert' | 'delete'
  recordId: string
  payload?: Task
  createdAt: string
}

class TandaanDB extends Dexie {
  tasks!: Table<Task, string>
  settings!: Table<LocalSettings, string>
  outbox!: Table<OutboxItem, number>

  constructor() {
    super('tandaan')
    this.version(1).stores({
      tasks: 'id, updatedAt, dueDate, isCompleted',
      settings: 'key'
    })
    this.version(2).stores({
      tasks: 'id, updatedAt, dueDate, isCompleted',
      settings: 'key',
      outbox: '++id, entity, operation, recordId, createdAt'
    })
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

export async function queueTaskUpsert(task: Task) {
  await db.outbox.put({
    entity: 'task',
    operation: 'upsert',
    recordId: task.id,
    payload: task,
    createdAt: new Date().toISOString()
  })
}

export async function queueTaskDelete(id: string) {
  await db.outbox.put({
    entity: 'task',
    operation: 'delete',
    recordId: id,
    createdAt: new Date().toISOString()
  })
}

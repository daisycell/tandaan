import Dexie, { type Table } from 'dexie'
import type { Task } from './types'

type LocalSettings = { key: string; value: string }

class TandaanDB extends Dexie {
  tasks!: Table<Task, string>
  settings!: Table<LocalSettings, string>

  constructor() {
    super('tandaan')
    this.version(1).stores({
      tasks: 'id, updatedAt, dueDate, isCompleted',
      settings: 'key'
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

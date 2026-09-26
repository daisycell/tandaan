import { db } from './db'
import { supabase } from './supabase'
import type { Task } from './types'

function toDbTask(task: Task, userId: string) {
  return {
    id: task.id,
    user_id: userId,
    title: task.title,
    is_completed: task.isCompleted,
    due_date: task.dueDate ?? null,
    due_time: task.dueTime ?? null,
    reminder_enabled: true,
    reminder_minutes_before: 1440,
    created_at: task.createdAt,
    updated_at: task.updatedAt
  }
}

function fromDbTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    isCompleted: Boolean(row.is_completed),
    dueDate: row.due_date ? String(row.due_date) : null,
    dueTime: row.due_time ? String(row.due_time).slice(0, 5) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

export async function getUserId() {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  if (data.session?.user?.id) return data.session.user.id

  const { data: signInData, error } = await supabase.auth.signInAnonymously()
  if (error) throw error
  return signInData.user?.id ?? null
}

async function queueLatestTask(task: Task) {
  // We keep the local outbox append-only. The sync worker processes entries in
  // creation order, so the latest task mutation wins on the server.
  await db.outbox.put({
    entity: 'task',
    operation: 'upsert',
    recordId: task.id,
    payload: task,
    createdAt: new Date().toISOString()
  })
}

export async function syncTasks(): Promise<Task[]> {
  if (!supabase) return db.tasks.toArray()
  const userId = await getUserId()
  if (!userId) return db.tasks.toArray()

  const lastSyncRow = await db.settings.get('lastTaskSyncAt')
  const lastSyncAt = lastSyncRow?.value ?? null

  // Remember deletes that still need to reach the server so a remote fetch does
  // not immediately resurrect the locally deleted record if the request fails.
  const pendingDeleteIds = new Set(
    (await db.outbox.where('operation').equals('delete').toArray()).map(item => item.recordId)
  )

  // Flush local mutations first.
  const pending = await db.outbox.orderBy('id').toArray()
  for (const item of pending) {
    try {
      if (item.operation === 'upsert' && item.payload) {
        const { error } = await supabase
          .from('tasks')
          .upsert(toDbTask(item.payload, userId), { onConflict: 'id' })
        if (error) throw error
      } else if (item.operation === 'delete') {
        const { error } = await supabase
          .from('tasks')
          .delete()
          .eq('id', item.recordId)
          .eq('user_id', userId)
        if (error) throw error
      }
      if (item.id !== undefined) await db.outbox.delete(item.id)
    } catch {
      // Leave the failed item queued for the next sync attempt.
      break
    }
  }

  const { data, error } = await supabase
    .from('tasks')
    .select('id,title,is_completed,due_date,due_time,created_at,updated_at')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })

  if (error) throw error

  const remoteTasks = (data ?? []).map(row => fromDbTask(row as Record<string, unknown>))
  const localTasks = await db.tasks.toArray()
  const remoteById = new Map(remoteTasks.map(task => [task.id, task]))
  const localById = new Map(localTasks.map(task => [task.id, task]))

  // Merge remote records. Local changes newer than the last sync remain local;
  // otherwise the server copy wins.
  for (const remote of remoteTasks) {
    if (pendingDeleteIds.has(remote.id)) continue
    const local = localById.get(remote.id)
    if (!local || remote.updatedAt >= local.updatedAt) {
      await db.tasks.put(remote)
    } else {
      await queueLatestTask(local)
    }
  }

  // Reconcile local records that are missing remotely. Records changed after the
  // previous successful sync are local-new/locally-edited and need uploading.
  // Older records are considered remotely deleted and are removed locally.
  for (const local of localTasks) {
    if (remoteById.has(local.id) || pendingDeleteIds.has(local.id)) continue
    const changedSinceLastSync = !lastSyncAt || local.updatedAt > lastSyncAt
    if (changedSinceLastSync) {
      await queueLatestTask(local)
    } else {
      await db.tasks.delete(local.id)
    }
  }

  // A successful round establishes a new sync boundary used for future
  // remote-deletion reconciliation.
  await db.settings.put({ key: 'lastTaskSyncAt', value: new Date().toISOString() })

  return db.tasks.toArray()
}

export async function syncProfile(name: string, timezone: string) {
  if (!supabase) return
  const userId = await getUserId()
  if (!userId) return
  const { error } = await supabase.from('profiles').upsert({
    id: userId,
    display_name: name,
    timezone,
    onboarding_complete: true,
    updated_at: new Date().toISOString()
  })
  if (error) throw error
}

export async function getRemoteProfile() {
  if (!supabase) return null
  const userId = await getUserId()
  if (!userId) return null
  const { data, error } = await supabase
    .from('profiles')
    .select('id,display_name,timezone,onboarding_complete')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

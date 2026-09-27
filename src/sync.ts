import { db } from './db'
import { supabase } from './supabase'
import type { Purchase, ShoppingItem, Task } from './types'

function toDbTask(task: Task, userId: string) {
  return { id: task.id, user_id: userId, title: task.title, is_completed: task.isCompleted, due_date: task.dueDate ?? null, due_time: task.dueTime ?? null, reminder_enabled: task.reminderEnabled ?? true, reminder_minutes_before: task.reminderMinutesBefore ?? 1440, reminder_at: task.reminderAt ?? null, reminder_sent_at: task.reminderSentAt ?? null, created_at: task.createdAt, updated_at: task.updatedAt }
}
function fromDbTask(row: Record<string, unknown>): Task {
  return { id: String(row.id), title: String(row.title), isCompleted: Boolean(row.is_completed), dueDate: row.due_date ? String(row.due_date) : null, dueTime: row.due_time ? String(row.due_time).slice(0, 5) : null, reminderEnabled: row.reminder_enabled !== false, reminderMinutesBefore: row.reminder_minutes_before == null ? 1440 : Number(row.reminder_minutes_before), reminderAt: row.reminder_at ? String(row.reminder_at) : null, reminderSentAt: row.reminder_sent_at ? String(row.reminder_sent_at) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
function toDbShopping(item: ShoppingItem, userId: string) {
  return { id: item.id, user_id: userId, name: item.name, quantity: item.quantity ?? null, unit: item.unit ?? null, expected_price: item.expectedPrice ?? null, is_purchased: item.isPurchased, created_at: item.createdAt, updated_at: item.updatedAt }
}
function fromDbShopping(row: Record<string, unknown>): ShoppingItem {
  return { id: String(row.id), name: String(row.name), quantity: row.quantity == null ? null : Number(row.quantity), unit: row.unit ? String(row.unit) : null, expectedPrice: row.expected_price == null ? null : Number(row.expected_price), isPurchased: Boolean(row.is_purchased), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
function toDbPurchase(item: Purchase, userId: string) {
  return { id: item.id, user_id: userId, item_name: item.itemName, quantity: item.quantity ?? null, unit: item.unit ?? null, price: item.price ?? null, currency: item.currency, purchased_at: item.purchasedAt, notes: item.notes ?? null, created_at: item.createdAt, updated_at: item.updatedAt }
}
function fromDbPurchase(row: Record<string, unknown>): Purchase {
  return { id: String(row.id), itemName: String(row.item_name), quantity: row.quantity == null ? null : Number(row.quantity), unit: row.unit ? String(row.unit) : null, price: row.price == null ? null : Number(row.price), currency: String(row.currency ?? 'PHP') as 'PHP', purchasedAt: String(row.purchased_at), notes: row.notes == null ? null : String(row.notes), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

export async function getUserId() {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  if (data.session?.user?.id) return data.session.user.id
  const { data: signInData, error } = await supabase.auth.signInAnonymously()
  if (error) throw error
  return signInData.user?.id ?? null
}

export async function syncProfile(name: string, timezone: string) {
  if (!supabase) return
  const userId = await getUserId()
  if (!userId) return
  const { error } = await supabase.from('profiles').upsert({ id: userId, display_name: name, timezone, onboarding_complete: true, updated_at: new Date().toISOString() })
  if (error) throw error
}

export async function getRemoteProfile() {
  if (!supabase) return null
  const userId = await getUserId()
  if (!userId) return null
  const { data, error } = await supabase.from('profiles').select('id,display_name,timezone,onboarding_complete').eq('id', userId).maybeSingle()
  if (error) throw error
  return data
}

async function flushOutbox(userId: string) {
  if (!supabase) return
  const pending = await db.outbox.orderBy('id').toArray()
  for (const item of pending) {
    try {
      if (item.entity === 'task') {
        if (item.operation === 'upsert' && item.payload) {
          const { error } = await supabase.from('tasks').upsert(toDbTask(item.payload as Task, userId), { onConflict: 'id' })
          if (error) throw error
        } else if (item.operation === 'delete') {
          const { error } = await supabase.from('tasks').delete().eq('id', item.recordId).eq('user_id', userId)
          if (error) throw error
        }
      } else if (item.entity === 'shopping') {
        if (item.operation === 'upsert' && item.payload) {
          const { error } = await supabase.from('shopping_items').upsert(toDbShopping(item.payload as ShoppingItem, userId), { onConflict: 'id' })
          if (error) throw error
        } else if (item.operation === 'delete') {
          const { error } = await supabase.from('shopping_items').delete().eq('id', item.recordId).eq('user_id', userId)
          if (error) throw error
        }
      } else {
        if (item.operation === 'upsert' && item.payload) {
          const { error } = await supabase.from('purchases').upsert(toDbPurchase(item.payload as Purchase, userId), { onConflict: 'id' })
          if (error) throw error
        } else if (item.operation === 'delete') {
          const { error } = await supabase.from('purchases').delete().eq('id', item.recordId).eq('user_id', userId)
          if (error) throw error
        }
      }
      if (item.id !== undefined) await db.outbox.delete(item.id)
    } catch {
      break
    }
  }
}

async function pendingDeletes(entity: 'task' | 'shopping' | 'purchase') {
  return new Set<string>((await db.outbox.where('entity').equals(entity).and(item => item.operation === 'delete').toArray()).map(item => item.recordId))
}

async function mergeTasks(remote: Task[], local: Task[], deleted: Set<string>) {
  const remoteById = new Map(remote.map(r => [r.id, r]))
  for (const r of remote) {
    if (deleted.has(r.id)) continue
    const l = local.find(item => item.id === r.id)
    if (!l || r.updatedAt >= l.updatedAt) await db.tasks.put(r)
    else await db.outbox.add({ entity: 'task', operation: 'upsert', recordId: l.id, payload: l, createdAt: new Date().toISOString() })
  }
  for (const l of local) {
    if (!remoteById.has(l.id) && !deleted.has(l.id)) await db.outbox.add({ entity: 'task', operation: 'upsert', recordId: l.id, payload: l, createdAt: new Date().toISOString() })
  }
}

async function mergeShopping(remote: ShoppingItem[], local: ShoppingItem[], deleted: Set<string>) {
  const remoteById = new Map(remote.map(r => [r.id, r]))
  for (const r of remote) {
    if (deleted.has(r.id)) continue
    const l = local.find(item => item.id === r.id)
    if (!l || r.updatedAt >= l.updatedAt) await db.shopping.put(r)
    else await db.outbox.add({ entity: 'shopping', operation: 'upsert', recordId: l.id, payload: l, createdAt: new Date().toISOString() })
  }
  for (const l of local) {
    if (!remoteById.has(l.id) && !deleted.has(l.id)) await db.outbox.add({ entity: 'shopping', operation: 'upsert', recordId: l.id, payload: l, createdAt: new Date().toISOString() })
  }
}

async function mergePurchases(remote: Purchase[], local: Purchase[], deleted: Set<string>) {
  const remoteById = new Map(remote.map(r => [r.id, r]))
  for (const r of remote) {
    if (deleted.has(r.id)) continue
    const l = local.find(item => item.id === r.id)
    if (!l || r.updatedAt >= l.updatedAt) await db.purchases.put(r)
    else await db.outbox.add({ entity: 'purchase', operation: 'upsert', recordId: l.id, payload: l, createdAt: new Date().toISOString() })
  }
  for (const l of local) {
    if (!remoteById.has(l.id) && !deleted.has(l.id)) await db.outbox.add({ entity: 'purchase', operation: 'upsert', recordId: l.id, payload: l, createdAt: new Date().toISOString() })
  }
}

export async function syncAll() {
  const localOnly = { tasks: await db.tasks.toArray(), shoppingItems: await db.shopping.toArray(), purchases: await db.purchases.toArray() }
  if (!supabase) return localOnly

  const userId = await getUserId()
  if (!userId) return localOnly
  await flushOutbox(userId)

  const [taskRes, shoppingRes, purchaseRes] = await Promise.all([
    supabase.from('tasks').select('id,title,is_completed,due_date,due_time,reminder_enabled,reminder_minutes_before,reminder_at,reminder_sent_at,created_at,updated_at').eq('user_id', userId).is('deleted_at', null),
    supabase.from('shopping_items').select('id,name,quantity,unit,expected_price,is_purchased,created_at,updated_at').eq('user_id', userId).is('deleted_at', null),
    supabase.from('purchases').select('id,item_name,quantity,unit,price,currency,purchased_at,notes,created_at,updated_at').eq('user_id', userId).is('deleted_at', null)
  ])
  if (taskRes.error) throw taskRes.error
  if (shoppingRes.error) throw shoppingRes.error
  if (purchaseRes.error) throw purchaseRes.error

  const remoteTasks = (taskRes.data ?? []).map(row => fromDbTask(row as Record<string, unknown>))
  const remoteShopping = (shoppingRes.data ?? []).map(row => fromDbShopping(row as Record<string, unknown>))
  const remotePurchases = (purchaseRes.data ?? []).map(row => fromDbPurchase(row as Record<string, unknown>))
  const localTasks = await db.tasks.toArray()
  const localShopping = await db.shopping.toArray()
  const localPurchases = await db.purchases.toArray()

  await mergeTasks(remoteTasks, localTasks, await pendingDeletes('task'))
  await mergeShopping(remoteShopping, localShopping, await pendingDeletes('shopping'))
  await mergePurchases(remotePurchases, localPurchases, await pendingDeletes('purchase'))
  await flushOutbox(userId)

  return { tasks: await db.tasks.toArray(), shoppingItems: await db.shopping.toArray(), purchases: await db.purchases.toArray() }
}

export async function syncTasks() {
  return (await syncAll()).tasks
}

import { db } from './db'
import { supabase } from './supabase'
import { requestCaptchaToken, getCaptchaError, clearCaptchaError } from './components/TurnstileWidget'
import { decideMerge, isPurgeableTombstone, shouldPushOrphan, visible, type Tombstoned } from './tombstones'
import { MAX_RETRIES, classifyOutboxError, nextRetryState, shouldSkipItem, suppressesRemoteCopy } from './outbox'
import type { OutboxItem } from './db'
import type { Purchase, ShoppingItem, Task, ThemeId } from './types'

export { visible } from './tombstones'
export { MAX_RETRIES } from './outbox'

let pendingSignInPromise: Promise<string | null> | null = null
let onlineHandlerInstalled = false
const SIGN_IN_TIMEOUT_MS = 15_000

/**
 * Bounds the anonymous sign-in network call.
 *
 * This timer starts only AFTER the CAPTCHA request has already settled, so it is
 * sequential with the CAPTCHA lifecycle timer rather than nested inside it. Two
 * sequential timers cannot preempt each other; two nested equal-length ones always
 * did, which is what turned every auth failure into a generic stage timeout.
 */
function withSignInTimeout(work: PromiseLike<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Anonymous sign-in timed out after ${SIGN_IN_TIMEOUT_MS / 1000}s.`))
    }, SIGN_IN_TIMEOUT_MS)
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Drops local tombstones past the retention window. */
export async function purgeLocalTombstones(now: number = Date.now()) {
  const stale = <T extends Tombstoned>(rows: T[]) => rows.filter(r => isPurgeableTombstone(r, now)).map(r => r.id)
  await db.tasks.bulkDelete(stale(await db.tasks.toArray()))
  await db.shopping.bulkDelete(stale(await db.shopping.toArray()))
  await db.purchases.bulkDelete(stale(await db.purchases.toArray()))
}

if (typeof window !== 'undefined' && !onlineHandlerInstalled) {
  onlineHandlerInstalled = true
  window.addEventListener('online', () => {
    pendingSignInPromise = null
  })
}

function toDbTask(task: Task, userId: string) {
  return { id: task.id, user_id: userId, title: task.title, is_completed: task.isCompleted, due_date: task.dueDate ?? null, due_time: task.dueTime ?? null, reminder_enabled: task.reminderEnabled ?? true, reminder_minutes_before: task.reminderMinutesBefore ?? 1440, reminder_at: task.reminderAt ?? null, reminder_sent_at: task.reminderSentAt ?? null, created_at: task.createdAt, updated_at: task.updatedAt, deleted_at: task.deletedAt ?? null }
}
function fromDbTask(row: Record<string, unknown>): Task {
  return { id: String(row.id), title: String(row.title), isCompleted: Boolean(row.is_completed), dueDate: row.due_date ? String(row.due_date) : null, dueTime: row.due_time ? String(row.due_time).slice(0, 5) : null, reminderEnabled: row.reminder_enabled !== false, reminderMinutesBefore: row.reminder_minutes_before == null ? 1440 : Number(row.reminder_minutes_before), reminderAt: row.reminder_at ? String(row.reminder_at) : null, reminderSentAt: row.reminder_sent_at ? String(row.reminder_sent_at) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null }
}
function toDbShopping(item: ShoppingItem, userId: string) {
  return { id: item.id, user_id: userId, name: item.name, quantity: item.quantity ?? null, unit: item.unit ?? null, expected_price: item.expectedPrice ?? null, is_purchased: item.isPurchased, created_at: item.createdAt, updated_at: item.updatedAt, deleted_at: item.deletedAt ?? null }
}
function fromDbShopping(row: Record<string, unknown>): ShoppingItem {
  return { id: String(row.id), name: String(row.name), quantity: row.quantity == null ? null : Number(row.quantity), unit: row.unit ? String(row.unit) : null, expectedPrice: row.expected_price == null ? null : Number(row.expected_price), isPurchased: Boolean(row.is_purchased), createdAt: String(row.created_at), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null }
}
function toDbPurchase(item: Purchase, userId: string) {
  return { id: item.id, user_id: userId, item_name: item.itemName, quantity: item.quantity ?? null, unit: item.unit ?? null, price: item.price ?? null, currency: item.currency, purchased_at: item.purchasedAt, notes: item.notes ?? null, created_at: item.createdAt, updated_at: item.updatedAt, deleted_at: item.deletedAt ?? null }
}
function fromDbPurchase(row: Record<string, unknown>): Purchase {
  return { id: String(row.id), itemName: String(row.item_name), quantity: row.quantity == null ? null : Number(row.quantity), unit: row.unit ? String(row.unit) : null, price: row.price == null ? null : Number(row.price), currency: String(row.currency ?? 'PHP') as 'PHP', purchasedAt: String(row.purchased_at), notes: row.notes == null ? null : String(row.notes), createdAt: String(row.created_at), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null }
}

/**
 * Captcha lifecycle of the anonymous sign-in path. Diagnostic only: no token,
 * user id, credential or key is ever included, so this is safe to leave enabled.
 */
function trace(event: string, detail?: string): void {
  console.warn(`[push] stage=auth ${event}${detail ? ` (${detail})` : ''}`)
}

export async function getUserId() {
  if (!supabase) return null
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.user?.id) return session.user.id
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null
  if (pendingSignInPromise) {
    trace('get-user join-in-flight')
    return pendingSignInPromise
  }
  pendingSignInPromise = performAnonymousSignIn()
  try {
    return await pendingSignInPromise
  } finally {
    // Cleared on failure too. Clearing it only on the success path would leave a
    // rejected promise cached, and every later retry would re-await the same
    // dead one instead of starting a fresh sign-in.
    pendingSignInPromise = null
  }
}

async function performAnonymousSignIn(): Promise<string | null> {
  const sb = supabase
  if (!sb) return null
  try {
    trace('captcha start')
    const token = await requestCaptchaToken()
    trace('captcha ok')
    if (!token || !token.trim()) {
      trace('failed', 'empty captcha token')
      return null
    }
    trace('anonymous-sign-in start')
    const result = await withSignInTimeout(sb.auth.signInAnonymously({ options: { captchaToken: token } })) as {
      data: { user?: { id?: string } | null } | null
      error: { name: string; message: string } | null
    }
    const { data, error } = result
    if (error) {
      // Supabase's own reason, preserved rather than swallowed.
      trace('anonymous-sign-in failed', `${error.name}: ${error.message}`)
      throw error
    }
    // Anonymous sign-in can succeed at the transport level and still hand back no
    // user, so data is read defensively rather than assumed non-null.
    const userId = data?.user?.id ?? null
    trace(userId ? 'anonymous-sign-in ok' : 'anonymous-sign-in returned no user')
    clearCaptchaError()
    return userId
  } catch (error) {
    pendingSignInPromise = null
    throw error
  }
}

export function getSignInError(): Error | null {
  return getCaptchaError()
}

export async function syncProfile(name: string, timezone: string, theme: ThemeId = 'cat') {
  if (!supabase) return
  const userId = await getUserId()
  if (!userId) return
  const { error } = await supabase.from('profiles').upsert({ id: userId, display_name: name, timezone, onboarding_complete: true, theme, updated_at: new Date().toISOString() })
  if (error) throw error
}

export async function getRemoteProfile() {
  if (!supabase) return null
  const userId = await getUserId()
  if (!userId) return null
  const { data, error } = await supabase.from('profiles').select('id,display_name,timezone,onboarding_complete,theme').eq('id', userId).maybeSingle()
  if (error) throw error
  return data
}

/** Performs one queued write against Supabase. Throws on a rejected or failed request. */
async function applyOutboxItem(item: OutboxItem, userId: string) {
  // Deletes are soft: we stamp deleted_at instead of removing the row, so other
  // devices learn about the delete and purge their own copy. A hard delete
  // would be indistinguishable from "never existed" and would let any offline
  // copy resurrect the record. The set_updated_at trigger refreshes updated_at.
  if (item.entity === 'task') {
    if (item.operation === 'upsert' && item.payload) {
      const { error } = await supabase!.from('tasks').upsert(toDbTask(item.payload as Task, userId), { onConflict: 'id' })
      if (error) throw error
    } else if (item.operation === 'delete') {
      const { error } = await supabase!.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', item.recordId).eq('user_id', userId)
      if (error) throw error
    }
  } else if (item.entity === 'shopping') {
    if (item.operation === 'upsert' && item.payload) {
      const { error } = await supabase!.from('shopping_items').upsert(toDbShopping(item.payload as ShoppingItem, userId), { onConflict: 'id' })
      if (error) throw error
    } else if (item.operation === 'delete') {
      const { error } = await supabase!.from('shopping_items').update({ deleted_at: new Date().toISOString() }).eq('id', item.recordId).eq('user_id', userId)
      if (error) throw error
    }
  } else {
    if (item.operation === 'upsert' && item.payload) {
      const { error } = await supabase!.from('purchases').upsert(toDbPurchase(item.payload as Purchase, userId), { onConflict: 'id' })
      if (error) throw error
    } else if (item.operation === 'delete') {
      const { error } = await supabase!.from('purchases').update({ deleted_at: new Date().toISOString() }).eq('id', item.recordId).eq('user_id', userId)
      if (error) throw error
    }
  }
}

/**
 * Drains the outbox in insertion order.
 *
 * A failed item no longer aborts the queue: it is charged (only for genuine
 * server rejections) and passed over, so one bad record cannot block a delete
 * tombstone queued behind it. Previously a single failure hit `break` and
 * silently stalled every later item.
 */
async function flushOutbox(userId: string) {
  if (!supabase) return
  // Offline is not a record-level failure, so nothing is charged and the queue
  // is left untouched for the next online pass.
  if (typeof navigator !== 'undefined' && !navigator.onLine) return
  const online = typeof navigator === 'undefined' ? true : navigator.onLine

  const pending = await db.outbox.orderBy('id').toArray()
  for (const item of pending) {
    // Already flagged: stop attempting it, but keep it queued so the user can
    // retry or discard it explicitly. Nothing is lost.
    if (shouldSkipItem(item)) continue
    try {
      await applyOutboxItem(item, userId)
      if (item.id !== undefined) await db.outbox.delete(item.id)
    } catch (error) {
      const failure = classifyOutboxError(error, online)
      const next = nextRetryState(item, failure)
      if (next && item.id !== undefined) {
        await db.outbox.update(item.id, {
          retryCount: next.retryCount,
          flagged: next.flagged,
          lastError: error instanceof Error ? error.message : String(error),
        })
      }
      // Transient and offline failures leave retryCount untouched; the next
      // flush retries them for free.
    }
  }
}

/** Queued writes the server has refused MAX_RETRIES times, for the UI to show. */
export async function getFlaggedOutboxItems(): Promise<OutboxItem[]> {
  const all = await db.outbox.toArray()
  return all.filter(item => item.flagged === true).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function getFlaggedOutboxCount() {
  return (await getFlaggedOutboxItems()).length
}

/** Clears the flag and counter for one item, then re-attempts it immediately. */
export async function retryOutboxItem(id: number) {
  const item = await db.outbox.get(id)
  if (!item) return
  await db.outbox.update(id, { retryCount: 0, flagged: false, lastError: undefined })
  const userId = await getUserId()
  if (!userId || !supabase) return
  try {
    await applyOutboxItem({ ...item, retryCount: 0, flagged: false }, userId)
    await db.outbox.delete(id)
  } catch (error) {
    const online = typeof navigator === 'undefined' ? true : navigator.onLine
    const next = nextRetryState({ retryCount: 0 }, classifyOutboxError(error, online))
    if (next) {
      await db.outbox.update(id, {
        retryCount: next.retryCount,
        flagged: next.flagged,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Drops one flagged item. Only ever called on explicit user action. */
export async function discardOutboxItem(id: number) {
  await db.outbox.delete(id)
}

async function pendingDeletes(entity: 'task' | 'shopping' | 'purchase') {
  const rows = await db.outbox.where('entity').equals(entity).and(item => item.operation === 'delete').toArray()
  // Flagged deletes are excluded: an item that can never succeed would otherwise
  // suppress the remote copy forever, freezing that record in limbo.
  return new Set(rows.filter(suppressesRemoteCopy).map(item => item.recordId))
}

async function mergeTasks(remote: Task[], local: Task[], deleted: Set<string>) {
  const remoteIds = new Set(remote.map(r => r.id))
  for (const r of remote) {
    const localCopy = local.find(item => item.id === r.id)
    const action = decideMerge(r, localCopy, deleted.has(r.id))
    if (action.kind === 'skip') continue
    if (action.kind === 'put-tombstone' || action.kind === 'put-remote') { await db.tasks.put(r); continue }
    if (action.kind === 'queue-delete') { await db.outbox.add({ entity: 'task', operation: 'delete', recordId: r.id, createdAt: new Date().toISOString() }); continue }
    if (localCopy) await db.outbox.add({ entity: 'task', operation: 'upsert', recordId: localCopy.id, payload: localCopy, createdAt: new Date().toISOString() })
  }
  for (const l of local) {
    if (shouldPushOrphan(l, remoteIds, deleted.has(l.id))) await db.outbox.add({ entity: 'task', operation: 'upsert', recordId: l.id, payload: l, createdAt: new Date().toISOString() })
  }
}

async function mergeShopping(remote: ShoppingItem[], local: ShoppingItem[], deleted: Set<string>) {
  const remoteIds = new Set(remote.map(r => r.id))
  for (const r of remote) {
    const localCopy = local.find(item => item.id === r.id)
    const action = decideMerge(r, localCopy, deleted.has(r.id))
    if (action.kind === 'skip') continue
    if (action.kind === 'put-tombstone' || action.kind === 'put-remote') { await db.shopping.put(r); continue }
    if (action.kind === 'queue-delete') { await db.outbox.add({ entity: 'shopping', operation: 'delete', recordId: r.id, createdAt: new Date().toISOString() }); continue }
    if (localCopy) await db.outbox.add({ entity: 'shopping', operation: 'upsert', recordId: localCopy.id, payload: localCopy, createdAt: new Date().toISOString() })
  }
  for (const l of local) {
    if (shouldPushOrphan(l, remoteIds, deleted.has(l.id))) await db.outbox.add({ entity: 'shopping', operation: 'upsert', recordId: l.id, payload: l, createdAt: new Date().toISOString() })
  }
}

async function mergePurchases(remote: Purchase[], local: Purchase[], deleted: Set<string>) {
  const remoteIds = new Set(remote.map(r => r.id))
  for (const r of remote) {
    const localCopy = local.find(item => item.id === r.id)
    const action = decideMerge(r, localCopy, deleted.has(r.id))
    if (action.kind === 'skip') continue
    if (action.kind === 'put-tombstone' || action.kind === 'put-remote') { await db.purchases.put(r); continue }
    if (action.kind === 'queue-delete') { await db.outbox.add({ entity: 'purchase', operation: 'delete', recordId: r.id, createdAt: new Date().toISOString() }); continue }
    if (localCopy) await db.outbox.add({ entity: 'purchase', operation: 'upsert', recordId: localCopy.id, payload: localCopy, createdAt: new Date().toISOString() })
  }
  for (const l of local) {
    if (shouldPushOrphan(l, remoteIds, deleted.has(l.id))) await db.outbox.add({ entity: 'purchase', operation: 'upsert', recordId: l.id, payload: l, createdAt: new Date().toISOString() })
  }
}

export async function syncAll() {
  const localOnly = { tasks: visible(await db.tasks.toArray()), shoppingItems: visible(await db.shopping.toArray()), purchases: visible(await db.purchases.toArray()) }
  if (!supabase) return localOnly

  const userId = await getUserId()
  if (!userId) return localOnly
  await flushOutbox(userId)

  // Tombstones are deliberately NOT filtered out here. Excluding deleted_at
  // null rows makes a delete on one device look like the record never existed,
  // so the other device's merge would treat its local copy as orphaned and
  // re-upload it. We need to see the tombstone to purge instead.
  const [taskRes, shoppingRes, purchaseRes] = await Promise.all([
    supabase.from('tasks').select('id,title,is_completed,due_date,due_time,reminder_enabled,reminder_minutes_before,reminder_at,reminder_sent_at,created_at,updated_at,deleted_at').eq('user_id', userId),
    supabase.from('shopping_items').select('id,name,quantity,unit,expected_price,is_purchased,created_at,updated_at,deleted_at').eq('user_id', userId),
    supabase.from('purchases').select('id,item_name,quantity,unit,price,currency,purchased_at,notes,created_at,updated_at,deleted_at').eq('user_id', userId)
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
  await purgeLocalTombstones()

  return { tasks: visible(await db.tasks.toArray()), shoppingItems: visible(await db.shopping.toArray()), purchases: visible(await db.purchases.toArray()) }
}

export async function syncTasks() {
  return (await syncAll()).tasks
}

import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'node:crypto'

export const runtime = 'nodejs'
export const maxDuration = 60

type DueTask = {
  id: string
  user_id: string
  title: string
  due_date: string
  due_time: string | null
  reminder_at: string
}

type PushSub = { id: string; endpoint: string; p256dh: string; auth: string }
type DueDebt = { id: string; user_id: string; direction: 'owe' | 'owed_to_me'; person_name: string; due_date: string; reminder_at: string; payments: Array<{ amountCents?: number }> ; original_amount_cents: number }

/**
 * Constant-time secret comparison.
 *
 * timingSafeEqual throws when the buffers differ in length, so the length is
 * checked first and treated as a mismatch. Length is not secret (it is visible
 * over the wire), and without the length check an attacker could otherwise
 * probe it one byte at a time by watching whether the call returned.
 */
function secretMatches(provided: string, expected: string): boolean {
  try {
    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function logStage(stage: string, outcome: 'ok' | 'failed' | 'start', detail?: string) {
  const d = detail ? ` (${detail})` : ''
  console.warn(`[reminders] stage=${stage} ${outcome}${d}`)
}

export async function POST(req: Request) {
  const start = Date.now()
  try {
    logStage('request', 'start')
    if (req.method !== 'POST') {
      logStage('request', 'failed', 'method_not_allowed')
      return Response.json({ error: 'Method not allowed.' }, { status: 405 })
    }
    logStage('request', 'ok')

    logStage('auth', 'start')
    const reminderSecret = process.env.REMINDER_CRON_SECRET
    const supabaseCronSecret = process.env.SUPABASE_CRON_SECRET
    if (reminderSecret || supabaseCronSecret) {
      const reminderProvided = req.headers.get('x-cron-secret') || ''
      const supabaseProvided = req.headers.get('x-supabase-cron-secret') || ''
      const ok =
        (!!reminderSecret && secretMatches(reminderProvided, reminderSecret)) ||
        (!!supabaseCronSecret && secretMatches(supabaseProvided, supabaseCronSecret))
      if (!ok) {
        logStage('auth', 'failed', 'secret_mismatch')
        return Response.json({ error: 'Unauthorized.' }, { status: 401 })
      }
    }
    logStage('auth', 'ok')

    logStage('config', 'start')
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
    const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY
    const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY
    const subject = process.env.WEB_PUSH_SUBJECT || 'mailto:tandaan@example.com'
    if (!supabaseUrl || !serviceKey || !publicKey || !privateKey) {
      logStage('config', 'failed', 'missing_vars')
      return Response.json({ error: 'Reminder service is not configured.' }, { status: 503 })
    }
    logStage('config', 'ok')

    logStage('vapid', 'start')
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey)
    } catch (vapidErr) {
      console.error('[reminders] vapid full error', vapidErr)
      const err = vapidErr as Error
      logStage('vapid', 'failed', `${err.name}:${err.message.slice(0, 80)}`)
      return Response.json({ error: 'Reminder service configuration error.' }, { status: 500 })
    }
    logStage('vapid', 'ok')

    logStage('supabase', 'start')
    let admin: ReturnType<typeof createClient>
    try {
      admin = createClient(supabaseUrl, serviceKey, {
        global: {
          fetch: (input, init) => {
            const controller = new AbortController()
            const t = setTimeout(() => controller.abort(), 8000)
            return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(t))
          }
        }
      })
    } catch (sbErr) {
      console.error('[reminders] supabase full error', sbErr)
      const err = sbErr as Error
      logStage('supabase', 'failed', `${err.name}:${err.message.slice(0, 80)}`)
      return Response.json({ error: 'Reminder service error.' }, { status: 500 })
    }
    logStage('supabase', 'ok')

    const now = new Date().toISOString()
    let tasks: DueTask[] = []
    let debts: DueDebt[] = []
    let taskQueryFailed = false
    let debtQueryFailed = false

    logStage('query_tasks', 'start')
    try {
      const { data, error } = await (async () => {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 8000)
        try {
          return await admin
            .from('tasks')
            .select('id,user_id,title,due_date,due_time,reminder_at')
            .eq('is_completed', false)
            .eq('reminder_enabled', true)
            .is('deleted_at', null)
            .is('reminder_sent_at', null)
            .not('reminder_at', 'is', null)
            .lte('reminder_at', now)
            .order('reminder_at', { ascending: true })
            .limit(50)
            .abortSignal(controller.signal as any)
        } finally {
          clearTimeout(t)
        }
      })()
      if (error) {
        console.error('[reminders] query_tasks full error', error)
        logStage('query_tasks', 'failed', error.code ?? 'unknown')
        taskQueryFailed = true
      } else {
        tasks = (data ?? []) as DueTask[]
        logStage('query_tasks', 'ok')
      }
    } catch (error) {
      console.error('[reminders] query_tasks full error', error)
      const err = error as Error
      logStage('query_tasks', 'failed', `${err.name}:${err.message.slice(0, 80)}`)
      taskQueryFailed = true
    }

    logStage('query_debts', 'start')
    try {
      const { data, error } = await admin
        .from('debts')
        .select('id,user_id,direction,person_name,due_date,reminder_at,payments,original_amount_cents')
        .eq('reminder_enabled', true)
        .is('deleted_at', null)
        .is('reminder_sent_at', null)
        .not('reminder_at', 'is', null)
        .lte('reminder_at', now)
        .order('reminder_at', { ascending: true })
        .limit(50)
      if (error) {
        console.error('[reminders] query_debts full error', error)
        logStage('query_debts', 'failed', error.code ?? 'unknown')
        debtQueryFailed = true
      } else {
        debts = (data ?? []) as DueDebt[]
        logStage('query_debts', 'ok')
      }
    } catch (error) {
      console.error('[reminders] query_debts full error', error)
      const err = error as Error
      logStage('query_debts', 'failed', `${err.name}:${err.message.slice(0, 80)}`)
      debtQueryFailed = true
    }

  let sent = 0
  let removed = 0
  for (const task of (tasks ?? []) as DueTask[]) {
    try {
      logStage('query_subs', 'start')
      const { data: subs, error: subError } = await (async () => {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 8000)
        try {
          return await admin
            .from('push_subscriptions')
            .select('id,endpoint,p256dh,auth')
            .eq('user_id', task.user_id)
            .abortSignal(controller.signal as any)
        } finally {
          clearTimeout(t)
        }
      })().catch((e) => {
        const err = e as Error
        logStage('query_subs', 'failed', `${err.name}:${err.message.slice(0, 60)}`)
        return { data: null, error: { code: 'query_timeout', message: err.message } as any }
      })
      if (subError) {
        logStage('query_subs', 'failed', (subError as any).code ?? 'unknown')
        continue
      }
      logStage('query_subs', 'ok')

      if ((subs?.length ?? 0) === 0) {
        logStage('task_process', 'skipped', 'no_subscription')
        continue
      }

      const payload = JSON.stringify({
        title: 'Tandaan reminder',
        body: task.due_time ? `${task.title} · due ${task.due_date} at ${task.due_time}` : `${task.title} · due ${task.due_date}`,
        url: '/',
        tag: `task-${task.id}`
      })

      let delivered = false
      for (const sub of (subs ?? []) as PushSub[]) {
        try {
          const pushStart = Date.now()
          logStage('push_send', 'start')
          await Promise.race([
            webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 86400, urgency: 'high' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('push_timeout')), 5000))
          ])
          sent += 1
          delivered = true
          logStage('push_send', 'ok', `ms=${Date.now() - pushStart}`)
        } catch (error: any) {
          const msg = error?.message || ''
          const status = error?.statusCode
          if (status === 404 || status === 410 || msg === 'push_timeout') {
            try {
              await admin.from('push_subscriptions').delete().eq('id', sub.id)
              removed += 1
            } catch {
              // ignore cleanup failure
            }
          }
          logStage('push_send', 'failed', status ? `status=${status}` : 'error')
        }
      }

      if (delivered) {
        try {
          logStage('task_update', 'start')
          const controller = new AbortController()
          const t = setTimeout(() => controller.abort(), 8000)
          await admin
            .from('tasks')
            .update({ reminder_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', task.id)
            .abortSignal(controller.signal as any)
          clearTimeout(t)
          logStage('task_update', 'ok')
        } catch (updErr) {
          const err = updErr as Error
          logStage('task_update', 'failed', `${err.name}:${err.message.slice(0, 60)}`)
        }
      }
    } catch (taskErr) {
      console.error('[reminders] task_process full error', taskErr)
      const err = taskErr as Error
      logStage('task_process', 'failed', `${err.name}:${err.message.slice(0, 80)}`)
    }
  }

  for (const debt of (debts ?? []) as DueDebt[]) {
    try {
      const { data: subs } = await admin.from('push_subscriptions').select('id,endpoint,p256dh,auth').eq('user_id', debt.user_id)
      const paid = (debt.payments ?? []).reduce((sum, p) => sum + Math.max(0, Number(p.amountCents) || 0), 0)
      const remaining = Math.max(0, Number(debt.original_amount_cents) - paid)
      if (remaining === 0) {
        await admin.from('debts').update({ reminder_sent_at: new Date().toISOString(), reminder_enabled: false, updated_at: new Date().toISOString() }).eq('id', debt.id)
        continue
      }
      const direction = debt.direction === 'owe' ? 'You owe' : 'You are owed'
      const payload = JSON.stringify({
        title: 'Tandaan debt reminder',
        body: `${direction} ₱${(remaining / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })} · ${debt.person_name} · due ${debt.due_date}`,
        url: '/',
        tag: `debt-${debt.id}`
      })
      let delivered = false
      for (const sub of (subs ?? []) as PushSub[]) {
        try {
          await Promise.race([
            webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 86400, urgency: 'high' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('push_timeout')), 5000))
          ])
          sent += 1; delivered = true
        } catch (error: any) {
          const msg = error?.message || ''
          const status = error?.statusCode
          if (status === 404 || status === 410 || msg === 'push_timeout') await admin.from('push_subscriptions').delete().eq('id', sub.id)
        }
      }
      if (delivered) {
        await admin.from('debts').update({ reminder_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', debt.id)
      } else if ((subs?.length ?? 0) === 0) {
        logStage('debt_process', 'skipped', 'no_subscription')
      }
    } catch (error) {
      console.error('[reminders] debt_process full error', error)
      logStage('debt_process', 'failed', error instanceof Error ? error.message.slice(0, 80) : 'error')
    }
  }

  logStage('response', 'ok', `ms=${Date.now() - start}`)
  return Response.json({
    ok: true,
    checked: tasks.length,
    sent,
    removed,
    partial: taskQueryFailed || debtQueryFailed,
    taskQueryFailed,
    debtQueryFailed,
  })
  } catch (e) {
    console.error('[reminders] unexpected full error', e)
    const err = e as Error
    logStage('unexpected', 'failed', `${err.name}:${err.message.slice(0, 100)}`)
    return Response.json({ error: 'Reminder service error.' }, { status: 500 })
  }
}

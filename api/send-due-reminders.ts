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

/**
 * Constant-time secret comparison.
 *
 * timingSafeEqual throws when the buffers differ in length, so the length is
 * checked first and treated as a mismatch. Length is not secret (it is visible
 * over the wire), and without the length check an attacker could otherwise
 * probe it one byte at a time by watching whether the call returned.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export default async function handler(req: Request) {
  try {
    if (req.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 })

    // Two independent secrets so schedulers can be rotated and revoked one at a
    // time. REMINDER_CRON_SECRET (x-cron-secret) is the original path and keeps
    // working unchanged; SUPABASE_CRON_SECRET (x-supabase-cron-secret) is for
    // Supabase Cron, which cannot send custom headers on every plan. Either
    // secret is accepted when both are set. If neither is configured the endpoint
    // stays open, preserving the previous behaviour.
    //
    // Neither value is logged or echoed; failures return one generic 401.
    const reminderSecret = process.env.REMINDER_CRON_SECRET
    const supabaseCronSecret = process.env.SUPABASE_CRON_SECRET
    if (reminderSecret || supabaseCronSecret) {
      const reminderProvided = req.headers.get('x-cron-secret') || ''
      const supabaseProvided = req.headers.get('x-supabase-cron-secret') || ''
      const ok =
        (!!reminderSecret && secretMatches(reminderProvided, reminderSecret)) ||
        (!!supabaseCronSecret && secretMatches(supabaseProvided, supabaseCronSecret))
      if (!ok) {
        console.warn('[reminders] auth failed: secret mismatch')
        return Response.json({ error: 'Unauthorized.' }, { status: 401 })
      }
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
    const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY
    const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY
    const subject = process.env.WEB_PUSH_SUBJECT || 'mailto:tandaan@example.com'
    if (!supabaseUrl || !serviceKey || !publicKey || !privateKey) {
      console.warn('[reminders] config incomplete: missing required env vars')
      return Response.json({ error: 'Reminder service is not configured.' }, { status: 503 })
    }

    try {
      webpush.setVapidDetails(subject, publicKey, privateKey)
    } catch (vapidErr) {
      const err = vapidErr as Error
      console.warn(`[reminders] vapid init failed: ${err.name}`)
      return Response.json({ error: 'Reminder service configuration error.' }, { status: 500 })
    }
    const admin = createClient(supabaseUrl, serviceKey)

    const now = new Date().toISOString()
    const { data: tasks, error: taskError } = await admin
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

    if (taskError) {
      console.warn(`[reminders] task query failed: ${taskError.code ?? 'unknown'}`)
      return Response.json({ error: 'Reminder processing failed.' }, { status: 500 })
    }

  let sent = 0
  let removed = 0
  for (const task of (tasks ?? []) as DueTask[]) {
    try {
      const { data: subs, error: subError } = await admin
        .from('push_subscriptions')
        .select('id,endpoint,p256dh,auth')
        .eq('user_id', task.user_id)

      if (subError) continue

      const payload = JSON.stringify({
        title: 'Tandaan reminder',
        body: task.due_time ? `${task.title} · due ${task.due_date} at ${task.due_time}` : `${task.title} · due ${task.due_date}`,
        url: '/',
        tag: `task-${task.id}`
      })

      let delivered = false
      for (const sub of (subs ?? []) as PushSub[]) {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 86400, urgency: 'high' })
          sent += 1
          delivered = true
        } catch (error: any) {
          if (error?.statusCode === 404 || error?.statusCode === 410) {
            try {
              await admin.from('push_subscriptions').delete().eq('id', sub.id)
              removed += 1
            } catch {
              // ignore cleanup failure
            }
          }
          // other errors are logged minimally without exposing details
        }
      }

      if ((subs?.length ?? 0) === 0 || delivered) {
        try {
          await admin.from('tasks').update({ reminder_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', task.id)
        } catch (updErr) {
          const err = updErr as Error
          console.warn(`[reminders] task update failed: ${err.name}`)
        }
      }
    } catch (taskErr) {
      const err = taskErr as Error
      console.warn(`[reminders] task processing failed: ${err.name}`)
    }
  }

  return Response.json({ ok: true, checked: tasks?.length ?? 0, sent, removed })
  } catch (e) {
    const err = e as Error
    console.warn(`[reminders] unexpected error: ${err.name}`)
    return Response.json({ error: 'Reminder service error.' }, { status: 500 })
  }
}

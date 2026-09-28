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

export default async function handler(req: Request) {
  if (req.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 })
  const cronSecret = process.env.REMINDER_CRON_SECRET
  if (cronSecret) {
    const provided = req.headers.get('x-cron-secret') || ''
    if (provided.length !== cronSecret.length) return Response.json({ error: 'Unauthorized.' }, { status: 401 })
    if (!timingSafeEqual(Buffer.from(cronSecret), Buffer.from(provided))) return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY
  const subject = process.env.WEB_PUSH_SUBJECT || 'mailto:tandaan@example.com'
  if (!supabaseUrl || !serviceKey || !publicKey || !privateKey) {
    return Response.json({ error: 'Reminder service is not configured.' }, { status: 503 })
  }

  webpush.setVapidDetails(subject, publicKey, privateKey)
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

  if (taskError) return Response.json({ error: 'Reminder processing failed.' }, { status: 500 })

  let sent = 0
  let removed = 0
  for (const task of (tasks ?? []) as DueTask[]) {
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
          await admin.from('push_subscriptions').delete().eq('id', sub.id)
          removed += 1
        }
      }
    }

    // Mark the task as processed after at least one delivery attempt or when the task has no devices.
    if ((subs?.length ?? 0) === 0 || delivered) {
      await admin.from('tasks').update({ reminder_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', task.id)
    }
  }

  return Response.json({ ok: true, checked: tasks?.length ?? 0, sent, removed })
}

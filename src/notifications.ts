import { supabase } from './supabase'
import { getUserId } from './sync'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)))
}

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export async function getPushSubscription() {
  if (!pushSupported()) return null
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

export async function enablePushNotifications() {
  if (!supabase) throw new Error('Supabase is not configured.')
  if (!pushSupported()) throw new Error('Phone notifications are not supported in this browser/PWA.')

  const vapid = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  if (!vapid) throw new Error('VITE_VAPID_PUBLIC_KEY is not configured yet.')

  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') throw new Error('Notification permission was not granted.')

  const userId = await getUserId()
  if (!userId) throw new Error('No signed-in Tandaan user.')

  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid)
    })
  }

  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser returned an incomplete push subscription.')

  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: userId,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,endpoint' })
  if (error) throw error
  return subscription
}

export async function disablePushNotifications() {
  if (!pushSupported()) throw new Error('Phone notifications are not supported in this browser/PWA.')

  // The browser subscription can outlive a revoked permission, so always ask
  // the push manager rather than trusting Notification.permission.
  const subscription = await getPushSubscription()
  if (subscription && !(await subscription.unsubscribe())) {
    throw new Error('The browser refused to remove the push subscription.')
  }

  // The reminder cron reads push_subscriptions, so the stored row has to go as
  // well or it keeps targeting an endpoint this device no longer accepts. Only
  // this device's endpoint is removed, leaving any second device subscribed.
  // Cleanup is best effort: with no Supabase client there is nothing to notify
  // anyway, and blocking the user here would leave reminders visibly on.
  //
  // The delete is conditional on a current endpoint on purpose. Without one
  // there is nothing of this device's to remove, and it must never widen to
  // user_id alone, which would strip every other device on the same account.
  const endpoint = subscription?.toJSON().endpoint
  if (supabase && endpoint) {
    const userId = await getUserId()
    if (userId) {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('endpoint', endpoint)

      if (error) throw error
    }
  }
  return true
}

import { supabase } from './supabase'
import { getUserId } from './sync'

/**
 * Push activation can stall at any await in the chain, and a stalled await never
 * rejects, which left the Settings toggle spinning on "..." forever. Every step
 * below is therefore wrapped in withTimeout() so the promise always settles and
 * the caller can clear its busy state.
 */
const STEP_TIMEOUT_MS = 15_000

/**
 * Where activation failed. The UI maps this to a readable message instead of
 * showing a raw browser error, and the console line makes it obvious which of
 * the six checkpoints stopped.
 */
export type PushStage =
  | 'config'
  | 'environment'
  | 'application-server-key'
  | 'permission'
  | 'auth'
  | 'service-worker'
  | 'subscription'
  | 'register'

export class PushStageError extends Error {
  readonly stage: PushStage
  constructor(stage: PushStage, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PushStageError'
    this.stage = stage
  }
}

/**
 * Terse and free of identifiers: the endpoint and subscription keys must never reach the log.
 *
 * `outcome` is a free-form stage token so one line can carry both progress
 * markers ('start', 'existing-session', 'get-user', 'session-verify') and the
 * terminal ones ('ok', 'failed').
 */
function diagnose(stage: PushStage, outcome: string, detail?: unknown) {
  const reason = detail instanceof Error ? `${detail.name}: ${detail.message}` : detail === undefined ? '' : String(detail)
  console.warn(`[push] stage=${stage} ${outcome}${reason ? ` (${reason})` : ''}`)
}

function withTimeout<T>(stage: PushStage, work: PromiseLike<T>, ms = STEP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PushStageError(stage, `Timed out after ${ms / 1000}s waiting for ${stage}.`))
    }, ms)
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)))
}

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/**
 * Explains an auth failure using the reason that actually caused it.
 *
 * sync.ts rethrows Supabase's own error rather than swallowing it, so the real
 * message is kept instead of being flattened into "could not sign you in".
 */
function authFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message) return `Tandaan could not sign you in on this device: ${message}`
  return 'Tandaan could not sign you in on this device.'
}

/**
 * Reads the current session without ever attempting to create one.
 * Returns null when there is no session, and never starts a sign-in.
 */
async function existingSessionUserId(): Promise<string | null> {
  const sb = supabase
  if (!sb) return null
  const { data } = await sb.auth.getSession()
  return data?.session?.user?.id ?? null
}

/**
 * Resolves the user id for registration, preferring an existing session.
 *
 * An already-authenticated device must not be pushed back through anonymous
 * sign-in, which is a needless round trip and the step that was failing.
 * Only when no session exists is the existing Tandaan auth path used, once, and
 * the session is then verified rather than trusted.
 */
async function resolveUserId(): Promise<string> {
  const sb = supabase
  if (!sb) throw new PushStageError('config', 'Supabase is not configured.')

  diagnose('auth', 'start')

  try {
    const existing = await existingSessionUserId()
    diagnose('auth', 'existing-session', existing ? 'found' : 'none')
    if (existing) {
      diagnose('auth', 'ok', 'existing session')
      return existing
    }
  } catch (error) {
    diagnose('auth', 'failed', error)
    throw new PushStageError('auth', authFailureMessage(error), { cause: error })
  }

  // One pass through the existing path in sync.ts, which performs anonymous
  // sign-in. It rethrows its own error, so that error is the real reason and is
  // carried through rather than replaced.
  //
  // Deliberately NOT wrapped in withTimeout(). This call owns the auth timeout
  // itself, via withSignInTimeout() inside sync.ts. An equally long stage timer
  // here would compete with it on the outside and always preempted it, replacing
  // the specific reason with a generic "Timed out after 15s waiting for auth".
  // Two competing 15s timers on one stage is what made the failure unreadable.
  let userId: string | null = null
  try {
    diagnose('auth', 'get-user')
    userId = await getUserId()
  } catch (error) {
    diagnose('auth', 'failed', error)
    throw new PushStageError('auth', authFailureMessage(error), { cause: error })
  }

  // Verify rather than trust: confirm a session really exists now.
  try {
    diagnose('auth', 'session-verify')
    const verified = await existingSessionUserId()
    if (verified) {
      diagnose('auth', 'ok', 'anonymous session')
      return verified
    }
    if (userId) {
      diagnose('auth', 'ok', 'user id from auth path')
      return userId
    }
  } catch (error) {
    diagnose('auth', 'failed', error)
    throw new PushStageError('auth', authFailureMessage(error), { cause: error })
  }

  diagnose('auth', 'failed', 'no session after sign-in')
  throw new PushStageError('auth', authFailureMessage(null))
}

export async function getPushSubscription() {
  if (!pushSupported()) return null
  const registration = await withTimeout('service-worker', navigator.serviceWorker.ready)
  return registration.pushManager.getSubscription()
}

export async function enablePushNotifications() {
  if (!supabase) throw new PushStageError('config', 'Supabase is not configured.')

  // iOS reports a Home Screen web app as supported, so this only fires for
  // browsers that genuinely cannot do push. App.tsx re-checks the display mode
  // first, because a plain Safari tab lands here too.
  if (!pushSupported()) throw new PushStageError('environment', 'Phone notifications are not supported in this browser/PWA.')

  const vapid = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  if (!vapid) throw new PushStageError('application-server-key', 'VITE_VAPID_PUBLIC_KEY is not configured yet.')

  let permission: NotificationPermission
  try {
    permission = await withTimeout('permission', Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission))
  } catch (error) {
    diagnose('permission', 'failed', error)
    throw error instanceof PushStageError ? error : new PushStageError('permission', 'Notification permission was not granted.', { cause: error })
  }
  if (permission !== 'granted') {
    diagnose('permission', 'failed', `result=${permission}`)
    throw new PushStageError('permission', 'Notification permission was not granted.')
  }
  diagnose('permission', 'ok', 'granted')

  // getUserId() can reach the anonymous sign-in path, which is a network call that
  // is not guaranteed to resolve. Bounded there so a failed sign-in shows an
  // error instead of pinning the toggle in its busy state.
  const userId = await resolveUserId()

  let registration: ServiceWorkerRegistration
  try {
    registration = await withTimeout('service-worker', navigator.serviceWorker.ready)
  } catch (error) {
    diagnose('service-worker', 'failed', error)
    throw error instanceof PushStageError ? error : new PushStageError('service-worker', 'The Tandaan service worker did not become ready.', { cause: error })
  }
  diagnose('service-worker', 'ok')

  let subscription: PushSubscription | null
  try {
    subscription = await withTimeout('subscription', registration.pushManager.getSubscription())
    if (!subscription) {
      // A malformed application server key surfaces here rather than at
      // configuration time, so the stage stays 'application-server-key'.
      subscription = await withTimeout('subscription', registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      }))
    }
  } catch (error) {
    const stage: PushStage = /applicationServerKey|application server key|VAPID/i.test(error instanceof Error ? error.message : '') ? 'application-server-key' : 'subscription'
    diagnose(stage, 'failed', error)
    throw error instanceof PushStageError ? error : new PushStageError(stage, 'Could not create the phone notification subscription.', { cause: error })
  }

  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    diagnose('subscription', 'failed', 'incomplete subscription')
    throw new PushStageError('subscription', 'The browser returned an incomplete push subscription.')
  }
  diagnose('subscription', 'ok')

  const { error } = await withTimeout('register', supabase.from('push_subscriptions').upsert({
    user_id: userId,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,endpoint' }))
  if (error) {
    diagnose('register', 'failed', error)
    throw new PushStageError('register', 'Could not register this phone for reminders.', { cause: error })
  }
  diagnose('register', 'ok')
  return subscription
}

export async function disablePushNotifications() {
  if (!pushSupported()) throw new PushStageError('environment', 'Phone notifications are not supported in this browser/PWA.')

  // The browser subscription can outlive a revoked permission, so always ask
  // the push manager rather than trusting Notification.permission.
  const subscription = await getPushSubscription()
  if (subscription && !(await subscription.unsubscribe())) {
    throw new PushStageError('subscription', 'The browser refused to remove the push subscription.')
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
    // Session only: turning reminders off must never start a fresh sign-in, and
    // without a session there is no row of ours to delete.
    const userId = await existingSessionUserId().catch(() => null)
    if (userId) {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('endpoint', endpoint)

      if (error) throw new PushStageError('register', 'Could not remove this phone from the reminder list.', { cause: error })
    }
  }
  return true
}

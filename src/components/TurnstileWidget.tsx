import { useEffect, useRef } from 'react'
import { Turnstile } from '@marsidev/react-turnstile'

const TOKEN_MAX_AGE_MS = 4 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15000
const RENDER_RETRY_LIMIT = 30
const RENDER_RETRY_DELAY_MS = 100

/** Whether a challenge can actually be produced right now, and why not. */
type WidgetState = 'idle' | 'loading' | 'ready' | 'failed'

let lastToken: string | null = null
let tokenIssuedAt = 0
let pendingResolve: ((token: string) => void) | null = null
let pendingReject: ((reason: any) => void) | null = null
let tokenPromise: Promise<string> | null = null
let captchaError: Error | null = null
let requestActive = false
let retryTimeout: ReturnType<typeof setTimeout> | null = null
let renderRetryTimer: ReturnType<typeof setTimeout> | null = null

let turnstileRefInstance: any = null
let widgetState: WidgetState = 'idle'
let lastRenderError: string | null = null

/**
 * Captcha lifecycle only. No token, site key or subscription value is ever
 * included, so this is safe to leave enabled.
 */
function trace(event: string, detail?: string): void {
  console.warn(`[push] stage=auth captcha ${event}${detail ? ` (${detail})` : ''}`)
}

function clearPending(): void {
  pendingResolve = null
  pendingReject = null
}

/**
 * Settles the in-flight request exactly once.
 *
 * The resolver and rejector are read BEFORE the pending state is cleared,
 * because clearing them first is what used to strand the promise: the old
 * rejectCurrent() nulled pendingReject without ever calling it, so the awaiter
 * in getUserId() waited out its own timeout and every later request received
 * the same deadlocked promise from the `if (tokenPromise)` check.
 *
 * Clearing tokenPromise here is what makes the next call start a fresh request
 * instead of re-serving a promise that can no longer settle.
 */
function settlePending(outcome: 'resolve' | 'reject', value: string | Error): void {
  const resolve = pendingResolve
  const reject = pendingReject
  clearPending()
  tokenPromise = null
  requestActive = false
  if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null }
  if (outcome === 'resolve') resolve?.(value as string)
  else reject?.(value as Error)
}

function rejectCurrent(reason: Error): void {
  captchaError = reason
  trace('failed', reason.message)
  settlePending('reject', reason)
}

/**
 * Ensures a challenge can actually be produced before anyone waits on one.
 *
 * This is the fix for the silent 15s hang: previously a request arriving before
 * the widget was ready (or after the render retries had been exhausted) took the
 * `if (widgetRendered)` false branch, skipped reset(), and then sat on its timer
 * waiting for a challenge that nothing would ever present. Now the render is
 * (re)armed here, so a late request never depends on the mount effect having
 * already succeeded, and a new request after a failure gets a fresh challenge.
 *
 * Returns true only when a challenge can be triggered immediately.
 */
/**
 * Readiness read through a call so the compiler does not narrow widgetState at
 * the assignment above and then reject the comparison after tryRender() has had
 * its chance to flip it to 'ready' from onWidgetLoad.
 */
function widgetIsReady(): boolean {
  return widgetState === 'ready'
}

function ensureWidgetReady(): boolean {
  if (widgetIsReady()) return true
  if (widgetState === 'failed') trace('re-arming after previous render failure', lastRenderError ?? undefined)
  stopRenderRetries()
  lastRenderError = null
  widgetState = 'loading'
  tryRender(1)
  return widgetIsReady()
}

export async function requestCaptchaToken(): Promise<string> {
  // A request is already in flight: join it rather than starting a second one,
  // which would reset the widget out from under the first awaiter.
  if (tokenPromise) {
    trace('join-in-flight')
    return tokenPromise
  }

  if (lastToken && Date.now() - tokenIssuedAt < TOKEN_MAX_AGE_MS) {
    const token = lastToken
    lastToken = null
    tokenIssuedAt = 0
    trace('reuse-cached-token')
    return token
  }

  // An error left behind by a previous attempt must not leak into this one.
  captchaError = null
  requestActive = true

  tokenPromise = new Promise<string>((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject
  })

  lastToken = null
  tokenIssuedAt = 0

  const ready = ensureWidgetReady()
  if (ready) {
    trace('challenge-start')
    turnstileRefInstance?.reset()
  } else {
    // No challenge yet, but one is now scheduled: when the widget finishes
    // loading it renders and runs a challenge on its own, and onSuccess below
    // settles this request. The timer stays running to bound the wait.
    trace('waiting-for-widget', lastRenderError ?? 'initialising')
  }

  // The single authoritative timer for this request. It bounds BOTH waiting for
  // the widget to initialise and waiting for the challenge to be solved. The
  // notifications.ts stage layer used to start an equally long timer *earlier*,
  // so it always preempted this one and replaced the real reason with a generic
  // "timed out waiting for auth".
  retryTimeout = setTimeout(() => {
    if (!requestActive) return
    if (widgetState !== 'ready') {
      rejectCurrent(new Error(
        `CAPTCHA could not start: the Turnstile widget is not ready (${lastRenderError ?? 'still initialising'}). ` +
        'Check that VITE_TURNSTILE_SITE_KEY is set and that challenges.cloudflare.com is reachable.',
      ))
      return
    }
    rejectCurrent(new Error('CAPTCHA verification timed out. Please reload the page and try again.'))
  }, REQUEST_TIMEOUT_MS)

  return tokenPromise
}

export function resetCaptchaState(): void {
  // A reset abandons whatever was in flight, so that request has to reject
  // rather than be silently dropped. No caller awaits it today, but leaving it
  // unsettled is the exact failure this module is meant to avoid.
  if (pendingReject) {
    rejectCurrent(new Error('CAPTCHA verification was cancelled. Please try again.'))
    return
  }
  requestActive = false
  tokenPromise = null
  clearPending()
  lastToken = null
  tokenIssuedAt = 0
  if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null }
}

export function getCaptchaError(): Error | null {
  return captchaError
}

export function clearCaptchaError(): void {
  captchaError = null
}

function stopRenderRetries(): void {
  if (renderRetryTimer) { clearTimeout(renderRetryTimer); renderRetryTimer = null }
}

// onLoadScript fires when the script tag enters the DOM, not when the script has
// executed, so render() can run before window.turnstile exists. Retry on a timer
// until the widget reports back; onWidgetLoad fires synchronously inside
// render(), so widgetState is 'ready' the moment render() returns.
//
// Giving up after the retry budget only marks the widget 'failed'. It does NOT
// disable CAPTCHA permanently: ensureWidgetReady() re-arms the render on the
// next request, which is what lets a retry actually recover.
function tryRender(attempt: number): void {
  if (widgetIsReady()) return
  if (attempt > RENDER_RETRY_LIMIT) {
    widgetState = 'failed'
    lastRenderError = lastRenderError ?? 'the Turnstile script did not initialise'
    trace('widget-not-ready', lastRenderError)
    return
  }
  try {
    turnstileRefInstance?.render()
  } catch (error) {
    lastRenderError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  // onWidgetLoad fires synchronously inside render(), so re-read rather than
  // trusting the narrowing from before the call.
  if (widgetIsReady()) return
  renderRetryTimer = setTimeout(() => tryRender(attempt + 1), RENDER_RETRY_DELAY_MS)
}

export function TurnstileWidget() {
  const turnstileRef = useRef<any>(null)

  useEffect(() => {
    turnstileRefInstance = turnstileRef.current
    // onLoadScript only fires while the script tag is being added, so a widget that
    // mounts after the script is already loaded would otherwise never render and
    // sit un-ready until some request happened to re-arm it. The guards keep this
    // from racing onLoadScript or restarting retries that are already running.
    if (widgetState === 'idle' && !renderRetryTimer) ensureWidgetReady()
    return () => {
      stopRenderRetries()
      turnstileRefInstance = null
      // A remount must be able to initialise again, so this goes back to 'idle'
      // and lets the next request re-arm rather than inheriting a dead widget.
      widgetState = 'idle'
      lastRenderError = null
      // Never strand an in-flight request on unmount.
      if (pendingReject) rejectCurrent(new Error('CAPTCHA verification was cancelled. Please try again.'))
    }
  }, [])

  return (
    <Turnstile
      siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY || ''}
      ref={turnstileRef}
      options={{ execution: 'render', appearance: 'interaction-only' }}
      onLoadScript={() => {
        ensureWidgetReady()
      }}
      onWidgetLoad={() => {
        widgetState = 'ready'
        lastRenderError = null
        trace('widget-ready')
      }}
      onSuccess={(token: string) => {
        if (!token || !token.trim()) return
        tokenIssuedAt = Date.now()
        if (!requestActive) {
          // Token arrived with nobody waiting: keep it for the next request,
          // still inside the reuse window.
          lastToken = token
          return
        }
        lastToken = null
        trace('challenge-ok')
        settlePending('resolve', token)
      }}
      onExpire={() => {
        lastToken = null
        tokenIssuedAt = 0
        trace('challenge-expired')
      }}
      onError={() => {
        if (requestActive) rejectCurrent(new Error('CAPTCHA verification failed. Please reload the page and try again.'))
        else trace('widget-error-with-no-request-waiting')
      }}
    />
  )
}

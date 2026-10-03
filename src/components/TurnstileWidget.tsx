import { useEffect, useRef } from 'react'

const TOKEN_MAX_AGE_MS = 4 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15000

/**
 * Explicit-render build of Cloudflare's api.js.
 *
 * There is deliberately NO `?onload=` parameter and NO `defer`/`async`: the
 * previous tag was `<script defer async src="...api.js?onload=onloadTurnstileCallback&render=explicit">`,
 * which handed readiness to a global callback that is deleted again as soon as
 * it fires. In production that callback was already gone by the time anything
 * asked for it, so the widget never reached a rendered state and no challenge
 * iframe was ever created. This tag owns its own `load` event instead, and
 * `turnstile.render()` is called directly. `turnstile.ready()` is never used,
 * because Cloudflare rejects it outright on a deferred script tag.
 */
const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

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

let widgetState: WidgetState = 'idle'
let lastRenderError: string | null = null

/** The container element passed to turnstile.render(); null until React mounts it. */
let containerInstance: HTMLElement | null = null
/** The id turnstile.render() returned, needed by reset() and remove(). */
let widgetId: string | null = null
/** Resolves once api.js has actually executed, rejects if it cannot be loaded. */
let scriptPromise: Promise<void> | null = null

/**
 * Captcha lifecycle only. No token, site key or subscription value is ever
 * included, so this is safe to leave enabled.
 */
function trace(event: string, detail?: string): void {
  console.warn(`[push] stage=auth captcha ${event}${detail ? ` (${detail})` : ''}`)
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
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
 * Returns window.turnstile only once it is genuinely usable, so a half-installed
 * global can never be mistaken for a working renderer.
 */
function turnstileApi(): any {
  const api = typeof window === 'undefined' ? null : (window as any).turnstile
  return api && typeof api.render === 'function' ? api : null
}

/**
 * Injects api.js at most once and resolves on the tag's own `load` event, which
 * is the moment the global is guaranteed to exist.
 */
function loadTurnstileScript(): Promise<void> {
  const existing = turnstileApi()
  if (existing) return Promise.resolve()
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT_SRC
    // No `async`/`defer` attributes: a script inserted this way is already async
    // by default, and the `load` event below is what readiness is read from.
    script.onload = () => {
      if (turnstileApi()) resolve()
      else {
        scriptPromise = null
        reject(new Error('api.js loaded but window.turnstile.render is still unavailable'))
      }
    }
    script.onerror = () => {
      scriptPromise = null
      reject(new Error('could not load challenges.cloudflare.com/turnstile/v0/api.js'))
    }
    document.head.appendChild(script)
  })

  return scriptPromise
}

/**
 * Renders the widget exactly once, and only when both preconditions hold: the
 * container is mounted and the API is loaded. No polling and no retry counter is
 * needed, because those only existed to compensate for a script tag that
 * reported readiness through a global callback instead of an event.
 */
function renderWidgetOnce(): void {
  if (widgetId !== null) return
  if (!containerInstance) return
  const api = turnstileApi()
  if (!api) return

  try {
    const id = api.render(containerInstance, {
      sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY || '',
      execution: 'render',
      appearance: 'interaction-only',
      callback: onToken,
      'error-callback': onWidgetError,
      'expired-callback': onTokenExpired,
      // Turnstile retries on its own after this fires, so it is a diagnostic
      // only. The request timeout below stays the authority on waiting.
      'timeout-callback': () => trace('challenge-timeout'),
    })
    if (id === undefined || id === null || id === '') {
      widgetState = 'failed'
      lastRenderError = 'turnstile.render() did not return a widget id'
      trace('widget-not-ready', lastRenderError)
      return
    }
    widgetId = id
    widgetState = 'ready'
    lastRenderError = null
    trace('widget-ready')
  } catch (error) {
    widgetState = 'failed'
    lastRenderError = describe(error)
    trace('widget-not-ready', lastRenderError)
  }
}

function resetWidget(): void {
  const api = turnstileApi()
  if (!api || widgetId === null || typeof api.reset !== 'function') return
  try {
    api.reset(widgetId)
  } catch (error) {
    trace('reset-failed', describe(error))
  }
}

/**
 * Readiness read through a call so the compiler does not narrow widgetState at
 * the assignment below and then reject the comparison after renderWidgetOnce()
 * has had its chance to flip it to 'ready'.
 */
function widgetIsReady(): boolean {
  return widgetState === 'ready'
}

/**
 * Ensures a challenge can actually be produced before anyone waits on one.
 *
 * This is the fix for the silent 15s hang: a request arriving before the widget
 * was ready used to skip reset() and then sit on its timer waiting for a
 * challenge that nothing would ever present. Now the render is (re)armed here,
 * so a late request never depends on the mount effect having already succeeded,
 * and a new request after a failure gets a fresh attempt.
 *
 * Returns true only when a challenge can be triggered immediately.
 */
function ensureWidgetReady(): boolean {
  if (widgetIsReady()) return true
  if (widgetState === 'failed') trace('re-arming after previous render failure', lastRenderError ?? undefined)
  lastRenderError = null
  widgetState = 'loading'

  if (turnstileApi()) {
    // The script is already loaded, so the render can happen synchronously.
    renderWidgetOnce()
  } else {
    loadTurnstileScript().then(() => {
      if (widgetState === 'ready') return
      renderWidgetOnce()
    }).catch((error) => {
      if (widgetState === 'ready') return
      widgetState = 'failed'
      lastRenderError = describe(error)
      trace('widget-not-ready', lastRenderError)
    })
  }

  return widgetIsReady()
}

function onToken(token: string): void {
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
}

function onWidgetError(): void {
  if (requestActive) rejectCurrent(new Error('CAPTCHA verification failed. Please reload the page and try again.'))
  else trace('widget-error-with-no-request-waiting')
}

function onTokenExpired(): void {
  lastToken = null
  tokenIssuedAt = 0
  trace('challenge-expired')
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
    resetWidget()
  } else {
    // No challenge yet, but one is now scheduled: once the script's load event
    // fires the widget renders, and the callback above settles this request.
    // The timer stays running to bound the wait.
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

export function TurnstileWidget() {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    containerInstance = containerRef.current
    // Arm the render as soon as the container exists, so the widget is ready
    // before the first request instead of being created on demand.
    ensureWidgetReady()

    return () => {
      const api = turnstileApi()
      if (api && widgetId !== null && typeof api.remove === 'function') {
        try { api.remove(widgetId) } catch { /* the container is going away anyway */ }
      }
      widgetId = null
      containerInstance = null
      // A remount must be able to initialise again, so this goes back to 'idle'
      // and lets the next request re-arm rather than inheriting a dead widget.
      widgetState = 'idle'
      lastRenderError = null
      // Never strand an in-flight request on unmount.
      if (pendingReject) rejectCurrent(new Error('CAPTCHA verification was cancelled. Please try again.'))
    }
  }, [])

  return <div ref={containerRef} className="turnstile-host" />
}

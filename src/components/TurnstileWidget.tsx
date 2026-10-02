import { useEffect, useRef } from 'react'
import { Turnstile } from '@marsidev/react-turnstile'

const TOKEN_MAX_AGE_MS = 4 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15000
const RENDER_RETRY_LIMIT = 30
const RENDER_RETRY_DELAY_MS = 100

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
let widgetRendered = false

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
  settlePending('reject', reason)
}

export async function requestCaptchaToken(): Promise<string> {
  if (tokenPromise) return tokenPromise

  if (lastToken && Date.now() - tokenIssuedAt < TOKEN_MAX_AGE_MS) {
    const token = lastToken
    lastToken = null
    tokenIssuedAt = 0
    return token
  }

  captchaError = null
  requestActive = true

  tokenPromise = new Promise<string>((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject
  })

  lastToken = null
  tokenIssuedAt = 0
  if (widgetRendered) turnstileRefInstance?.reset()

  retryTimeout = setTimeout(() => {
    if (!requestActive) return
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

// onLoadScript fires when the script tag enters the DOM, not when the script has
// executed, so render() can run before window.turnstile exists. Retry on a timer
// until the widget reports back; onWidgetLoad fires synchronously inside
// render(), so widgetRendered is accurate the moment render() returns.
function tryRender(attempt: number): void {
  if (widgetRendered) return
  if (attempt > RENDER_RETRY_LIMIT) return
  turnstileRefInstance?.render()
  if (widgetRendered) return
  renderRetryTimer = setTimeout(() => tryRender(attempt + 1), RENDER_RETRY_DELAY_MS)
}

export function TurnstileWidget() {
  const turnstileRef = useRef<any>(null)

  useEffect(() => {
    turnstileRefInstance = turnstileRef.current
    return () => {
      if (renderRetryTimer) { clearTimeout(renderRetryTimer); renderRetryTimer = null }
      turnstileRefInstance = null
      widgetRendered = false
    }
  }, [])

  return (
    <Turnstile
      siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY || ''}
      ref={turnstileRef}
      options={{ execution: 'render', appearance: 'interaction-only' }}
      onLoadScript={() => {
        if (widgetRendered) return
        tryRender(1)
      }}
      onWidgetLoad={() => {
        widgetRendered = true
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
        settlePending('resolve', token)
      }}
      onExpire={() => {
        lastToken = null
        tokenIssuedAt = 0
      }}
      onError={() => {
        if (requestActive) rejectCurrent(new Error('CAPTCHA verification failed. Please reload the page and try again.'))
      }}
    />
  )
}

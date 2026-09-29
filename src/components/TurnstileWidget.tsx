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

function rejectCurrent(reason: Error): void {
  clearPending()
  requestActive = false
  if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null }
  captchaError = reason
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

// === TEMP DIAGNOSTIC — remove all lines tagged [tdiag] before commit ===
let mountCount = 0
let lastAttempt = 0
function tdiag(...args: any[]) { console.log('[tdiag]', ...args) }
// === end TEMP DIAGNOSTIC ===

function tryRender(attempt: number): void {
  if (widgetRendered) { tdiag(`tryRender(${attempt}) STOP reason=widgetRendered`); return }
  if (attempt > RENDER_RETRY_LIMIT) { tdiag(`tryRender STOP reason=budget-exhausted at attempt=${attempt}`); return }
  lastAttempt = attempt
  turnstileRefInstance?.render()
  tdiag(`tryRender(${attempt}) called widgetRendered=${widgetRendered} ref=${turnstileRefInstance ? 'set' : 'NULL'}`)
  if (widgetRendered) { tdiag(`tryRender(${attempt}) STOP reason=widget-loaded`); return }
  renderRetryTimer = setTimeout(() => tryRender(attempt + 1), RENDER_RETRY_DELAY_MS)
}

export function TurnstileWidget() {
  const turnstileRef = useRef<any>(null)

  useEffect(() => {
    mountCount += 1
    tdiag(`MOUNT #${mountCount} ref=${turnstileRef.current ? 'set' : 'NULL'} siteKey=${import.meta.env.VITE_TURNSTILE_SITE_KEY ? 'SET' : 'EMPTY'} mountCount=${mountCount}`)
    turnstileRefInstance = turnstileRef.current
    return () => {
      tdiag(`UNMOUNT #${mountCount} pendingRetry=${renderRetryTimer ? 'YES' : 'no'} lastAttemptAt=${lastAttempt}`)
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
        tdiag(`onLoadScript FIRED widgetRendered=${widgetRendered} mountCount=${mountCount}`)
        if (widgetRendered) return
        tryRender(1)
      }}
      onWidgetLoad={() => {
        tdiag(`onWidgetLoad FIRED mountCount=${mountCount} lastAttempt=${lastAttempt}`)
        widgetRendered = true
      }}
      onSuccess={(token: string) => {
        tdiag(`onSuccess FIRED hasToken=${!!token?.trim()} requestActive=${requestActive} mountCount=${mountCount}`)
        if (!token || !token.trim()) return
        tokenIssuedAt = Date.now()
        if (!requestActive) {
          lastToken = token
          return
        }
        lastToken = null
        if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null }
        requestActive = false
        const resolve = pendingResolve
        tokenPromise = null
        clearPending()
        resolve?.(token)
      }}
      onExpire={() => {
        lastToken = null
        tokenIssuedAt = 0
      }}
      onError={() => {
        tdiag(`onError FIRED requestActive=${requestActive} mountCount=${mountCount}`)
        if (requestActive) rejectCurrent(new Error('CAPTCHA verification failed. Please reload the page and try again.'))
      }}
    />
  )
}

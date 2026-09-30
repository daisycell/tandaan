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
        if (requestActive) rejectCurrent(new Error('CAPTCHA verification failed. Please reload the page and try again.'))
      }}
    />
  )
}

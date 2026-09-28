import { useEffect, useRef, useState } from 'react'
import { Turnstile } from '@marsidev/react-turnstile'

let pendingResolve: ((token: string) => void) | null = null
let pendingReject: ((reason: any) => void) | null = null
let tokenPromise: Promise<string> | null = null
let isVerifying = false
let hasRetried = false
let captchaError: Error | null = null
let widgetReady = false
let executionRequested = false
let retryTimeout: ReturnType<typeof setTimeout> | null = null

function resetPending(): void {
  pendingResolve = null
  pendingReject = null
}

function rejectCurrent(reason: Error): void {
  resetPending()
  isVerifying = false
  hasRetried = false
  executionRequested = false
  if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null }
  captchaError = reason
}

export async function requestCaptchaToken(): Promise<string> {
  if (tokenPromise) return tokenPromise

  isVerifying = true
  hasRetried = false
  captchaError = null
  executionRequested = true

  tokenPromise = new Promise<string>((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject
  })

  if (widgetReady) {
    executeWidget()
  }

  retryTimeout = setTimeout(() => {
    if (!isVerifying) return
    if (!hasRetried) {
      hasRetried = true
      executionRequested = true
      resetPending()
      tokenPromise = new Promise<string>((resolve, reject) => {
        pendingResolve = resolve
        pendingReject = reject
      })
      if (widgetReady) {
        executeWidget()
      }
    } else {
      rejectCurrent(new Error('CAPTCHA verification timed out. Please try again.'))
    }
  }, 15000)

  return tokenPromise
}

let turnstileRefInstance: any = null

function executeWidget(): void {
  try {
    turnstileRefInstance?.execute()
  } catch {
    // Widget execute failed — will retry on timeout
  }
}

export function resetCaptchaState(): void {
  isVerifying = false
  tokenPromise = null
  resetPending()
  hasRetried = false
  executionRequested = false
  if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null }
}

export function getCaptchaError(): Error | null {
  return captchaError
}

export function clearCaptchaError(): void {
  captchaError = null
}

export function TurnstileWidget() {
  const turnstileRef = useRef<any>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    turnstileRefInstance = turnstileRef.current
    widgetReady = true
    setTick(t => t + 1)
    if (executionRequested) {
      executionRequested = false
      turnstileRef.current?.execute()
    }
  }, [])

  return (
    <Turnstile
      siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY || ''}
      ref={turnstileRef}
      options={{ execution: 'execute', appearance: 'interaction-only' }}
      onSuccess={(token: string) => {
        if (!token || !token.trim()) return
        resetCaptchaState()
        turnstileRef.current?.reset()
        pendingResolve?.(token)
      }}
      onExpire={() => {
        resetCaptchaState()
      }}
      onError={() => {
        if (hasRetried && isVerifying) {
          rejectCurrent(new Error('CAPTCHA verification failed. Please try again.'))
        }
      }}
    />
  )
}

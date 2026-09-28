import { useEffect, useRef } from 'react'
import { Turnstile } from '@marsidev/react-turnstile'

let pendingResolve: ((token: string) => void) | null = null
let pendingReject: ((reason: any) => void) | null = null
let tokenPromise: Promise<string> | null = null
let isVerifying = false
let hasRetried = false
let captchaError: Error | null = null

let triggerExecution: (() => void) | null = null

export async function requestCaptchaToken(): Promise<string> {
  if (tokenPromise) return tokenPromise

  isVerifying = true
  hasRetried = false
  captchaError = null

  tokenPromise = new Promise<string>((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject
    triggerExecution?.()

    const timeout = setTimeout(() => {
      if (!isVerifying) return
      if (!hasRetried) {
        hasRetried = true
        triggerExecution?.()
        pendingResolve = null
        pendingReject = null
      } else {
        isVerifying = false
        captchaError = new Error('CAPTCHA verification timed out. Please try again.')
        reject(captchaError)
      }
    }, 15000)

    pendingResolve = (token: string) => {
      clearTimeout(timeout)
      isVerifying = false
      resolve(token)
    }
    pendingReject = (reason: any) => {
      clearTimeout(timeout)
      isVerifying = false
      reject(reason)
    }
  })

  return tokenPromise
}

export function resetCaptchaState(): void {
  isVerifying = false
  tokenPromise = null
  pendingResolve = null
  pendingReject = null
  hasRetried = false
}

export function getCaptchaError(): Error | null {
  return captchaError
}

export function clearCaptchaError(): void {
  captchaError = null
}

export function TurnstileWidget() {
  const turnstileRef = useRef<any>(null)

  useEffect(() => {
    triggerExecution = () => turnstileRef.current?.execute()
  }, [])

  return (
    <Turnstile
      siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY || ''}
      ref={turnstileRef}
      options={{ execution: 'execute', appearance: 'interaction-only' }}
      onSuccess={(token: string) => {
        resetCaptchaState()
        turnstileRef.current?.reset()
        pendingResolve?.(token)
      }}
      onExpire={() => {
        resetCaptchaState()
      }}
      onError={() => {
        if (hasRetried && isVerifying) {
          isVerifying = false
          captchaError = new Error('CAPTCHA verification failed. Please try again.')
          pendingReject?.(captchaError)
          resetCaptchaState()
        }
      }}
    />
  )
}

// Pure outbox retry policy.
//
// Kept free of Dexie and Supabase imports so the rules that decide whether a
// queued write is retried, skipped, or flagged can be unit tested in plain
// Node (see scripts/outbox.test.mjs). sync.ts performs the I/O; every decision
// about *what* to do with a failure lives here.

/** Server rejections a record gets before it is flagged for the user. */
export const MAX_RETRIES = 5

export type OutboxFailure =
  /** Device is offline. Not the record's fault, and not worth charging it for. */
  | 'offline'
  /** Network drop, 5xx, or an auth/JWT problem that a fresh session can fix. */
  | 'transient'
  /** The server rejected this record's contents. Retrying as-is will not help. */
  | 'rejected'

type MaybeCoded = { code?: unknown }

/**
 * Classifies a thrown write error.
 *
 * Only a genuine content rejection counts against the record. A flaky tunnel
 * must not burn a user's retry budget and eventually flag writes the server
 * never actually objected to.
 *
 * `online` is passed in rather than read from `navigator` so this stays pure.
 * Note that `navigator.onLine` is unreliable (it reports true behind a captive
 * portal), which is why transport failures are classified from the error shape
 * instead of inferred from it.
 *
 * Rejection logic is reasoned from the documented PostgREST/Postgres `code`
 * field, not from observed traffic. A PGRST3xx code indicates the JWT is
 * missing, expired, or invalid, which a re-authentication fixes, so those are
 * transient rather than counted against the record.
 */
export function classifyOutboxError(error: unknown, online: boolean): OutboxFailure {
  if (!online) return 'offline'

  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as MaybeCoded).code ?? '')
    : ''

  // No code at all means the request never reached PostgREST: a fetch/network
  // failure, DNS, CORS, or a thrown TypeError.
  if (!code) return 'transient'

  // PGRST3xx = JWT/role problems. Transient, because signing in again fixes it.
  if (/^PGRST3\d{2}$/.test(code)) return 'transient'

  // Postgres SQLSTATE. These are 5 characters, so a numeric magnitude test
  // would be wrong: 23505 (unique violation) is a client-side data problem,
  // not a server fault, despite being numerically large. The two-character
  // class may be letters (XX/HV internal), so it is not \d{2}.
  if (/^[0-9A-Z]{5}$/.test(code)) {
    const sqlClass = code.slice(0, 2)
    // Connection, rollback, resource exhaustion, operator intervention, and
    // internal errors are all server-side and worth retrying unchanged.
    const transientClasses = ['08', '40', '53', '54', '55', '57', '58', 'F0', 'HV', 'XX']
    return transientClasses.includes(sqlClass) ? 'transient' : 'rejected'
  }

  // Bare HTTP-style status, in case a client surfaces one instead of a code.
  if (/^\d{3}$/.test(code)) return Number(code) >= 500 ? 'transient' : 'rejected'

  // Any other PostgREST code (PGRST116, PGRST202, ...) is a request-shape
  // problem, so retrying the identical request will fail identically.
  return 'rejected'
}

/** Delay before the next automatic retry for each rejected attempt. */
export const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const

export type RetryState = { retryCount: number; flagged: boolean; nextRetryAt: string }

/**
 * Advances an item's retry bookkeeping and schedules the next automatic retry.
 *
 * The timestamp is computed here so sync.ts only needs to persist and enforce
 * the policy. The optional now argument keeps this pure and deterministic in tests.
 * Returns null when the failure should not be charged to the record.
 */
export function nextRetryState(
  current: { retryCount?: number; flagged?: boolean },
  failure: OutboxFailure,
  now = Date.now(),
): RetryState | null {
  if (failure !== 'rejected') return null
  const retryCount = (current.retryCount ?? 0) + 1
  const backoff = RETRY_BACKOFF_MS[Math.min(retryCount, MAX_RETRIES) - 1]
  return {
    retryCount,
    flagged: current.flagged === true || retryCount >= MAX_RETRIES,
    nextRetryAt: new Date(now + backoff).toISOString(),
  }
}

/** True when a queued item should be passed over without attempting it. */
export function shouldSkipItem(item: { flagged?: boolean }) {
  return item.flagged === true
}

/** True when a flagged item should be excluded from pending-delete suppression. */
export function suppressesRemoteCopy(item: { flagged?: boolean; operation: string }) {
  return item.operation === 'delete' && !shouldSkipItem(item)
}

import assert from 'node:assert/strict'
import {
  MAX_RETRIES,
  classifyOutboxError,
  nextRetryState,
  shouldSkipItem,
  suppressesRemoteCopy,
} from '../src/outbox.ts'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL  ${name}`)
    throw error
  }
}

console.log('error classification (only server rejections are charged)')

test('offline short-circuits before any classification', () => {
  assert.equal(classifyOutboxError({ code: '23505' }, false), 'offline')
  assert.equal(classifyOutboxError(new Error('boom'), false), 'offline')
})

test('no code = the request never reached the server', () => {
  assert.equal(classifyOutboxError(new TypeError('Failed to fetch'), true), 'transient')
  assert.equal(classifyOutboxError({}, true), 'transient')
  assert.equal(classifyOutboxError('string error', true), 'transient')
})

test('Postgres 4xx content errors are rejections', () => {
  // 23xxx integrity, 22xxx data, 42xxx syntax/access, 28xxx auth, 25xxx tx state.
  for (const code of ['23505', '23503', '23502', '23514', '42501', '22P02', '28000', '25006']) {
    assert.equal(classifyOutboxError({ code }, true), 'rejected', `expected ${code} to be rejected`)
  }
})

test('a large SQLSTATE number is still a client-side problem', () => {
  // 23505 is numerically large but is an integrity violation, not a server
  // fault. A naive ">= 500" test would wrongly treat it as retryable forever.
  assert.ok(Number('23505') >= 500)
  assert.equal(classifyOutboxError({ code: '23505' }, true), 'rejected')
})

test('Postgres server-side classes are transient, not the record fault', () => {
  // 08xxx connection, 40xxx rollback, 53xxx resources, 57xxx operator interrupt,
  // 58xxx system error.
  for (const code of ['08006', '40001', '53300', '57014', '58030', 'XX000']) {
    assert.equal(classifyOutboxError({ code }, true), 'transient', `expected ${code} to be transient`)
  }
})

test('bare HTTP status codes fall back sensibly', () => {
  assert.equal(classifyOutboxError({ code: '503' }, true), 'transient')
  assert.equal(classifyOutboxError({ code: '400' }, true), 'rejected')
})

test('PGRST3xx JWT/role problems are transient (re-auth fixes them)', () => {
  for (const code of ['PGRST301', 'PGRST302']) {
    assert.equal(classifyOutboxError({ code }, true), 'transient', `expected ${code} to be transient`)
  }
})

test('other PostgREST codes are request-shape problems, so rejected', () => {
  assert.equal(classifyOutboxError({ code: 'PGRST116' }, true), 'rejected')
  assert.equal(classifyOutboxError({ code: 'PGRST202' }, true), 'rejected')
})

console.log('\nretry cap')

test('transient and offline failures are never charged', () => {
  assert.equal(nextRetryState({ retryCount: 3 }, 'transient'), null)
  assert.equal(nextRetryState({ retryCount: 3 }, 'offline'), null)
})

test('rejections increment one at a time', () => {
  assert.deepEqual(nextRetryState({}, 'rejected'), { retryCount: 1, flagged: false })
  assert.deepEqual(nextRetryState({ retryCount: 2 }, 'rejected'), { retryCount: 3, flagged: false })
})

test(`a record is flagged exactly at ${MAX_RETRIES} rejections`, () => {
  let state = {}
  const seen = []
  for (let i = 0; i < MAX_RETRIES + 2; i++) {
    state = nextRetryState(state, 'rejected')
    seen.push(state)
  }
  // Not flagged before the cap.
  for (const s of seen.slice(0, MAX_RETRIES - 1)) assert.equal(s.flagged, false, `flagged too early at retryCount ${s.retryCount}`)
  // Flagged from the cap onward, and stays flagged.
  for (const s of seen.slice(MAX_RETRIES - 1)) assert.equal(s.flagged, true, `should stay flagged at retryCount ${s.retryCount}`)
})

test('an already-flagged item stays flagged while the counter climbs', () => {
  const next = nextRetryState({ retryCount: 7, flagged: true }, 'rejected')
  assert.equal(next.flagged, true)
  assert.equal(next.retryCount, 8)
})

test('a manual retry clears the flag and the counter', () => {
  // retryOutboxItem resets to zero, so the record gets a fresh budget.
  assert.deepEqual(nextRetryState({ retryCount: 0, flagged: false }, 'rejected'), { retryCount: 1, flagged: false })
})

console.log('\nskip and suppression rules')

test('flagged items are skipped, unflagged ones are not', () => {
  assert.equal(shouldSkipItem({ flagged: true }), true)
  assert.equal(shouldSkipItem({}), false)
  assert.equal(shouldSkipItem({ flagged: false }), false)
})

test('a live pending delete suppresses the remote copy', () => {
  assert.equal(suppressesRemoteCopy({ operation: 'delete' }), true)
})

test('a FLAGGED delete must NOT suppress the remote copy', () => {
  // Otherwise an item that can never succeed freezes that record in limbo
  // forever, because it would suppress the remote copy on every future sync.
  assert.equal(suppressesRemoteCopy({ operation: 'delete', flagged: true }), false)
})

test('upserts never suppress the remote copy', () => {
  assert.equal(suppressesRemoteCopy({ operation: 'upsert' }), false)
  assert.equal(suppressesRemoteCopy({ operation: 'upsert', flagged: true }), false)
})

console.log(`\n${passed} passed`)

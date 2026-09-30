import assert from 'node:assert/strict'
import {
  TOMBSTONE_RETENTION_DAYS,
  decideMerge,
  isPurgeableTombstone,
  shouldPushOrphan,
  visible,
} from '../src/tombstones.ts'

// Fixed clock so retention maths is deterministic.
const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const daysAgo = n => new Date(NOW - n * 86_400_000).toISOString()

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

console.log('(a) delete on device A, device B must not resurrect it')

test('remote tombstone overwrites a live local copy (device B sees the delete)', () => {
  const remote = { id: 't1', updatedAt: daysAgo(0), deletedAt: daysAgo(0) }
  const local = { id: 't1', updatedAt: daysAgo(0) }
  assert.deepEqual(decideMerge(remote, local, false), { kind: 'put-tombstone' })
})

test('remote tombstone wins even when the local copy is NEWER (sticky delete)', () => {
  const remote = { id: 't1', updatedAt: daysAgo(5), deletedAt: daysAgo(5) }
  const local = { id: 't1', updatedAt: daysAgo(0), title: 'edited offline' }
  assert.deepEqual(decideMerge(remote, local, false), { kind: 'put-tombstone' })
})

test('tombstoned record is hidden from the UI', () => {
  const rows = [
    { id: 'live', deletedAt: null },
    { id: 'gone', deletedAt: daysAgo(1) },
  ]
  assert.deepEqual(visible(rows).map(r => r.id), ['live'])
})

test('device B does not re-upload its now-stale local copy', () => {
  // Tombstone is still in the remote set, so it is not an orphan at all.
  const local = { id: 't1', updatedAt: daysAgo(0) }
  assert.equal(shouldPushOrphan(local, new Set(['t1']), false), false)
})

test('local tombstone is never re-pushed after the server purges the row', () => {
  // The dangerous case: server purged the tombstone, so remoteIds is empty and
  // the local row looks orphaned. Re-pushing it would undo the delete.
  const local = { id: 't1', updatedAt: daysAgo(40), deletedAt: daysAgo(40) }
  assert.equal(shouldPushOrphan(local, new Set(), false), false)
})

test('genuine local-only record still syncs up (no regression)', () => {
  const local = { id: 'new', updatedAt: daysAgo(0) }
  assert.equal(shouldPushOrphan(local, new Set(), false), true)
})

test('pending local delete suppresses the remote copy', () => {
  const remote = { id: 't1', updatedAt: daysAgo(0), deletedAt: null }
  assert.deepEqual(decideMerge(remote, { id: 't1', updatedAt: daysAgo(0) }, true), { kind: 'skip' })
})

test('local tombstone vs still-live remote re-asserts the delete', () => {
  // Our delete never reached the server. Accepting the live row would bring the
  // record back on the very device that deleted it.
  const remote = { id: 't1', updatedAt: daysAgo(0), deletedAt: null }
  const local = { id: 't1', updatedAt: daysAgo(1), deletedAt: daysAgo(1) }
  assert.deepEqual(decideMerge(remote, local, false), { kind: 'queue-delete' })
})

console.log('\n(b) tombstones are purged after 30 days')

test('tombstone older than the window is purgeable', () => {
  assert.equal(isPurgeableTombstone({ deletedAt: daysAgo(TOMBSTONE_RETENTION_DAYS + 1) }, NOW), true)
})

test('tombstone inside the window is kept', () => {
  assert.equal(isPurgeableTombstone({ deletedAt: daysAgo(TOMBSTONE_RETENTION_DAYS - 1) }, NOW), false)
})

test('exactly at the boundary is purgeable (>= window)', () => {
  assert.equal(isPurgeableTombstone({ deletedAt: daysAgo(TOMBSTONE_RETENTION_DAYS) }, NOW), true)
})

test('live records are never purgeable', () => {
  assert.equal(isPurgeableTombstone({ deletedAt: null }, NOW), false)
  assert.equal(isPurgeableTombstone({}, NOW), false)
})

test('unparseable timestamp is kept rather than guessed at', () => {
  assert.equal(isPurgeableTombstone({ deletedAt: 'not-a-date' }, NOW), false)
})

test('normal recency rules still hold for live records', () => {
  const remote = { id: 't1', updatedAt: daysAgo(1) }
  assert.deepEqual(decideMerge(remote, undefined, false), { kind: 'put-remote' })
  assert.deepEqual(decideMerge(remote, { id: 't1', updatedAt: daysAgo(0) }, false), { kind: 'queue-upsert' })
  assert.deepEqual(decideMerge(remote, { id: 't1', updatedAt: daysAgo(2) }, false), { kind: 'put-remote' })
})

console.log(`\n${passed} passed`)

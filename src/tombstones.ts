// Pure tombstone/merge decision logic.
//
// Kept free of Dexie and Supabase imports so the rules that prevent record
// resurrection can be unit tested in plain Node (see scripts/tombstones.test.mjs).
// sync.ts performs the I/O; every decision about *what* to do lives here.
//
// Retention window must stay in sync with the SQL in
// supabase/migrations/20260930000100_tombstone_retention.sql.

export const TOMBSTONE_RETENTION_DAYS = 30
const TOMBSTONE_RETENTION_MS = TOMBSTONE_RETENTION_DAYS * 86_400_000

export type Tombstoned = { id: string; updatedAt: string; deletedAt?: string | null }

/** True once a tombstone is old enough to be removed entirely. */
export function isPurgeableTombstone(record: { deletedAt?: string | null }, now: number = Date.now()) {
  if (!record.deletedAt) return false
  const deletedMs = Date.parse(record.deletedAt)
  // An unparseable timestamp is not evidence of age, so keep the record.
  if (Number.isNaN(deletedMs)) return false
  return now - deletedMs >= TOMBSTONE_RETENTION_MS
}

/** Strips tombstones from a list before it reaches the UI. */
export function visible<T extends { deletedAt?: string | null }>(rows: T[]) {
  return rows.filter(r => !r.deletedAt)
}

/** What mergeTasks/mergeShopping/mergePurchases should do with one remote row. */
export type MergeAction =
  | { kind: 'put-tombstone' }   // store the remote tombstone locally
  | { kind: 'put-remote' }      // remote wins on recency
  | { kind: 'queue-upsert' }    // local is newer, push it
  | { kind: 'queue-delete' }    // local tombstone, remote still live: re-assert the delete
  | { kind: 'skip' }            // a local delete is already pending for this id

/**
 * Decides how to reconcile one remote record against its local counterpart.
 *
 * `pendingDelete` means the local outbox already holds a delete for this id, so
 * the remote copy is stale by definition and must not overwrite anything.
 */
export function decideMerge(remote: Tombstoned, local: Tombstoned | undefined, pendingDelete: boolean): MergeAction {
  if (pendingDelete) return { kind: 'skip' }

  // Sticky delete. A tombstone always wins over a live local copy, even when the
  // local copy is newer, so an offline device cannot undo someone else's delete.
  if (remote.deletedAt) return { kind: 'put-tombstone' }

  // Our delete never reached the server. Re-assert it instead of accepting the
  // live row, which would resurrect the record on the device that deleted it.
  if (local?.deletedAt) return { kind: 'queue-delete' }

  if (!local) return { kind: 'put-remote' }
  return remote.updatedAt >= local.updatedAt ? { kind: 'put-remote' } : { kind: 'queue-upsert' }
}

/**
 * Decides whether a local record missing from the remote set should be
 * re-uploaded.
 *
 * A local tombstone must never be re-uploaded: once the server purges the
 * tombstone the record is absent from remote, and treating that as "orphaned
 * local data" would resurrect a deleted record.
 */
export function shouldPushOrphan(local: Tombstoned, remoteIds: Set<string>, pendingDelete: boolean) {
  if (remoteIds.has(local.id)) return false
  if (pendingDelete) return false
  return !local.deletedAt
}

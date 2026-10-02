export const DEFAULT_REMINDER_MINUTES = 24 * 60

/** Upper bound for a custom lead time: 30 days. Keeps absurd input out of the stored task. */
export const MAX_CUSTOM_REMINDER_MINUTES = 30 * 24 * 60

function localDateTimeToDate(date: string, time?: string | null) {
  // Interpret the task time in the user's current device timezone.
  return new Date(`${date}T${time || '09:00'}:00`)
}

export function calculateReminderAt(dueDate?: string | null, dueTime?: string | null, minutesBefore = DEFAULT_REMINDER_MINUTES) {
  if (!dueDate) return null
  const due = localDateTimeToDate(dueDate, dueTime)
  if (Number.isNaN(due.getTime())) return null
  return new Date(due.getTime() - minutesBefore * 60_000).toISOString()
}

export type ReminderOptionId = 'none' | 'due' | '30m' | '1h' | '1d' | 'custom'

export type ReminderUnit = 'minutes' | 'hours' | 'days'

/**
 * Preset lead times. 'custom' carries no minutes of its own: it resolves from the
 * amount and unit the user entered, so one option id can express any lead time
 * without a new column or a migration.
 */
export const REMINDER_OPTIONS: { id: ReminderOptionId; label: string; minutes: number | null }[] = [
  { id: 'none', label: 'No reminder', minutes: null },
  { id: 'due', label: 'At due time', minutes: 0 },
  { id: '30m', label: '30 min before', minutes: 30 },
  { id: '1h', label: '1 hour before', minutes: 60 },
  { id: '1d', label: '1 day before', minutes: DEFAULT_REMINDER_MINUTES },
  { id: 'custom', label: 'Custom', minutes: null },
]

export const REMINDER_UNITS: { id: ReminderUnit; label: string; minutes: number }[] = [
  { id: 'minutes', label: 'minutes before', minutes: 1 },
  { id: 'hours', label: 'hours before', minutes: 60 },
  { id: 'days', label: 'days before', minutes: 1440 },
]

/** Converts an entered amount and unit into whole minutes. */
export function toMinutes(amount: number, unit: ReminderUnit): number {
  const match = REMINDER_UNITS.find(u => u.id === unit)
  if (!match) return Number.NaN
  return amount * match.minutes
}

/**
 * Checks a custom amount/unit pair.
 *
 * Returns null when the value is usable, otherwise a sentence the UI can show
 * verbatim. Zero is rejected on purpose: "At due time" is the option that means
 * zero, so silently accepting it here would make two chips mean the same thing.
 */
export function validateCustomReminder(amount: number, unit: ReminderUnit): string | null {
  if (!REMINDER_UNITS.some(u => u.id === unit)) return 'Choose minutes, hours or days.'
  if (!Number.isFinite(amount)) return 'Enter a whole number.'
  if (!Number.isInteger(amount)) return 'Enter a whole number, with no decimals.'
  if (amount <= 0) return 'Enter a number greater than zero, or choose "At due time".'
  if (toMinutes(amount, unit) > MAX_CUSTOM_REMINDER_MINUTES) return 'Enter at most 30 days before.'
  return null
}

export function reminderOptionLabel(id: ReminderOptionId) {
  return REMINDER_OPTIONS.find(option => option.id === id)?.label ?? ''
}

/* ---------------------------------------------------------------------------
 * Due date input guards.
 *
 * Pure and string-based on purpose (yyyy-mm-dd sorts correctly as text) so the
 * "no date before the chosen preset" rule can be asserted in a test without a
 * DOM, and so the picker and the save path can share one definition of "allowed".
 * ------------------------------------------------------------------------- */

export type DueDatePreset = 'today' | 'tomorrow' | 'custom'

/**
 * Earliest date offered for a preset.
 *
 * Today pins the floor to today and Tomorrow raises it to tomorrow, so with
 * Tomorrow selected the picker cannot offer today either. Every other state
 * (including plain "Choose date") floors at today, which keeps past dates
 * unselectable everywhere.
 */
export function minDueDateForPreset(preset: DueDatePreset, today: string, tomorrow: string): string {
  return preset === 'tomorrow' ? tomorrow : today
}

/** Whether iso is a real calendar date that is on or after min. */
export function isDueDateAllowed(iso: string, min: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  // A shape check alone would wave through month 13 or 30 February, because those
  // strings still sort after the floor. Round-tripping through Date rejects any
  // day that does not actually exist.
  const [year, month, day] = iso.split('-').map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return false
  return iso >= min
}

/** Snaps a date back up to min so a preset change never leaves an invalid value in state. */
export function clampDueDate(iso: string, min: string): string {
  return isDueDateAllowed(iso, min) ? iso : min
}

/**
 * A task with a specific time gets the tighter lead so it still lands on the
 * same day; a date-only task defaults to a day ahead. Mirrors the 09:00
 * fallback in localDateTimeToDate, so date-only reminders arrive in the morning.
 */
export function defaultReminderOption(dueTime?: string | null): ReminderOptionId {
  return dueTime ? '1h' : '1d'
}

/**
 * Turns a due date/time plus a chosen option into the fields a task stores.
 *
 * Only reminderAt is what the reminder cron reads, so a lead time that has
 * already elapsed produces a past timestamp and fires on the next cron tick
 * rather than being skipped.
 *
 * ReminderMinutesBefore stays the single numeric column for every case, so a
 * custom lead time needs no schema change: 'custom' simply resolves to the
 * minutes its amount and unit convert to, and 'none' keeps the existing
 * disabled/null representation.
 */
export function resolveReminder(
  dueDate: string | null | undefined,
  dueTime: string | null | undefined,
  optionId: ReminderOptionId,
  customMinutes?: number | null,
) {
  if (!dueDate || optionId === 'none') return { enabled: false, minutesBefore: null, reminderAt: null }

  const preset = REMINDER_OPTIONS.find(option => option.id === optionId)?.minutes
  let minutes = optionId === 'custom' ? (customMinutes ?? NaN) : (preset ?? DEFAULT_REMINDER_MINUTES)

  // Defence in depth. The UI validates before saving and never calls this with a
  // bad custom value; if a caller does, fall back instead of storing nonsense.
  if (!Number.isFinite(minutes) || minutes < 0) minutes = DEFAULT_REMINDER_MINUTES
  minutes = Math.min(Math.floor(minutes), MAX_CUSTOM_REMINDER_MINUTES)

  return { enabled: true, minutesBefore: minutes, reminderAt: calculateReminderAt(dueDate, dueTime, minutes) }
}
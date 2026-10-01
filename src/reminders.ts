export const DEFAULT_REMINDER_MINUTES = 24 * 60

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

export type ReminderOptionId = 'none' | 'due' | '1h' | '1d'

export const REMINDER_OPTIONS: { id: ReminderOptionId; label: string; minutes: number | null }[] = [
  { id: 'none', label: 'No reminder', minutes: null },
  { id: 'due', label: 'At due time', minutes: 0 },
  { id: '1h', label: '1 hour before', minutes: 60 },
  { id: '1d', label: '1 day before', minutes: DEFAULT_REMINDER_MINUTES },
]

export function reminderOptionLabel(id: ReminderOptionId) {
  return REMINDER_OPTIONS.find(option => option.id === id)?.label ?? ''
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
 */
export function resolveReminder(dueDate: string | null | undefined, dueTime: string | null | undefined, optionId: ReminderOptionId) {
  if (!dueDate || optionId === 'none') return { enabled: false, minutesBefore: null, reminderAt: null }
  const minutes = REMINDER_OPTIONS.find(option => option.id === optionId)?.minutes ?? DEFAULT_REMINDER_MINUTES
  return { enabled: true, minutesBefore: minutes, reminderAt: calculateReminderAt(dueDate, dueTime, minutes) }
}

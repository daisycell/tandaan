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

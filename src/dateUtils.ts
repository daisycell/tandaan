export function greetingForHour(hour: number) {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function formatDue(date?: string | null, time?: string | null) {
  if (!date) return ''
  const d = new Date(`${date}T${time || '12:00'}`)
  const datePart = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(d)
  if (!time) return datePart
  const timePart = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d)
  return `${datePart} · ${timePart}`
}

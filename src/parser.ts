const normalize = (text: string) => text.toLowerCase().replace(/[“”]/g, '"').trim()

export type Intent = 'task' | 'shopping' | 'purchase' | 'note'

export function detectIntent(text: string): Intent {
  const t = normalize(text)

  if (/\b(i bought|i purchased|bought|purchased|nabakal|nakapalit)\b/.test(t)) return 'purchase'
  if (/\b(i('| )ll|i will|tomorrow|bukas|ugma|remind me|due)\b/.test(t)) return 'task'
  if (/\b(mabakal|bakal|palit|paliton|buy|need to buy|shopping)\b/.test(t)) return 'shopping'
  if (/\b(note|remember|take note)\b/.test(t)) return 'note'

  // Item + quantity/unit + price is treated as a purchase when no future/shopping verb is present.
  if (/\b\d+(?:\.\d+)?\s*(?:kg|kilos?|pcs?|pieces?|tray|trays|lata|cans?|bottle|bottles|pack|packs|box|boxes)\b.*\d+(?:\.\d+)?\s*(?:pesos?|php|₱)?\s*$/i.test(t)) {
    return 'purchase'
  }

  return 'task'
}

export function extractDueInfo(text: string) {
  const t = normalize(text)
  const result: { dueDate?: string; dueTime?: string; cleanedTitle: string } = { cleanedTitle: text.trim() }

  const tomorrow = /\b(tomorrow|bukas|ugma)\b/i.test(t)
  if (tomorrow) {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    result.dueDate = d.toISOString().slice(0, 10)
  }

  const today = /\b(today|karon)\b/i.test(t)
  if (today) {
    const d = new Date()
    result.dueDate = d.toISOString().slice(0, 10)
  }

  const time = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (time) {
    let hour = Number(time[1])
    const minute = Number(time[2] ?? '0')
    const ampm = time[3].toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    result.dueTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }

  result.cleanedTitle = text
    .replace(/\b(tomorrow|bukas|ugma|today|karon)\b/gi, '')
    .replace(/\b(at|sa)\s+\d{1,2}(?::\d{2})?\s*(am|pm)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  return result
}

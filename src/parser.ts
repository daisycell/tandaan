const normalize = (text: string) => text.toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()

export type Intent = 'task' | 'shopping' | 'purchase' | 'note'

export type ParsedInput = {
  intent: Intent
  original: string
  title?: string
  dueDate?: string | null
  dueTime?: string | null
  shopping?: { name: string; quantity?: number | null; unit?: string | null; expectedPrice?: number | null }
  purchases?: Array<{ itemName: string; quantity?: number | null; unit?: string | null; price?: number | null }>
}

const futureTask = /\b(i['’]?ll|i will|i['’]?m going to|i am going to|later|remind me|due)\b/i
const taskVerb = /\b(pay|finish|submit|call|send|do|complete|clean|study|go to|meet|remember to|remind me|need to)\b/i
const shoppingVerb = /\b(buy|need to buy|shopping|mabakal|bakal|palit|paliton|paliton ko|palit ko|pangbakal)\b/i
const purchaseVerb = /\b(i bought|i purchased|bought|purchased|nabakal|nakapalit|nabili|napalit|nabakal ko|nakapalit ko)\b/i
const noteVerb = /\b(note|take note|tandaan)\b/i

const UNIT_RE = '(?:kg|kilo|kilos|g|gram|grams|pcs?|piece|pieces|tray|trays|lata|can|cans|bottle|bottles|pack|packs|box|boxes|dozen|dozens|liters?|litres?|ml|milliliters?|mL)'

function numberValue(value: string) {
  const n = Number(value.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function parseSegment(segment: string) {
  let s = segment.trim().replace(/^[-•]+\s*/, '').replace(/[.]+$/, '')
  if (!s) return null

  // item + quantity + unit + price: "egg 1 tray 400"
  let m = s.match(new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT_RE})\\s+(?:₱\\s*)?(\\d+(?:\\.\\d+)?)$`, 'i'))
  if (m) {
    return { itemName: m[1].trim(), quantity: numberValue(m[2]), unit: m[3].toLowerCase(), price: numberValue(m[4]) }
  }

  // item + quantity + unit: "egg 20 pieces". In a terse, non-command entry this is a purchase with unknown price.
  m = s.match(new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT_RE})$`, 'i'))
  if (m) {
    return { itemName: m[1].trim(), quantity: numberValue(m[2]), unit: m[3].toLowerCase(), price: null }
  }

  // item + price: "rice 40". The final number is price in purchase shorthand.
  m = s.match(/^(.+?)\s+(?:₱\s*)?(\d+(?:\.\d+)?)$/i)
  if (m) {
    return { itemName: m[1].trim(), quantity: null, unit: null, price: numberValue(m[2]) }
  }

  return null
}

export function parseInput(text: string): ParsedInput {
  const raw = text.trim()
  const t = normalize(raw)

  // Explicit future/task language wins over shorthand purchase interpretation.
  if (futureTask.test(t) || (taskVerb.test(t) && !purchaseVerb.test(t))) {
    const due = extractDueInfo(raw)
    return { intent: 'task', original: raw, title: due.cleanedTitle || raw, dueDate: due.dueDate ?? null, dueTime: due.dueTime ?? null }
  }

  if (purchaseVerb.test(t)) {
    const withoutLead = raw.replace(/^(?:i\s+)?(?:bought|purchased|nabakal(?:\s+ko)?|nakapalit(?:\s+ko)?|nabili|napalit)\b\s*/i, '')
    const parts = splitList(withoutLead)
    const purchases = parts.map(parseSegment).filter(Boolean) as Array<{ itemName: string; quantity?: number | null; unit?: string | null; price?: number | null }>
    if (purchases.length) return { intent: 'purchase', original: raw, purchases }
  }

  // Terse item + numeric detail is intentionally treated as a purchase.
  const shorthandParts = splitList(raw)
  const shorthandPurchases = shorthandParts.map(parseSegment).filter(Boolean) as Array<{ itemName: string; quantity?: number | null; unit?: string | null; price?: number | null }>
  if (shorthandPurchases.length === shorthandParts.length && shorthandPurchases.length > 0) {
    return { intent: 'purchase', original: raw, purchases: shorthandPurchases }
  }

  if (shoppingVerb.test(t)) {
    return { intent: 'shopping', original: raw, shopping: parseShopping(raw) }
  }

  if (noteVerb.test(t)) return { intent: 'note', original: raw, title: raw }

  const due = extractDueInfo(raw)
  return { intent: 'task', original: raw, title: due.cleanedTitle || raw, dueDate: due.dueDate ?? null, dueTime: due.dueTime ?? null }
}

export function detectIntent(text: string): Intent {
  return parseInput(text).intent
}

function splitList(text: string) {
  return text
    .split(/[,;\n]|\s+\band\s+|\s+\bkag\s+|\s+\bkag\s+/i)
    .map(s => s.trim())
    .filter(Boolean)
}

function parseShopping(text: string) {
  const withoutVerb = text
    .replace(/^(?:i\s+need\s+to\s+)?(?:buy|mabakal|bakal|palit|paliton|palit ko|bakal ko|pangbakal)\b/i, '')
    .trim()
  const parsed = parseSegment(withoutVerb)
  if (parsed) return { name: parsed.itemName, quantity: parsed.quantity, unit: parsed.unit, expectedPrice: parsed.price }
  return { name: withoutVerb || text.trim() }
}

export function extractDueInfo(text: string) {
  const result: { dueDate?: string; dueTime?: string; cleanedTitle: string } = { cleanedTitle: text.trim() }
  const lower = normalize(text)
  const base = new Date()

  if (/\b(tomorrow|bukas|ugma)\b/i.test(lower)) {
    base.setDate(base.getDate() + 1)
    result.dueDate = localISODate(base)
  } else if (/\b(today|karon)\b/i.test(lower)) {
    result.dueDate = localISODate(base)
  }

  const weekdayMatch = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/i)
  if (weekdayMatch && !result.dueDate) {
    const dayNames: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 }
    const wanted = dayNames[weekdayMatch[1]]
    const current = base.getDay()
    const offset = (wanted - current + 7) % 7 || 7
    base.setDate(base.getDate() + offset)
    result.dueDate = localISODate(base)
  }

  const explicitDate = lower.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/)
  if (explicitDate) {
    if (explicitDate[1]) result.dueDate = `${explicitDate[1]}-${String(explicitDate[2]).padStart(2, '0')}-${String(explicitDate[3]).padStart(2, '0')}`
    else {
      let year = Number(explicitDate[6]); if (year < 100) year += 2000
      result.dueDate = `${year}-${String(explicitDate[4]).padStart(2, '0')}-${String(explicitDate[5]).padStart(2, '0')}`
    }
  }

  const time = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (time) {
    let hour = Number(time[1])
    const minute = Number(time[2] ?? '0')
    const ampm = time[3].toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    result.dueTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    if (!result.dueDate) result.dueDate = localISODate(base)
  }

  result.cleanedTitle = text
    .replace(/\b(tomorrow|bukas|ugma|today|karon)\b/gi, '')
    .replace(/\b(?:on|sa)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/gi, '')
    .replace(/\b(at|sa)\s+\d{1,2}(?::\d{2})?\s*(am|pm)\b/gi, '')
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/gi, '')
    .replace(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  return result
}

function localISODate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

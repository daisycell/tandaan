const normalize = (text: string) => text
  .toLowerCase()
  .replace(/[“”]/g, '"')
  .replace(/[’]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

export type Intent = 'task' | 'shopping' | 'purchase' | 'note'

type ParsedLine = { itemName: string; quantity?: number | null; unit?: string | null; price?: number | null }

export type ParsedInput = {
  intent: Intent
  original: string
  title?: string
  dueDate?: string | null
  dueTime?: string | null
  shopping?: ParsedLine
  shoppingItems?: ParsedLine[]
  purchases?: ParsedLine[]
}

const futureTask = /\b(i['’]?ll|i will|i['’]?m going to|i am going to|later|remind me|due|i need to|need to)\b/i
const taskVerb = /\b(pay|finish|submit|call|send|do|complete|clean|study|go to|meet|remember to|remind me)\b/i
const shoppingVerb = /\b(buy|need to buy|shopping|mabakal|bakal|palit|paliton|palit ko|pangbakal|mupalit|palita|palitan)\b/i
const purchaseVerb = /\b(i bought|i purchased|bought|purchased|nabakal|nakapalit|nabili|napalit|nabakal ko|nakapalit ko|nabili ko|nakapalit ko)\b/i
const noteVerb = /\b(note|take note|note down)\b/i

const UNIT_RE = '(?:kg|kilo|kilos|g|gram|grams|pcs?|piece|pieces|tray|trays|lata|can|cans|bottle|bottles|pack|packs|box|boxes|dozen|dozens|liters?|litres?|ml|milliliters?|mL)'

const numberWords: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
  isa: 1, usa: 1, isang: 1, duha: 2, dos: 2, tatlo: 3, tulo: 3, apat: 4, lima: 5, anum: 6, unom: 6, pito: 7, walo: 8, siyam: 9, pulo: 10
}

function parseNumberToken(token: string) {
  const cleaned = token.toLowerCase().replace(/,/g, '').trim()
  if (!cleaned) return null
  if (/^\d+(?:\.\d+)?$/.test(cleaned)) return Number(cleaned)
  return numberWords[cleaned] ?? null
}

function wordsToNumber(text: string) {
  const t = normalize(text).replace(/\bka\b/g, ' ').replace(/\bng\b/g, ' ')
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t)
  const parts = t.split(/\s+/).filter(Boolean)
  if (!parts.length) return null

  // Handle compact English money/quantity phrases such as "two hundred".
  let total = 0
  let current = 0
  let saw = false
  for (const part of parts) {
    const value = parseNumberToken(part)
    if (value == null) continue
    saw = true
    if (value === 100 || value === 1000) {
      if (current === 0) current = 1
      current *= value
      if (value === 1000) {
        total += current
        current = 0
      }
    } else {
      current += value
    }
  }
  const result = total + current
  return saw ? result : null
}

function valueFrom(text: string) {
  const direct = text.match(/^\s*(?:₱\s*)?(\d+(?:\.\d+)?)\s*$/)
  if (direct) return Number(direct[1].replace(/,/g, ''))
  return wordsToNumber(text)
}

function canonicalUnit(unit: string) {
  const map: Record<string, string> = {
    kg: 'kg', kilo: 'kg', kilos: 'kg',
    g: 'g', gram: 'g', grams: 'g',
    pcs: 'pcs', pc: 'pc', piece: 'pc', pieces: 'pcs',
    tray: 'tray', trays: 'tray',
    lata: 'can', can: 'can', cans: 'can',
    bottle: 'bottle', bottles: 'bottle', pack: 'pack', packs: 'pack',
    box: 'box', boxes: 'box', dozen: 'dozen', dozens: 'dozen',
    liter: 'L', liters: 'L', litre: 'L', litres: 'L', ml: 'mL', milliliter: 'mL', milliliters: 'mL'
  }
  return map[unit.toLowerCase()] ?? unit
}

function parseSegment(segment: string): ParsedLine | null {
  let s = segment.trim().replace(/^[-•]+\s*/, '').replace(/[.]+$/, '')
  if (!s) return null

  // "egg 1 tray 400" / "egg one tray four hundred"
  let m = s.match(new RegExp(`^(.+?)\\s+([\\w .,-]+?)\\s+(${UNIT_RE})\\s+(?:for\\s+|at\\s+|₱\\s*)?([\\w ,.-]+)$`, 'i'))
  if (m) {
    const quantity = valueFrom(m[2])
    const price = valueFrom(m[4])
    if (quantity != null && price != null) {
      return { itemName: m[1].trim(), quantity, unit: canonicalUnit(m[3]), price }
    }
  }

  // "egg 20 pieces" / "egg twenty pieces"
  m = s.match(new RegExp(`^(.+?)\\s+([\\w .,-]+?)\\s+(${UNIT_RE})$`, 'i'))
  if (m) {
    const quantity = valueFrom(m[2])
    if (quantity != null) return { itemName: m[1].trim(), quantity, unit: canonicalUnit(m[3]), price: null }
  }

  // "egg 20" / "rice forty" — terse purchase shorthand treats the last number as price.
  m = s.match(/^(.+?)\s+(.+)$/i)
  if (m) {
    const price = valueFrom(m[2])
    if (price != null && /(\d|zero|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|isa|duha|tatlo|tulo|apat|lima|anum|unom|pito|walo|siyam|napulo)/i.test(m[2])) {
      return { itemName: m[1].trim(), quantity: null, unit: null, price }
    }
  }

  return null
}

export function parseInput(text: string): ParsedInput {
  const raw = text.trim()
  const t = normalize(raw)

  // Explicit intent language wins over numeric shorthand.
  if (futureTask.test(t) || (taskVerb.test(t) && !purchaseVerb.test(t))) {
    const due = extractDueInfo(raw)
    return { intent: 'task', original: raw, title: due.cleanedTitle || raw, dueDate: due.dueDate ?? null, dueTime: due.dueTime ?? null }
  }

  if (purchaseVerb.test(t)) {
    const withoutLead = stripParticles(raw.replace(/^(?:i\s+)?(?:bought|purchased|nabakal|nakapalit|nabili|napalit)\b\s*(?:ko\s+)?/i, ''))
    const parts = splitList(withoutLead)
    const purchases = parts.map(parseSegment).filter(Boolean) as ParsedLine[]
    if (purchases.length) return { intent: 'purchase', original: raw, purchases }
  }

  // Terse entries with numbers/units are purchases, even without "bought".
  const shorthandParts = splitList(raw)
  const shorthandPurchases = shorthandParts.map(parseSegment).filter(Boolean) as ParsedLine[]
  if (shorthandPurchases.length === shorthandParts.length && shorthandPurchases.length > 0 && shorthandPurchases.some(p => p.price != null || p.quantity != null)) {
    return { intent: 'purchase', original: raw, purchases: shorthandPurchases }
  }

  if (shoppingVerb.test(t)) {
    const withoutVerb = stripParticles(raw.replace(/^(?:i\s+need\s+to\s+|i\s+want\s+to\s+)?(?:buy|mabakal|bakal|palit|paliton|pangbakal|mupalit|palita|palitan)\b/i, '').trim())
    const parts = splitList(withoutVerb)
    const items = parts.map(parseShoppingSegment).filter(Boolean) as ParsedLine[]
    if (items.length) return { intent: 'shopping', original: raw, shopping: items[0], shoppingItems: items }
    return { intent: 'shopping', original: raw, shopping: { itemName: withoutVerb || raw } }
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
    .split(/[,;\n]|\s+\band\s+|\s+\bkag\s+|\s+\b&&\s+/i)
    .map(s => s.trim())
    .filter(Boolean)
}

function stripParticles(text: string) {
  let current = text.trim()
  for (let i = 0; i < 4; i += 1) {
    const next = current.replace(/^(?:ko|ku|ako|mo|mga|sang|ang|ug|og|sa|nga)\s+/i, '').trim()
    if (next === current) break
    current = next
  }
  return current
}

function parseShoppingSegment(segment: string): ParsedLine | null {
  const parsed = parseSegment(segment)
  if (parsed) return { itemName: parsed.itemName, quantity: parsed.quantity, unit: parsed.unit, price: parsed.price }
  return { itemName: segment.trim() }
}

export function extractDueInfo(text: string) {
  const result: { dueDate?: string; dueTime?: string; cleanedTitle: string } = { cleanedTitle: text.trim() }
  const lower = normalize(text)
  const base = new Date()

  if (/\b(tomorrow|bukas|ugma|bwas)\b/i.test(lower)) {
    base.setDate(base.getDate() + 1)
    result.dueDate = localISODate(base)
  } else if (/\b(today|karon)\b/i.test(lower)) {
    result.dueDate = localISODate(base)
  }

  const weekdayMatch = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/i)
  if (weekdayMatch && !result.dueDate) {
    const dayNames: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 }
    const wanted = dayNames[weekdayMatch[1].toLowerCase()]
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
    .replace(/\b(tomorrow|bukas|ugma|bwas|today|karon)\b/gi, '')
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

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, BellRing, CalendarPlus, Check, Circle, Clock3, Mic, Pencil, Plus, Settings, ShoppingCart, Sparkles, Square, UserRound, X, Palette, WifiOff, CheckCircle2, SlidersHorizontal } from 'lucide-react'
import { db, getLocalName, getLocalTheme, getLocalThemeCustomizations, queueDelete, queueTaskDelete, queueTaskUpsert, queueUpsert, setLocalName, setLocalTheme, setLocalThemeCustomizations } from './db'
import { formatDue, greetingForHour, todayISO } from './dateUtils'
import { parseInput, type ParsedInput } from './parser'
import { supabase } from './supabase'
import { getRemoteProfile, getUserId, syncAll, syncProfile } from './sync'
import { calculateReminderAt } from './reminders'
import { enablePushNotifications, getPushSubscription, pushSupported } from './notifications'
import { startVoiceCapture, transcribeVoice, type VoiceRecorder } from './voice'
import type { Purchase, ShoppingItem, Task, ThemeId } from './types'
import { DEFAULT_THEME, STICKERS, THEME_OPTIONS, isThemeId, stickerUrl, themeOption } from './theme'
import SwipeToDelete from './SwipeToDelete'

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

type ThemeCustomizations = {
  stickers: Record<ThemeId, string[]>
  backgrounds: Record<ThemeId, string>
}


const THEME_STICKER_DECK_KEY = 'tandaan-theme-sticker-decks-v1'

function nextThemeStickers(theme: ThemeId, count = 3) {
  const pool = STICKERS[theme]
  if (typeof window === 'undefined' || !pool.length) return pool.slice(0, count)

  let decks: Record<string, string[]> = {}
  try {
    const raw = window.localStorage.getItem(THEME_STICKER_DECK_KEY)
    if (raw) decks = JSON.parse(raw) as Record<string, string[]>
  } catch {
    decks = {}
  }

  let deck = Array.isArray(decks[theme]) ? decks[theme].filter(file => pool.includes(file)) : []
  const missing = pool.filter(file => !deck.includes(file))
  deck.push(...missing)
  if (deck.length < count) deck = [...pool]

  const picked = deck.slice(0, Math.min(count, pool.length))
  const remainder = deck.slice(picked.length)
  decks[theme] = [...remainder, ...picked]

  try {
    window.localStorage.setItem(THEME_STICKER_DECK_KEY, JSON.stringify(decks))
  } catch {
    // Sticker rotation remains best-effort if localStorage is unavailable.
  }

  return picked
}

const DEFAULT_THEME_CUSTOMIZATIONS: ThemeCustomizations = {
  stickers: {
    cat: STICKERS.cat.slice(),
    dog: STICKERS.dog.slice(),
    capybara: STICKERS.capybara.slice(),
  },
  backgrounds: { cat: '', dog: '', capybara: '' },
}

function normalizeThemeCustomizations(value?: Partial<ThemeCustomizations> | null): ThemeCustomizations {
  return {
    stickers: {
      cat: STICKERS.cat.slice(),
      dog: STICKERS.dog.slice(),
      capybara: STICKERS.capybara.slice(),
    },
    backgrounds: {
      cat: value?.backgrounds?.cat ?? '',
      dog: value?.backgrounds?.dog ?? '',
      capybara: value?.backgrounds?.capybara ?? '',
    },
  }
}

function localISODate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function tomorrowISO() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return localISODate(d)
}

function money(value: number) {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 }).format(value)
}

function shortUnit(unit?: string | null) {
  if (!unit) return ''
  const map: Record<string, string> = { kilos: 'kg', kilo: 'kg', grams: 'g', pieces: 'pcs', piece: 'pc', trays: 'tray', cans: 'can', bottles: 'bottle', packs: 'pack', boxes: 'box', liters: 'L', litres: 'L' }
  return map[unit] ?? unit
}

function taskWithReminder(title: string, dueDate: string | null, dueTime: string | null): Task {
  const now = new Date().toISOString()
  return {
    id: newId(), title, isCompleted: false, dueDate, dueTime,
    reminderEnabled: Boolean(dueDate), reminderMinutesBefore: 1440,
    reminderAt: calculateReminderAt(dueDate, dueTime, 1440), reminderSentAt: null,
    createdAt: now, updatedAt: now
  }
}

export default function App() {
  const [name, setName] = useState('')
  const [draftName, setDraftName] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [shopping, setShopping] = useState<ShoppingItem[]>([])
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('Offline-first ready')
  const [profileReady, setProfileReady] = useState(false)
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsName, setSettingsName] = useState('')
  const [draftTheme, setDraftTheme] = useState<ThemeId>(DEFAULT_THEME)
  const [themeCustomizations, setThemeCustomizations] = useState<ThemeCustomizations>(DEFAULT_THEME_CUSTOMIZATIONS)
  const [draftCustomizations, setDraftCustomizations] = useState<ThemeCustomizations>(DEFAULT_THEME_CUSTOMIZATIONS)
  const [displayThemeStickers, setDisplayThemeStickers] = useState<string[]>(() => STICKERS[DEFAULT_THEME].slice(0, 3))
  const [ambiguousInput, setAmbiguousInput] = useState<ParsedInput | null>(null)

  const [duePrompt, setDuePrompt] = useState<{ title: string } | null>(null)
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('')
  const [dueStage, setDueStage] = useState<'choice' | 'details'>('choice')

  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [editingShopping, setEditingShopping] = useState<ShoppingItem | null>(null)
  const [editingPurchase, setEditingPurchase] = useState<Purchase | null>(null)

  const [editTitle, setEditTitle] = useState('')
  const [editDueDate, setEditDueDate] = useState('')
  const [editDueTime, setEditDueTime] = useState('')

  const [editShoppingName, setEditShoppingName] = useState('')
  const [editShoppingQty, setEditShoppingQty] = useState('')
  const [editShoppingUnit, setEditShoppingUnit] = useState('')
  const [editShoppingPrice, setEditShoppingPrice] = useState('')

  const [editPurchaseName, setEditPurchaseName] = useState('')
  const [editPurchaseQty, setEditPurchaseQty] = useState('')
  const [editPurchaseUnit, setEditPurchaseUnit] = useState('')
  const [editPurchasePrice, setEditPurchasePrice] = useState('')

  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [voiceLevel, setVoiceLevel] = useState(0)
  const [voiceSeconds, setVoiceSeconds] = useState(0)
  const [voiceProgress, setVoiceProgress] = useState<number | null>(null)
  const [voiceError, setVoiceError] = useState('')
  const dueTimeRef = useRef<HTMLInputElement | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceReview, setVoiceReview] = useState<ParsedInput | null>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)

  const [remindersEnabled, setRemindersEnabled] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Render from local IndexedDB immediately; cloud work happens in the background.
        const [localTasks, localShopping, localPurchases, saved, savedTheme, savedCustomizations] = await Promise.all([
          db.tasks.toArray(),
          db.shopping.toArray(),
          db.purchases.toArray(),
          getLocalName(),
          getLocalTheme(),
          getLocalThemeCustomizations<ThemeCustomizations>(),
        ])
        if (cancelled) return
        setTasks(localTasks)
        setShopping(localShopping)
        setPurchases(localPurchases)
        setName(saved)
        setSettingsName(saved)
        if (isThemeId(savedTheme)) setTheme(savedTheme)
        if (savedCustomizations) {
          const normalized = normalizeThemeCustomizations(savedCustomizations)
          setThemeCustomizations(normalized)
          setDraftCustomizations(normalized)
        }
      } catch {
        if (!cancelled) setStatus('Local storage unavailable')
      } finally {
        if (!cancelled) setProfileReady(true)
      }

      // Never hold the first paint hostage to network/auth. Sync in the background.
      if (supabase && navigator.onLine) {
        void (async () => {
          try {
            const userId = await getUserId()
            if (!userId || cancelled) return
            const saved = await getLocalName()
            const savedTheme = await getLocalTheme()
            const profile = await getRemoteProfile()
            if (cancelled) return
            if (profile?.display_name) {
              await setLocalName(profile.display_name)
              setName(profile.display_name)
              setSettingsName(profile.display_name)
            } else if (saved) {
              await syncProfile(saved, Intl.DateTimeFormat().resolvedOptions().timeZone, isThemeId(savedTheme) ? savedTheme : DEFAULT_THEME)
            }
            const synced = await syncAll()
            if (cancelled) return
            setTasks(synced.tasks)
            setShopping(synced.shoppingItems)
            setPurchases(synced.purchases)
            setStatus('Synced · offline ready')
          } catch {
            if (!cancelled) setStatus('Offline-ready · sync pending')
          }
        })()
      }

      if (pushSupported()) {
        try {
          const sub = await getPushSubscription()
          if (!cancelled) setRemindersEnabled(Boolean(sub))
        } catch {
          // Notification checks are non-blocking.
        }
      }
    })()

    return () => {
      cancelled = true
      recorderRef.current?.cancel()
    }
  }, [])

  useEffect(() => {
    const handleOnline = async () => {
      try {
        const synced = await syncAll()
        setTasks(synced.tasks)
        setShopping(synced.shoppingItems)
        setPurchases(synced.purchases)
        setStatus('Synced · offline ready')
      } catch {
        setStatus('Online · sync retry pending')
      }
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  useEffect(() => {
    if (voiceState !== 'recording') return
    const id = window.setInterval(() => setVoiceSeconds(seconds => seconds + 1), 1000)
    return () => window.clearInterval(id)
  }, [voiceState])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null
    const accent = THEME_OPTIONS.find(option => option.id === theme)?.swatch ?? '#8b5cf6'
    if (meta) meta.content = accent
    void setLocalTheme(theme)
  }, [theme])

  useEffect(() => {
    const background = themeCustomizations.backgrounds[theme]
    document.documentElement.style.setProperty('--theme-wallpaper', background ? `url(\"${background}\")` : 'none')
  }, [theme, themeCustomizations])

  useEffect(() => {
    setDisplayThemeStickers(nextThemeStickers(theme, 3))
    const id = window.setInterval(() => setDisplayThemeStickers(nextThemeStickers(theme, 3)), 8_000)
    return () => window.clearInterval(id)
  }, [theme])

  const greeting = useMemo(() => greetingForHour(new Date().getHours()), [])
  const todayCount = tasks.filter(t => !t.isCompleted && (!t.dueDate || t.dueDate === todayISO())).length
  const purchaseTotal = purchases.reduce((sum, purchase) => sum + (purchase.price ?? 0), 0)
  const pricedPurchaseCount = purchases.filter(p => p.price != null).length

  async function syncNow(message: string) {
    if (!supabase || !navigator.onLine) {
      setStatus(`${message} · sync pending`)
      return
    }
    try {
      const synced = await syncAll()
      setTasks(synced.tasks)
      setShopping(synced.shoppingItems)
      setPurchases(synced.purchases)
      setStatus(`${message} · synced`)
    } catch {
      setStatus(`${message} · sync pending`)
    }
  }

  async function completeOnboarding() {
    const clean = draftName.trim()
    if (!clean) return
    await setLocalName(clean)
    setName(clean)
    if (supabase) {
      try {
        await syncProfile(clean, Intl.DateTimeFormat().resolvedOptions().timeZone, theme)
        setStatus('Profile saved · synced')
      } catch {
        setStatus('Profile saved locally · sync pending')
      }
    }
  }

  async function saveSettings() {
    const clean = settingsName.trim() || name
    const normalized = normalizeThemeCustomizations(draftCustomizations)
    setTheme(draftTheme)
    setLocalName(clean)
    setName(clean)
    setLocalTheme(draftTheme)
    setLocalThemeCustomizations(normalized)
    setThemeCustomizations(normalized)

    // Close immediately after local persistence so cloud sync can never hold the modal open.
    setSettingsOpen(false)
    setStatus('Settings saved on this phone')

    if (supabase && navigator.onLine) {
      void syncProfile(clean, Intl.DateTimeFormat().resolvedOptions().timeZone, draftTheme)
        .then(() => setStatus('Settings saved · synced'))
        .catch(() => setStatus('Settings saved locally · sync pending'))
    }
  }

  function openSettings() {
    setSettingsName(name)
    setDraftTheme(theme)
    setDraftCustomizations(normalizeThemeCustomizations(themeCustomizations))
    setSettingsOpen(true)
  }

  async function ensureReminders() {
    if (!pushSupported() || !supabase) return false
    try {
      await enablePushNotifications()
      setRemindersEnabled(true)
      setStatus('Phone reminders enabled')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not enable phone reminders.'
      if (!message.includes('not configured yet')) setStatus(`Task saved · ${message}`)
      return false
    }
  }

  async function persistTask(task: Task, message = 'Saved') {
    await db.tasks.put(task)
    await queueTaskUpsert(task)
    setTasks(prev => prev.some(t => t.id === task.id) ? prev.map(t => t.id === task.id ? task : t) : [task, ...prev])
    // Local-first: the edit is saved immediately. Cloud sync happens in the background
    // so a slow/failed network request can never block the Save button.
    setStatus(`${message} · saved on this phone`)
    void syncNow(message)
  }

  async function persistShopping(item: ShoppingItem, message = 'Shopping item saved') {
    await db.shopping.put(item)
    await queueUpsert('shopping', item)
    setShopping(prev => prev.some(i => i.id === item.id) ? prev.map(i => i.id === item.id ? item : i) : [item, ...prev])
    setStatus(`${message} · saved on this phone`)
    void syncNow(message)
  }

  async function persistPurchase(item: Purchase, message = 'Purchase saved') {
    await db.purchases.put(item)
    await queueUpsert('purchase', item)
    setPurchases(prev => prev.some(i => i.id === item.id) ? prev.map(i => i.id === item.id ? item : i) : [item, ...prev])
    setStatus(`${message} · saved on this phone`)
    void syncNow(message)
  }

  async function saveParsed(parsed: ParsedInput, forcedIntent?: 'shopping' | 'purchase') {
    if (parsed.ambiguous && !forcedIntent) {
      setAmbiguousInput(parsed)
      return false
    }
    const resolvedIntent = forcedIntent ?? parsed.intent

    if (resolvedIntent === 'task') {
      const title = parsed.title || parsed.original
      if (parsed.dueDate) {
        void ensureReminders()
        const task = taskWithReminder(title, parsed.dueDate, parsed.dueTime ?? null)
        await persistTask(task, 'Task saved')
      } else {
        setDuePrompt({ title })
        setDueDate('')
        setDueTime('')
        setDueStage('choice')
      }
      return true
    }

    if (resolvedIntent === 'shopping') {
      const items = parsed.shoppingItems?.length ? parsed.shoppingItems : parsed.shopping ? [parsed.shopping] : []
      for (const detail of items) {
        const item: ShoppingItem = { id: newId(), name: detail.itemName, quantity: detail.quantity ?? null, unit: detail.unit ?? null, expectedPrice: detail.price ?? null, isPurchased: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        await db.shopping.put(item)
        await queueUpsert('shopping', item)
      }
      setShopping(await db.shopping.toArray())
      await syncNow('Shopping saved')
      return true
    }

    if (resolvedIntent === 'purchase' && parsed.purchases?.length) {
      for (const entry of parsed.purchases) {
        const purchase: Purchase = { id: newId(), itemName: entry.itemName, quantity: entry.quantity ?? null, unit: entry.unit ?? null, price: entry.price ?? null, currency: 'PHP', purchasedAt: new Date().toISOString(), notes: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        await db.purchases.put(purchase)
        await queueUpsert('purchase', purchase)
      }
      setPurchases(await db.purchases.toArray())
      await syncNow('Purchases saved')
      return true
    }

    return true
  }

  async function addFromText() {
    const raw = input.trim()
    if (!raw) return
    const parsed = parseInput(raw)
    setInput('')
    await saveParsed(parsed)
  }

  function selectQuickDue(mode: 'today' | 'tomorrow') {
    const selected = mode === 'today' ? localISODate(new Date()) : tomorrowISO()
    setDueDate(selected)
    setDueTime('')
    setDueStage('details')
    window.setTimeout(() => dueTimeRef.current?.focus(), 80)
  }

  async function saveDueChoice(mode: 'custom' | 'none') {
    if (!duePrompt) return
    if (mode === 'none') {
      const task = taskWithReminder(duePrompt.title, null, null)
      await persistTask(task, 'Task saved')
      setDuePrompt(null)
      setDueDate('')
      setDueTime('')
      setDueStage('choice')
      return
    }

    const nextDate = dueDate || null
    const nextTime = nextDate && dueTime ? dueTime : null
    if (!nextDate) return
    void ensureReminders()
    const task = taskWithReminder(duePrompt.title, nextDate, nextTime)
    await persistTask(task, 'Task saved')
    setDuePrompt(null)
    setDueDate('')
    setDueTime('')
    setDueStage('choice')
  }

  function startEditTask(task: Task) {
    setEditingTask(task)
    setEditTitle(task.title)
    setEditDueDate(task.dueDate ?? '')
    setEditDueTime(task.dueTime ?? '')
  }

  async function saveTaskEdit() {
    if (!editingTask) return
    try {
      const nextDate = editDueDate || null
      const nextTime = nextDate && editDueTime ? editDueTime : null
      const dateChanged = nextDate !== editingTask.dueDate || nextTime !== editingTask.dueTime
      const updated: Task = { ...editingTask, title: editTitle.trim() || editingTask.title, dueDate: nextDate, dueTime: nextTime, reminderEnabled: Boolean(nextDate), reminderMinutesBefore: 1440, reminderAt: dateChanged ? calculateReminderAt(nextDate, nextTime, 1440) : (editingTask.reminderAt ?? calculateReminderAt(nextDate, nextTime, 1440)), reminderSentAt: dateChanged ? null : (editingTask.reminderSentAt ?? null), updatedAt: new Date().toISOString() }
      if (nextDate) void ensureReminders()
      await persistTask(updated, 'Task updated')
      setEditingTask(null)
    } catch (error) {
      setStatus(error instanceof Error ? `Could not save task: ${error.message}` : 'Could not save task.')
    }
  }

  async function toggleTask(task: Task) {
    await persistTask({ ...task, isCompleted: !task.isCompleted, updatedAt: new Date().toISOString() }, 'Task updated')
  }

  async function deleteTask(task: Task) {
    await db.tasks.delete(task.id)
    await queueTaskDelete(task.id)
    setTasks(prev => prev.filter(t => t.id !== task.id))
    await syncNow('Task deleted')
  }

  async function deleteShopping(item: ShoppingItem) {
    await db.shopping.delete(item.id)
    await queueDelete('shopping', item.id)
    setShopping(prev => prev.filter(i => i.id !== item.id))
    await syncNow('Shopping item deleted')
  }

  async function deletePurchase(item: Purchase) {
    await db.purchases.delete(item.id)
    await queueDelete('purchase', item.id)
    setPurchases(prev => prev.filter(i => i.id !== item.id))
    await syncNow('Purchase deleted')
  }

  function startEditShopping(item: ShoppingItem) {
    setEditingShopping(item)
    setEditShoppingName(item.name)
    setEditShoppingQty(item.quantity == null ? '' : String(item.quantity))
    setEditShoppingUnit(item.unit ?? '')
    setEditShoppingPrice(item.expectedPrice == null ? '' : String(item.expectedPrice))
  }

  async function saveShoppingEdit() {
    if (!editingShopping) return
    try {
      const updated: ShoppingItem = { ...editingShopping, name: editShoppingName.trim() || editingShopping.name, quantity: editShoppingQty ? Number(editShoppingQty) : null, unit: editShoppingUnit.trim() || null, expectedPrice: editShoppingPrice ? Number(editShoppingPrice) : null, updatedAt: new Date().toISOString() }
      await persistShopping(updated, 'Shopping item updated')
      setEditingShopping(null)
    } catch (error) {
      setStatus(error instanceof Error ? `Could not save shopping item: ${error.message}` : 'Could not save shopping item.')
    }
  }

  async function toggleShopping(item: ShoppingItem) {
    await persistShopping({ ...item, isPurchased: !item.isPurchased, updatedAt: new Date().toISOString() }, 'Shopping item updated')
  }

  function startEditPurchase(item: Purchase) {
    setEditingPurchase(item)
    setEditPurchaseName(item.itemName)
    setEditPurchaseQty(item.quantity == null ? '' : String(item.quantity))
    setEditPurchaseUnit(item.unit ?? '')
    setEditPurchasePrice(item.price == null ? '' : String(item.price))
  }

  async function savePurchaseEdit() {
    if (!editingPurchase) return
    try {
      const updated: Purchase = { ...editingPurchase, itemName: editPurchaseName.trim() || editingPurchase.itemName, quantity: editPurchaseQty ? Number(editPurchaseQty) : null, unit: editPurchaseUnit.trim() || null, price: editPurchasePrice ? Number(editPurchasePrice) : null, updatedAt: new Date().toISOString() }
      await persistPurchase(updated, 'Purchase updated')
      setEditingPurchase(null)
    } catch (error) {
      setStatus(error instanceof Error ? `Could not save purchase: ${error.message}` : 'Could not save purchase.')
    }
  }

  async function transcribeCaptured(result: { blob: Blob; durationMs: number }) {
    setVoiceState('transcribing')
    setVoiceLevel(0)
    setVoiceProgress(null)
    setStatus('Transcribing on this device…')
    try {
      const transcript = await transcribeVoice(result.blob, result.durationMs, progress => {
        if (progress >= 100) {
          setVoiceProgress(null)
          setStatus('Transcribing on this device…')
        } else {
          setVoiceProgress(progress)
          setStatus(`Preparing voice on this device… ${progress}%`)
        }
      })
      setVoiceTranscript(transcript)
      setInput(transcript)
      setVoiceReview(parseInput(transcript))
      setStatus('Voice transcript ready · review before saving')
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : 'Voice transcription failed.')
      setStatus('Voice is ready to try again')
    } finally {
      setVoiceState('idle')
      setVoiceLevel(0)
      setVoiceProgress(null)
      recorderRef.current = null
    }
  }

  async function startVoice() {
    setVoiceError('')
    setVoiceTranscript('')
    setVoiceSeconds(0)

    if (voiceState === 'transcribing') return

    if (voiceState === 'recording') {
      const recorder = recorderRef.current
      if (recorder) {
        setStatus('Finishing recording…')
        void recorder.stop().catch(error => {
          setVoiceError(error instanceof Error ? error.message : 'Could not stop the recording.')
        })
      }
      return
    }

    try {
      const recorder = await startVoiceCapture(level => setVoiceLevel(level), 15_000)
      recorderRef.current = recorder
      setVoiceState('recording')
      setStatus('Listening… pause when you finish')
      void recorder.finished
        .then(result => transcribeCaptured(result))
        .catch(error => {
          setVoiceError(error instanceof Error ? error.message : 'Recording failed.')
          setVoiceState('idle')
          setVoiceLevel(0)
          recorderRef.current = null
        })
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : 'Could not access the microphone.')
      setVoiceState('idle')
    }
  }

  async function saveVoiceReview() {
    if (!voiceReview) return
    if (voiceReview.ambiguous) {
      setAmbiguousInput(voiceReview)
      setVoiceReview(null)
      return
    }
    const saved = await saveParsed(voiceReview)
    if (saved && !duePrompt) setVoiceReview(null)
  }

  async function chooseAmbiguousIntent(intent: 'shopping' | 'purchase') {
    if (!ambiguousInput) return
    await saveParsed(ambiguousInput, intent)
    setAmbiguousInput(null)
  }

  if (!profileReady) return <div className="boot">Loading Tandaan…</div>

  if (!name) {
    return (
      <main className="onboarding">
        <div className="brand-mark"><ShoppingCart size={40} /></div>
        <div className="brand">Tandaan</div>
        <p>Your offline-first everyday memory.</p>
        <label>What should we call you?</label>
        <input autoFocus value={draftName} onChange={e => setDraftName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') completeOnboarding() }} placeholder="Your name" />
        <button className="primary" onClick={completeOnboarding}><Sparkles size={18} /> Continue</button>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-row"><div><div className="brand">Tandaan</div><div className="sync-status">{status}</div></div></div>
        <div className="header-actions">
          <button className={remindersEnabled ? 'icon-btn active' : 'icon-btn'} onClick={() => void ensureReminders()} aria-label={remindersEnabled ? 'Phone reminders enabled' : 'Enable phone reminders'} title={remindersEnabled ? 'Phone reminders enabled' : 'Enable phone reminders'}>{remindersEnabled ? <BellRing size={18} /> : <Bell size={18} />}</button>
          <button className="icon-btn" onClick={openSettings} aria-label="My profile and settings" title="My profile and settings"><Settings size={18} /></button>
        </div>
      </header>

      <section className="hero">
        <h1>{greeting}, {name}</h1>
        <p>{todayCount === 0 ? 'You are all caught up.' : `You have ${todayCount} task${todayCount === 1 ? '' : 's'} to keep in sight today.`}</p>
        <div className="summary-grid">
          <div className="summary-card card"><span>Today</span><strong>{todayCount}</strong><small>open tasks</small>{displayThemeStickers[0] && <img className="summary-card-sticker sticker-a" src={stickerUrl(theme, displayThemeStickers[0])} alt="" aria-hidden="true" />}</div>
          <div className="summary-card card"><span>Shopping</span><strong>{shopping.filter(i => !i.isPurchased).length}</strong><small>to buy</small>{displayThemeStickers[1] && <img className="summary-card-sticker sticker-b" src={stickerUrl(theme, displayThemeStickers[1])} alt="" aria-hidden="true" />}</div>
          <div className="summary-card card"><span>Purchases</span><strong>{money(purchaseTotal)}</strong><small>{purchases.length} recorded</small>{displayThemeStickers[2] && <img className="summary-card-sticker sticker-c" src={stickerUrl(theme, displayThemeStickers[2])} alt="" aria-hidden="true" />}</div>
        </div>
      </section>

      <section className="quick-add card">
        <div className="section-title"><div><strong>Quick Add</strong><span>Type naturally. Tandaan decides: task, shopping, or purchase.</span></div><div className="beta-pill">smart add</div></div>
        <div className="input-row">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addFromText() }} placeholder="Try: Pay electricity tomorrow at 6 PM" />
          <button className="primary add-btn" onClick={() => void addFromText()}><Plus size={18} /> Add</button>
        </div>
        <button className={voiceState === 'recording' ? 'voice-btn recording' : voiceState === 'transcribing' ? 'voice-btn transcribing' : 'voice-btn'} onClick={() => void startVoice()} disabled={voiceState === 'transcribing'}>
          {voiceState === 'recording' ? <Square size={18} /> : <Mic size={19} />}
          {voiceState === 'recording' ? `Stop · ${voiceSeconds}s` : voiceState === 'transcribing' ? (voiceProgress != null ? `Loading voice · ${voiceProgress}%` : 'Transcribing locally…') : 'Speak'}
          {voiceState === 'recording' && <span className="voice-meter"><span style={{ transform: `scaleY(${0.2 + voiceLevel})` }} /></span>}
        </button>
        <div className="quick-hints"><strong>Quick input</strong> · Type naturally or tap Speak. A short pause after you finish speaking stops the recording automatically. Keep a voice capture under 15 seconds for on-device stability. Examples: “I'll buy egg 200” · “Rice 40” · “Egg 1 tray 400” · “Mabakal bugas kag itlog” · “Pay electricity tomorrow at 6 PM” · “shampoo 1 habon 2 toothpaste kalamay delata 3”</div>
        {voiceError && <div className="inline-error">{voiceError}</div>}
      </section>

      <section className="section-block">
        <div className="section-heading"><h2>Today</h2><span>{tasks.length} total</span></div>
        <div className="task-list">
          {tasks.length === 0 && <div className="empty card">No tasks yet. Add one above.</div>}
          {tasks.map(task => (
            <SwipeToDelete key={task.id} onDelete={() => void deleteTask(task)}>
              <div className="task-card card">
                <button className="check-btn" onClick={() => void toggleTask(task)} aria-label={task.isCompleted ? 'Mark incomplete' : 'Complete task'}>{task.isCompleted ? <Check /> : <Circle />}</button>
                <div className="task-main">
                  <div className={task.isCompleted ? 'task-title completed' : 'task-title'}>{task.title}</div>
                  {task.dueDate && <div className="due-line"><Clock3 size={15} /> {formatDue(task.dueDate, task.dueTime)}</div>}
                </div>
                <div className="task-actions">
                  {!task.dueDate && <button className="icon-btn" onClick={() => startEditTask(task)} title="Set due date"><CalendarPlus size={17} /></button>}
                  <button className="icon-btn" onClick={() => startEditTask(task)} title="Edit"><Pencil size={17} /></button>
                </div>
              </div>
            </SwipeToDelete>
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading"><h2>Shopping</h2><span>{shopping.filter(i => !i.isPurchased).length} remaining</span></div>
        <div className="task-list">
          {shopping.length === 0 && <div className="empty card">No shopping items yet.</div>}
          {shopping.map(item => (
            <SwipeToDelete key={item.id} onDelete={() => void deleteShopping(item)}>
              <div className="task-card card">
                <button className="check-btn" onClick={() => void toggleShopping(item)} aria-label={item.isPurchased ? 'Mark not bought' : 'Mark bought'}>{item.isPurchased ? <Check /> : <Circle />}</button>
                <div className="task-main">
                  <div className={item.isPurchased ? 'task-title completed' : 'task-title'}>{item.name}</div>
                  {(item.quantity != null || item.unit || item.expectedPrice != null) && <div className="detail-line">{item.quantity != null && <span>{item.quantity} {shortUnit(item.unit)}</span>}{item.expectedPrice != null && <span>{money(item.expectedPrice)}</span>}{item.isPurchased && <span className="bought-pill">bought</span>}</div>}
                </div>
                <div className="task-actions"><button className="icon-btn" onClick={() => startEditShopping(item)} title="Edit shopping item"><Pencil size={17} /></button></div>
              </div>
            </SwipeToDelete>
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading"><h2>Purchases</h2><span>{money(purchaseTotal)}{pricedPurchaseCount < purchases.length ? ' · some prices missing' : ''}</span></div>
        <div className="purchase-total card"><div><span>Total spent</span><strong>{money(purchaseTotal)}</strong></div><small>{purchases.length} item{purchases.length === 1 ? '' : 's'} · {pricedPurchaseCount} priced</small></div>
        <div className="swipe-hint">Swipe an item left all the way to delete it.</div>
        <div className="task-list">
          {purchases.map(item => (
            <SwipeToDelete key={item.id} onDelete={() => void deletePurchase(item)}>
              <div className="task-card card">
                <div className="purchase-dot">₱</div>
                <div className="task-main"><div className="task-title">{item.itemName}</div><div className="detail-line">{item.quantity != null && <span>{item.quantity} {shortUnit(item.unit)}</span>}{item.price != null ? <span>{money(item.price)}</span> : <span className="muted-pill">price not entered</span>}</div></div>
                <div className="task-actions"><button className="icon-btn" onClick={() => startEditPurchase(item)} title="Edit purchase"><Pencil size={17} /></button></div>
              </div>
            </SwipeToDelete>
          ))}
        </div>
      </section>

      {ambiguousInput && (
        <div className="modal-backdrop">
          <div className="modal card ambiguity-modal">
            <div className="modal-header"><div><strong>What did you mean?</strong><div className="modal-subtitle">{ambiguousInput.ambiguous?.reason}</div></div><button className="icon-btn" onClick={() => setAmbiguousInput(null)} aria-label="Close"><X /></button></div>
            <div className="review-block">
              <div className="review-label">Shortcut input</div>
              <div className="ambiguity-text">{ambiguousInput.original}</div>
              <div className="review-row ambiguity-preview"><span>Shopping interpretation</span><span>{(ambiguousInput.shoppingItems ?? [ambiguousInput.shopping]).filter(Boolean).map(item => `${item?.itemName}${item?.quantity != null ? ` · ${item.quantity} ${shortUnit(item?.unit)}` : ''}`).join(', ')}</span></div>
              <div className="review-row ambiguity-preview"><span>Purchase interpretation</span><span>{(ambiguousInput.purchases ?? []).map(item => `${item.itemName}${item?.price != null ? ` · ${money(item.price)}` : item?.quantity != null ? ` · ${item.quantity} ${shortUnit(item.unit)}` : ''}`).join(', ')}</span></div>
            </div>
            <div className="modal-actions ambiguity-actions"><button className="secondary" onClick={() => void chooseAmbiguousIntent('shopping')}>🛒 Shopping list</button><button className="primary" onClick={() => void chooseAmbiguousIntent('purchase')}>✓ Purchase</button></div>
            <button className="text-btn" onClick={() => setAmbiguousInput(null)}>Cancel</button>
          </div>
        </div>
      )}

      {voiceReview && (
        <div className="modal-backdrop">
          <div className="modal card">
            <div className="modal-header"><div><strong>I heard</strong><div className="modal-subtitle">{voiceTranscript}</div></div><button className="icon-btn" onClick={() => setVoiceReview(null)}><X /></button></div>
            {voiceReview.intent === 'task' && <div className="review-block"><div className="review-label">Task</div><strong>{voiceReview.title || voiceReview.original}</strong>{voiceReview.dueDate && <div className="due-line"><Clock3 size={15} /> {formatDue(voiceReview.dueDate, voiceReview.dueTime)}</div>}</div>}
            {voiceReview.intent === 'shopping' && <div className="review-block"><div className="review-label">Shopping</div>{(voiceReview.shoppingItems ?? [voiceReview.shopping]).filter(Boolean).map((item, idx) => <div className="review-row" key={idx}><span>{item?.itemName}</span>{item?.quantity != null && <span>{item.quantity} {shortUnit(item.unit)}</span>}{item?.price != null && <span>{money(item.price)}</span>}</div>)}</div>}
            {voiceReview.intent === 'purchase' && <div className="review-block"><div className="review-label">Purchase</div>{(voiceReview.purchases ?? []).map((item, idx) => <div className="review-row" key={idx}><span>{item.itemName}</span>{item.quantity != null && <span>{item.quantity} {shortUnit(item.unit)}</span>}{item.price != null && <span>{money(item.price)}</span>}</div>)}<div className="review-total">Total recognized: {money((voiceReview.purchases ?? []).reduce((sum, item) => sum + (item.price ?? 0), 0))}</div></div>}
            <div className="modal-actions"><button className="secondary" onClick={() => { setInput(voiceTranscript); setVoiceReview(null) }}>Edit text</button><button className="primary" onClick={() => void saveVoiceReview()}>Save</button></div>
          </div>
        </div>
      )}

      {duePrompt && (
        <div className="modal-backdrop">
          <div className="modal card">
            <div className="modal-header"><div><strong>When is this due?</strong><div className="modal-subtitle">{duePrompt.title}</div></div><button className="icon-btn" onClick={() => { setDuePrompt(null); setDueStage('choice') }}><X /></button></div>
            {dueStage === 'choice' ? (
              <>
                <div className="choice-grid">
                  <button className="choice-card" onClick={() => selectQuickDue('today')}>Today</button>
                  <button className="choice-card" onClick={() => selectQuickDue('tomorrow')}>Tomorrow</button>
                  <button className="choice-card wide" onClick={() => { setDueDate(dueDate || localISODate(new Date())); setDueTime(''); setDueStage('details'); window.setTimeout(() => dueTimeRef.current?.focus(), 80) }}>Choose date</button>
                  <button className="choice-card wide" onClick={() => void saveDueChoice('none')}>No due date</button>
                </div>
              </>
            ) : (
              <div className="custom-due card-inner">
                <div className="due-selected"><span>Due date</span><strong>{dueDate}</strong></div>
                <label className="optional-time-label">Time <span>optional — leave blank for date only</span></label>
                <input ref={dueTimeRef} aria-label="Optional time" type="time" value={dueTime} onChange={e => setDueTime(e.target.value)} />
                <div className="modal-actions"><button className="secondary" onClick={() => { setDueTime(''); void saveDueChoice('custom') }}>No specific time</button><button className="primary" onClick={() => void saveDueChoice('custom')}><CalendarPlus size={17} /> Save</button></div>
                <button className="text-btn" onClick={() => setDueStage('choice')}>Change date</button>
              </div>
            )}
          </div>
        </div>
      )}


      {settingsOpen && (
        <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
          <div className="modal card settings-modal">
            <div className="modal-header"><div><strong>My Profile & Settings</strong><div className="modal-subtitle">Personalize Tandaan on this device.</div></div><button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X /></button></div>

            <section className="settings-section">
              <div className="settings-section-title"><UserRound size={17} /><div><strong>My profile</strong><span>Your name appears in your greeting.</span></div></div>
              <label>Name</label>
              <input value={settingsName} onChange={e => setSettingsName(e.target.value)} placeholder="Your name" />
            </section>

            <section className="settings-section">
              <div className="settings-section-title"><Palette size={17} /><div><strong>Animal theme</strong><span>Choose an animal theme. Its sticker pack is included automatically.</span></div></div>
              <div className="theme-grid">
                {THEME_OPTIONS.map(option => (
                  <button key={option.id} className={draftTheme === option.id ? 'theme-choice active' : 'theme-choice'} onClick={() => setDraftTheme(option.id)}>
                    {draftCustomizations.stickers[option.id][0] ? <img className="theme-choice-sticker" src={stickerUrl(option.id, draftCustomizations.stickers[option.id][0])} alt="" /> : <span className="theme-swatch" style={{ background: option.swatch }} aria-hidden="true" />}
                    <span><strong>{option.name}</strong><small>{option.description}</small></span>
                    {draftTheme === option.id && <CheckCircle2 size={17} />}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section-title"><Palette size={17} /><div><strong>Personalize {themeOption(draftTheme).name}</strong><span>The {themeOption(draftTheme).name} sticker pack is already included. You only need to choose an optional background.</span></div></div>

              <div className="custom-theme-preview">
                {draftCustomizations.backgrounds[draftTheme] && <div className="custom-theme-preview-bg" style={{ backgroundImage: `url(\"${draftCustomizations.backgrounds[draftTheme]}\")` }} aria-hidden="true" />}
                <div className="custom-theme-preview-overlay" aria-hidden="true" />
                <div className="custom-theme-preview-copy"><strong>{themeOption(draftTheme).name}</strong><span>Sticker pack included automatically</span></div>
                <div className="custom-theme-preview-stickers">
                  {STICKERS[draftTheme].slice(0, 5).map(file => <img key={file} src={stickerUrl(draftTheme, file)} alt="" aria-hidden="true" />)}
                </div>
              </div>

              <label className="upload-control">
                <span><strong>Background</strong><small>{draftCustomizations.backgrounds[draftTheme] ? 'Custom photo selected' : 'Use the default theme background'}</small></span>
                <input type="file" accept="image/*" onChange={event => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    const value = typeof reader.result === 'string' ? reader.result : ''
                    if (!value) return
                    setDraftCustomizations(prev => ({ ...prev, backgrounds: { ...prev.backgrounds, [draftTheme]: value } }))
                  }
                  reader.readAsDataURL(file)
                }} />
                <span className="secondary file-btn">Choose photo</span>
              </label>
              {draftCustomizations.backgrounds[draftTheme] && <button className="text-btn" onClick={() => setDraftCustomizations(prev => ({ ...prev, backgrounds: { ...prev.backgrounds, [draftTheme]: '' } }))}>Remove background</button>}
            </section>

            <section className="settings-section">
              <div className="settings-section-title"><SlidersHorizontal size={17} /><div><strong>App behavior</strong><span>Local-first now, cloud sync when online.</span></div></div>
              <div className="settings-status-row"><span><WifiOff size={16} /> Offline-first data</span><strong>Ready</strong></div>
              <div className="settings-status-row"><span><Bell size={16} /> Phone reminders</span><strong>{remindersEnabled ? 'Enabled' : 'Off'}</strong></div>
            </section>

            <div className="modal-actions"><button className="secondary" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="primary" onClick={() => void saveSettings()}><Check size={17} /> Save settings</button></div>
          </div>
        </div>
      )}

      {editingTask && (
        <div className="modal-backdrop"><div className="modal card"><div className="modal-header"><strong>Edit task</strong><button className="icon-btn" onClick={() => setEditingTask(null)}><X /></button></div>
          <label>Task</label><input value={editTitle} onChange={e => setEditTitle(e.target.value)} />
          <div className="custom-due card-inner"><label>Due date <span>Optional</span></label><input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} />{editDueDate && <><label className="optional-time-label">Time <span>optional — leave blank for date only</span></label><input aria-label="Optional time" type="time" value={editDueTime} onChange={e => setEditDueTime(e.target.value)} /></>}{editDueDate && <button className="secondary full" onClick={() => { setEditDueDate(''); setEditDueTime('') }}>Remove due date</button>}</div>
          <div className="modal-actions"><button className="secondary" onClick={() => setEditingTask(null)}>Cancel</button><button className="primary" onClick={() => void saveTaskEdit()}>Save changes</button></div>
        </div></div>
      )}

      {editingShopping && (
        <div className="modal-backdrop"><div className="modal card"><div className="modal-header"><strong>Edit shopping item</strong><button className="icon-btn" onClick={() => setEditingShopping(null)}><X /></button></div><label>Item</label><input value={editShoppingName} onChange={e => setEditShoppingName(e.target.value)} /><div className="two-col"><div><label>Quantity</label><input type="number" min="0" step="0.001" value={editShoppingQty} onChange={e => setEditShoppingQty(e.target.value)} /></div><div><label>Unit</label><input value={editShoppingUnit} onChange={e => setEditShoppingUnit(e.target.value)} placeholder="kg, tray, pcs" /></div></div><label>Expected price (optional)</label><input type="number" min="0" step="0.01" value={editShoppingPrice} onChange={e => setEditShoppingPrice(e.target.value)} /><div className="modal-actions"><button className="secondary" onClick={() => setEditingShopping(null)}>Cancel</button><button className="primary" onClick={() => void saveShoppingEdit()}>Save changes</button></div></div></div>
      )}

      {editingPurchase && (
        <div className="modal-backdrop"><div className="modal card"><div className="modal-header"><strong>Edit purchase</strong><button className="icon-btn" onClick={() => setEditingPurchase(null)}><X /></button></div><label>Item</label><input value={editPurchaseName} onChange={e => setEditPurchaseName(e.target.value)} /><div className="two-col"><div><label>Quantity</label><input type="number" min="0" step="0.001" value={editPurchaseQty} onChange={e => setEditPurchaseQty(e.target.value)} /></div><div><label>Unit</label><input value={editPurchaseUnit} onChange={e => setEditPurchaseUnit(e.target.value)} placeholder="kg, tray, pcs" /></div></div><label>Price (optional)</label><input type="number" min="0" step="0.01" value={editPurchasePrice} onChange={e => setEditPurchasePrice(e.target.value)} /><div className="modal-actions"><button className="secondary" onClick={() => setEditingPurchase(null)}>Cancel</button><button className="primary" onClick={() => void savePurchaseEdit()}>Save changes</button></div></div></div>
      )}
    </main>
  )
}

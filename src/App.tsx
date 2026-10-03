import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, BellRing, CalendarPlus, Check, Circle, Clock3, Pencil, Plus, Settings, Sparkles, UserRound, X, Palette, WifiOff, CheckCircle2, SlidersHorizontal, ArrowLeft, Search, HandCoins, Trash2 } from 'lucide-react'
import { db, getLocalName, getLocalTheme, getLocalThemeColor, getLocalThemeCustomizations, queueDelete, queueTaskDelete, queueTaskUpsert, queueUpsert, setLocalName, setLocalTheme, setLocalThemeColor, setLocalThemeCustomizations, queueDebtUpsert, queueDebtDelete } from './db'
import { formatDue, greetingForHour, todayISO } from './dateUtils'
import { type ParsedInput, type ParsedLine } from './parser'
import { supabase } from './supabase'
import { getRemoteProfile, getUserId, syncAll, syncProfile, purgeLocalTombstones, visible, getFlaggedOutboxItems, retryOutboxItem, discardOutboxItem, MAX_RETRIES } from './sync'
import type { OutboxItem } from './db'
import { calculateReminderAt, resolveReminder, defaultReminderOption, toMinutes, validateCustomReminder, clampDueDate, minDueDateForPreset, isDueDateAllowed, REMINDER_OPTIONS, REMINDER_UNITS, type ReminderOptionId, type ReminderUnit } from './reminders'
import { disablePushNotifications, enablePushNotifications, getPushSubscription, PushStageError, pushSupported } from './notifications'
import { TandaanLogo } from './components/TandaanLogo'
import type { Debt, DebtPayment, Purchase, ShoppingItem, Task, ThemeColorId, ThemeId } from './types'
import { COLOR_OPTIONS, DEFAULT_THEME, DEFAULT_THEME_COLOR, STICKERS, THEME_OPTIONS, colorOption, colorSwatch, isThemeId, isThemeColorId, stickerUrl, themeOption } from './theme'
import SwipeToDelete from './SwipeToDelete'
import DebtView from './components/DebtView'
import { debtStatus, formatDebtMoney, makeDebtPayment, paidPercent, parseAmountToCents, remainingCents, sortDebtPayments, totalPaidCents } from './debt'

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
    strawberry: STICKERS.strawberry.slice(),
  },
  backgrounds: { cat: '', dog: '', capybara: '', strawberry: '' },
}

function normalizeThemeCustomizations(value?: Partial<ThemeCustomizations> | null): ThemeCustomizations {
  return {
    stickers: {
      cat: STICKERS.cat.slice(),
      dog: STICKERS.dog.slice(),
      capybara: STICKERS.capybara.slice(),
      strawberry: STICKERS.strawberry.slice(),
    },
    backgrounds: {
      cat: value?.backgrounds?.cat ?? '',
      dog: value?.backgrounds?.dog ?? '',
      capybara: value?.backgrounds?.capybara ?? '',
      strawberry: value?.backgrounds?.strawberry ?? '',
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

  function taskWithReminder(title: string, dueDate: string | null, dueTime: string | null, reminderOption?: ReminderOptionId, customMinutes?: number | null): Task {
    const now = new Date().toISOString()
    // Omitting the option preserves the original 24h lead, which is what the
    // task edit form and other write paths rely on.
    const reminder = reminderOption
      ? resolveReminder(dueDate, dueTime, reminderOption, customMinutes)
      : { enabled: Boolean(dueDate), minutesBefore: 1440, reminderAt: calculateReminderAt(dueDate, dueTime, 1440) }
    return {
      id: newId(), title, isCompleted: false, dueDate, dueTime,
      reminderEnabled: reminder.enabled,
      // Canonical "no reminder" storage stays as-is: enabled false with the 1440
      // fallback, which is what every existing write path already stores.
      reminderMinutesBefore: reminder.minutesBefore ?? 1440,
      reminderAt: reminder.reminderAt,
      reminderSentAt: null,
      createdAt: now, updatedAt: now
    }
  }

export default function App() {
  const [name, setName] = useState('')
  const [draftName, setDraftName] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [shopping, setShopping] = useState<ShoppingItem[]>([])
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [debts, setDebts] = useState<Debt[]>([])
  const [debtPage, setDebtPage] = useState<'home' | 'list' | 'detail'>('home')
  const [debtDirection, setDebtDirection] = useState<Debt['direction']>('owe')
  const [selectedDebtId, setSelectedDebtId] = useState<string | null>(null)
  const [debtSearch, setDebtSearch] = useState('')
  const [debtFilter, setDebtFilter] = useState<'all' | 'owe' | 'owed_to_me' | 'overdue' | 'paid'>('all')
  const [debtPerson, setDebtPerson] = useState('')
  const [debtAmount, setDebtAmount] = useState('')
  const [debtDescription, setDebtDescription] = useState('')
  const [debtDueDate, setDebtDueDate] = useState('')
  const [debtReminder, setDebtReminder] = useState(true)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentNote, setPaymentNote] = useState('')
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('Offline-first ready')
  const [flaggedItems, setFlaggedItems] = useState<OutboxItem[]>([])
  const [flaggedOpen, setFlaggedOpen] = useState(false)
  const [profileReady, setProfileReady] = useState(false)
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME)
  const [themeColor, setThemeColor] = useState<ThemeColorId>(DEFAULT_THEME_COLOR)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsName, setSettingsName] = useState('')
  const [draftTheme, setDraftTheme] = useState<ThemeId>(DEFAULT_THEME)
  const [draftThemeColor, setDraftThemeColor] = useState<ThemeColorId>(DEFAULT_THEME_COLOR)
  const [colorPickerStep, setColorPickerStep] = useState<'animal' | 'color'>('animal')
  const [themeCustomizations, setThemeCustomizations] = useState<ThemeCustomizations>(DEFAULT_THEME_CUSTOMIZATIONS)
  const [draftCustomizations, setDraftCustomizations] = useState<ThemeCustomizations>(DEFAULT_THEME_CUSTOMIZATIONS)
  const [displayThemeStickers, setDisplayThemeStickers] = useState<string[]>(() => STICKERS[DEFAULT_THEME].slice(0, 3))
  const [ambiguousInput, setAmbiguousInput] = useState<ParsedInput | null>(null)
  const [ambiguityEditMode, setAmbiguityEditMode] = useState<'shopping' | 'purchase' | null>(null)
  const [savingAmbiguity, setSavingAmbiguity] = useState(false)
  const [ambiguityDraftLines, setAmbiguityDraftLines] = useState<ParsedLine[]>([])

  const [duePrompt, setDuePrompt] = useState<{ title: string } | null>(null)
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('')
  const [dueReminderOption, setDueReminderOption] = useState<ReminderOptionId>('1d')
  /** Which preset produced dueDate. Drives the date picker's minimum. */
  const [dueDatePreset, setDueDatePreset] = useState<'today' | 'tomorrow' | 'custom'>('custom')
  /**
   * True once the user has picked a chip by hand. While it is false the time
   * control may still re-seed the default lead time (adding a time tightens it to
   * 1 hour), but once it is true the choice is the user's and is never overwritten.
   */
  const [dueReminderTouched, setDueReminderTouched] = useState(false)
  const [dueCustomAmount, setDueCustomAmount] = useState('')
  const [dueCustomUnit, setDueCustomUnit] = useState<ReminderUnit>('minutes')
  const [dueCustomError, setDueCustomError] = useState<string | null>(null)

  // Recomputed each render rather than memoised: "today" moves at midnight, and
  // a stale floor would keep offering a date that has just become the past.
  const dueToday = localISODate(new Date())
  const dueTomorrow = tomorrowISO()
  const dueDateMin = minDueDateForPreset(dueDatePreset, dueToday, dueTomorrow)

  /** Applies a date preset and re-floors the picker and the stored value together. */
  function chooseDuePreset(preset: 'today' | 'tomorrow' | 'custom') {
    const min = minDueDateForPreset(preset, dueToday, dueTomorrow)
    setDueDatePreset(preset)
    if (preset === 'today') setDueDate(dueToday)
    else if (preset === 'tomorrow') setDueDate(dueTomorrow)
    // Choosing a custom date keeps the current value when it is still legal and
    // otherwise snaps to the new floor, so an invalid date is never left behind.
    else setDueDate(current => clampDueDate(current || min, min))
  }

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

  // Direct entry fields. These bypass the parser entirely and always target one
  // entity, each category having its own manual form.
  const [directTaskTitle, setDirectTaskTitle] = useState('')
  const [directShopName, setDirectShopName] = useState('')
  const [directShopQty, setDirectShopQty] = useState('')
  const [directShopUnit, setDirectShopUnit] = useState('')
  const [directPurchaseName, setDirectPurchaseName] = useState('')
  const [directPurchaseQty, setDirectPurchaseQty] = useState('')
  const [directPurchaseUnit, setDirectPurchaseUnit] = useState('')
  const [directPurchasePrice, setDirectPurchasePrice] = useState('')
  // Only one category form is open at a time; null keeps all three collapsed.
  const [expandedAdd, setExpandedAdd] = useState<'task' | 'shopping' | 'purchase' | null>(null)
  const [debtAddOpen, setDebtAddOpen] = useState(false)

  // null until the capability probe resolves, so the Speak button is not
  // disabled during the check itself.
  const dueTimeRef = useRef<HTMLInputElement | null>(null)
  const ambiguitySaveLockRef = useRef(false)

const [remindersEnabled, setRemindersEnabled] = useState(false)
   const [remindersBusy, setRemindersBusy] = useState(false)
   const [remindersMessage, setRemindersMessage] = useState('')
   const [remindersMessageIsError, setRemindersMessageIsError] = useState(false)
   const remindersToggleRef = useRef<HTMLDivElement | null>(null)
   const focusRemindersRef = useRef(false)

   useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Render from local IndexedDB immediately; cloud work happens in the background.
        const [localTasks, localShopping, localPurchases, localDebts, saved, savedTheme, savedColor, savedCustomizations] = await Promise.all([
          db.tasks.toArray(),
          db.shopping.toArray(),
          db.purchases.toArray(),
          db.debts.toArray(),
          getLocalName(),
          getLocalTheme(),
          getLocalThemeColor(),
          getLocalThemeCustomizations<ThemeCustomizations>(),
        ])
        if (cancelled) return
        setTasks(visible(localTasks))
        setShopping(visible(localShopping))
        setPurchases(visible(localPurchases))
        setDebts(visible(localDebts))
        setName(saved)
        setSettingsName(saved)
        if (isThemeId(savedTheme)) setTheme(savedTheme)
        if (isThemeColorId(savedColor)) setThemeColor(savedColor)
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
            setDebts(synced.debts)
            setStatus('Synced · offline ready')
            setFlaggedItems(await getFlaggedOutboxItems())
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
    }
  }, [])

  // Runs after the settings modal is mounted so the control exists before it is
  // scrolled to. The flag is cleared first so a later manual open does not
  // re-scroll.
  useEffect(() => {
    if (!settingsOpen || !focusRemindersRef.current) return
    focusRemindersRef.current = false
    remindersToggleRef.current?.scrollIntoView({ block: 'center' })
  }, [settingsOpen])

  useEffect(() => {
    const handleOnline = async () => {
      try {
        const synced = await syncAll()
        setTasks(synced.tasks)
        setShopping(synced.shoppingItems)
        setPurchases(synced.purchases)
        setDebts(synced.debts)
        setStatus('Synced · offline ready')
        setFlaggedItems(await getFlaggedOutboxItems())
      } catch {
        setStatus('Online · sync retry pending')
      }
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  // Watch the outbox so a write the server refused is surfaced instead of
  // retrying forever in the background. Polled rather than pushed because
  // Dexie has no cross-context change notification.
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const items = await getFlaggedOutboxItems()
        if (!cancelled) setFlaggedItems(items)
      } catch {
        // Non-blocking: a failed poll just means the pill updates next tick.
      }
    }
    void refresh()
    const id = window.setInterval(() => void refresh(), 15_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  async function handleRetryItem(id: number) {
    await retryOutboxItem(id)
    setFlaggedItems(await getFlaggedOutboxItems())
    setStatus('Retrying that change…')
  }

  async function handleDiscardItem(id: number) {
    await discardOutboxItem(id)
    setFlaggedItems(await getFlaggedOutboxItems())
  }



  useEffect(() => {
    document.documentElement.dataset.theme = theme
    void setLocalTheme(theme)
  }, [theme])

  // Colour only drives the palette. The sticker pack is keyed on `theme` alone,
  // so changing colour can never change artwork.
  useEffect(() => {
    document.documentElement.dataset.color = themeColor
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null
    if (meta) meta.content = colorSwatch(theme, themeColor)
    void setLocalThemeColor(themeColor)
  }, [theme, themeColor])

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
  // Defensive: state is normally already stripped of tombstones, but counts
  // must never include a soft-deleted record even if one slips through.
  const liveTasks = useMemo(() => visible(tasks), [tasks])
  const liveShopping = useMemo(() => visible(shopping), [shopping])
  const livePurchases = useMemo(() => visible(purchases), [purchases])
  const liveDebts = useMemo(() => visible(debts), [debts])
  const debtRemainingOwe = useMemo(() => liveDebts.filter(d => d.direction === 'owe').reduce((s,d)=>s+remainingCents(d),0), [liveDebts])
  const debtRemainingOwed = useMemo(() => liveDebts.filter(d => d.direction === 'owed_to_me').reduce((s,d)=>s+remainingCents(d),0), [liveDebts])
  const selectedDebt = selectedDebtId ? liveDebts.find(d => d.id === selectedDebtId) ?? null : null
  const todayCount = liveTasks.filter(t => !t.isCompleted && (!t.dueDate || t.dueDate === todayISO())).length
  const purchaseTotal = livePurchases.reduce((sum, purchase) => sum + (purchase.price ?? 0), 0)
  const pricedPurchaseCount = livePurchases.filter(p => p.price != null).length

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
    setThemeColor(draftThemeColor)
    setLocalName(clean)
    setName(clean)
    setLocalTheme(draftTheme)
    setLocalThemeColor(draftThemeColor)
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

  function openSettings(focusReminders = false) {
    setSettingsName(name)
    setDraftTheme(theme)
    setDraftThemeColor(themeColor)
    setDraftCustomizations(normalizeThemeCustomizations(themeCustomizations))
    setColorPickerStep('animal')
    focusRemindersRef.current = focusReminders
    setSettingsOpen(true)
  }

  // The bell reports state; it no longer changes delivery on its own. It opens
  // Settings with the Phone reminders control in view instead.
  function openRemindersSettings() {
    openSettings(true)
  }

  const HOME_SCREEN_HINT = "Add Tandaan to your Home Screen to enable phone reminders. Open Tandaan from your Home Screen, then turn on Phone reminders."

  // iOS/iPadOS grants Web Push only to a web app launched from the Home Screen,
  // and a normal Safari tab hides enough of the API that pushSupported() can
  // come back false. The device is fine; the context is not.
  //
  // Display mode is genuinely feature-detected below. Deciding "is this an Apple
  // platform at all" has no non-user-agent signal, so the platform token is the
  // only honest discriminator, and it is a platform test rather than a hardcoded
  // iPhone model check. userAgentData is preferred where it exists.
  function isApplePlatform() {
    if (typeof navigator === 'undefined') return false
    const declared = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
    if (declared) return /^ios$/i.test(declared)
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
  }

  // Read per call rather than cached, since it is cheap and must not go stale
  // when the app is relaunched from the Home Screen.
  function isHomeScreenApp() {
    if (typeof window === 'undefined') return false
    if ((window.navigator as { standalone?: boolean }).standalone === true) return true
    return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
  }

  // An iOS browser tab is the one case that is fixable by the user, so it must be
  // judged before the generic unsupported path or it would be mislabelled.
  function needsHomeScreenInstall() {
    return isApplePlatform() && !isHomeScreenApp()
  }

  // Turns the notification module's internal errors into something readable.
  // Kept out of notifications.ts so that module stays free of UI strings.
  function userFacingNotificationError(error: unknown) {
    const message = error instanceof Error ? error.message : ''

    // A missing VAPID key or Supabase config is a deployment problem, so it is
    // checked first and never gets reported as an incompatible device.
    if (/not configured/i.test(message)) return 'Phone reminders are not set up on this build yet.'
    if (error instanceof PushStageError) {
      // Each step of activation reports where it stopped, so a failure names
      // the actual cause instead of collapsing into one generic message.
      switch (error.stage) {
        case 'permission':
          return 'Notifications are blocked. Enable them in your browser/device settings.'
        case 'subscription':
          return error.message === 'The browser refused to remove the push subscription.'
            ? error.message
            : 'Could not create the phone notification subscription.'
        case 'application-server-key':
        case 'config':
          return 'Phone reminders are not set up on this build yet.'
        case 'auth':
          // The auth stage now carries the real reason (network,
          // sign-in rejected), so it is shown rather than a generic failure.
          return error.message
        case 'service-worker':
          return 'Tandaan is still starting up on this device. Try turning phone reminders on again.'
        case 'register':
          return error.message.startsWith('Could not remove')
            ? error.message
            : 'Could not register this phone for reminders.'
        case 'environment':
          break
      }
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      return 'Notifications are blocked. Enable them in your browser/device settings.'
    }
    if (needsHomeScreenInstall()) return HOME_SCREEN_HINT
    if (!pushSupported()) return "Phone notifications aren't supported on this device."
    if (/No signed-in/i.test(message)) return 'Sign in to Tandaan before turning on phone reminders.'
    if (/incomplete push subscription/i.test(message)) return 'This browser returned an incomplete push subscription.'
    if (/refused to remove/i.test(message)) return 'The browser refused to remove the push subscription.'
    return message || 'Could not update phone reminders.'
  }

  // Settings is the only place that changes delivery. Scheduling a task
  // reminder and allowing this phone to receive push are independent: nothing
  // here subscribes the phone, and no task save subscribes it either.
  async function toggleReminders() {
    if (remindersBusy) return
    setRemindersMessage('')

    if (remindersEnabled) {
      setRemindersBusy(true)
      try {
        await disablePushNotifications()
        setRemindersEnabled(false)
        setRemindersMessageIsError(false)
        setRemindersMessage('Phone reminders are off. Your scheduled task reminders are unchanged.')
      } catch (error) {
        setRemindersMessageIsError(true)
        setRemindersMessage(userFacingNotificationError(error))
      } finally {
        setRemindersBusy(false)
      }
      return
    }

    setRemindersBusy(true)
    try {
      await enablePushNotifications()
      setRemindersEnabled(true)
      setRemindersMessageIsError(false)
      setRemindersMessage('Phone reminders are on.')
    } catch (error) {
      setRemindersMessageIsError(true)
      setRemindersMessage(userFacingNotificationError(error))
    } finally {
      setRemindersBusy(false)
    }
  }


  async function persistDebt(debt: Debt, message = 'Debt saved') {
    await db.debts.put(debt)
    await queueDebtUpsert(debt)
    setDebts(prev => prev.some(d => d.id === debt.id) ? prev.map(d => d.id === debt.id ? debt : d) : [debt, ...prev])
    setStatus(message + ' · saved on this phone')
    void syncNow(message)
  }

  function openDebtList() { setDebtPage('list'); setSelectedDebtId(null) }
  function openDebtDetail(id: string) { setSelectedDebtId(id); setDebtPage('detail'); setPaymentAmount(''); setPaymentNote('') }

  async function addDebt() {
    const person = debtPerson.trim()
    const amountCents = parseAmountToCents(debtAmount)
    if (!person || amountCents == null) return
    const now = new Date().toISOString()
    const dueDate = debtDueDate || null
    const reminderAt = debtReminder && dueDate ? new Date(`${dueDate}T09:00:00`).toISOString() : null
    const debt: Debt = { id: newId(), direction: debtDirection, personName: person, description: debtDescription.trim() || null, originalAmountCents: amountCents, dueDate, reminderEnabled: Boolean(debtReminder && dueDate), reminderMinutesBefore: debtReminder && dueDate ? 1440 : null, reminderAt, reminderSentAt: null, payments: [], notes: null, createdAt: now, updatedAt: now }
    await persistDebt(debt, 'Debt added')
    setDebtPerson(''); setDebtAmount(''); setDebtDescription(''); setDebtDueDate(''); setDebtReminder(true); setDebtAddOpen(false)
  }

  async function addDebtPayment(debt: Debt) {
    const amountCents = parseAmountToCents(paymentAmount)
    if (amountCents == null) return
    const remaining = remainingCents(debt)
    if (amountCents > remaining) return
    const payment: DebtPayment = makeDebtPayment(amountCents, new Date().toISOString(), null, paymentNote.trim() || null)
    const updated: Debt = { ...debt, payments: [...debt.payments, payment], reminderEnabled: remaining - amountCents > 0 ? debt.reminderEnabled : false, reminderAt: remaining - amountCents > 0 ? debt.reminderAt : null, reminderSentAt: remaining - amountCents > 0 ? debt.reminderSentAt : null, updatedAt: new Date().toISOString() }
    await persistDebt(updated, remaining - amountCents === 0 ? 'Debt fully paid' : 'Payment added')
    setPaymentAmount(''); setPaymentNote('')
  }

  async function markDebtPaid(debt: Debt) {
    const remaining = remainingCents(debt)
    if (remaining === 0) return
    const payment = makeDebtPayment(remaining, new Date().toISOString(), null, 'Marked as paid')
    await persistDebt({ ...debt, payments: [...debt.payments, payment], reminderEnabled: false, reminderAt: null, reminderSentAt: null, updatedAt: new Date().toISOString() }, 'Debt fully paid')
  }

  async function deleteDebt(debt: Debt) {
    await db.debts.put({ ...debt, deletedAt: new Date().toISOString() })
    await queueDebtDelete(debt.id)
    setDebts(prev => prev.filter(d => d.id !== debt.id))
    openDebtList()
    await syncNow('Debt deleted')
  }

  const filteredDebts = useMemo(() => {
    const today = todayISO()
    return liveDebts.filter(d => {
      const status = debtStatus(d, today)
      const matchFilter = debtFilter === 'all' || debtFilter === d.direction || debtFilter === 'paid' && status === 'paid' || debtFilter === 'overdue' && status === 'overdue'
      const q = debtSearch.trim().toLowerCase()
      return matchFilter && (!q || d.personName.toLowerCase().includes(q) || (d.description ?? '').toLowerCase().includes(q))
    }).sort((a,b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31'))
  })

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

  // Direct entry: no parsing, no intent guessing. Each handler targets exactly
  // one entity and reuses the existing persist helpers so the outbox, sync and
  // local-first ordering stay identical to every other write path. Each one
  // closes its own form afterwards, leaving the row itself untouched.
  // Saving from the Add task row opens the existing due flow first, so the task
  // is never written without the user seeing its schedule. The title is only
  // cleared once persistTask has actually run in saveDueChoice, so a cancelled
  // modal leaves the typed title intact.
  function addTaskDirect() {
    const title = directTaskTitle.trim()
    if (!title) return
    resetDueForm()
    setDuePrompt({ title })
  }

  /** Returns every due-modal field to its opening state. */
  function resetDueForm() {
    setDueDate('')
    setDueTime('')
    setDueDatePreset('custom')
    setDueReminderOption(defaultReminderOption(''))
    setDueReminderTouched(false)
    setDueCustomAmount('')
    setDueCustomUnit('minutes')
    setDueCustomError(null)
  }

  async function addShoppingDirect() {
    const name = directShopName.trim()
    if (!name) return
    const now = new Date().toISOString()
    const item: ShoppingItem = { id: newId(), name, quantity: directShopQty === '' ? null : Number(directShopQty), unit: directShopUnit.trim() || null, expectedPrice: null, isPurchased: false, createdAt: now, updatedAt: now }
    await persistShopping(item, 'Shopping item added')
    setDirectShopName('')
    setDirectShopQty('')
    setDirectShopUnit('')
    setExpandedAdd(null)
  }

  async function addPurchaseDirect() {
    const name = directPurchaseName.trim()
    if (!name) return
    const now = new Date().toISOString()
    const item: Purchase = { id: newId(), itemName: name, quantity: directPurchaseQty === '' ? null : Number(directPurchaseQty), unit: directPurchaseUnit.trim() || null, price: directPurchasePrice === '' ? null : Number(directPurchasePrice), currency: 'PHP', purchasedAt: now, notes: null, createdAt: now, updatedAt: now }
    await persistPurchase(item, 'Purchase added')
    setDirectPurchaseName('')
    setDirectPurchaseQty('')
    setDirectPurchaseUnit('')
    setDirectPurchasePrice('')
    setExpandedAdd(null)
  }

  async function saveParsed(parsed: ParsedInput, forcedIntent?: 'task' | 'shopping' | 'purchase') {
    if (parsed.ambiguous && !forcedIntent) {
      setAmbiguousInput(parsed)
      return false
    }
    const resolvedIntent = forcedIntent ?? parsed.intent

    if (resolvedIntent === 'task') {
      const title = parsed.title || parsed.original
      if (parsed.dueDate) {
        const task = taskWithReminder(title, parsed.dueDate, parsed.dueTime ?? null)
        await persistTask(task, 'Task saved')
      } else {
        setDuePrompt({ title })
        resetDueForm()
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
      setShopping(visible(await db.shopping.toArray()))
      await syncNow('Shopping saved')
      return true
    }

    if (resolvedIntent === 'purchase' && parsed.purchases?.length) {
      for (const entry of parsed.purchases) {
        const purchase: Purchase = { id: newId(), itemName: entry.itemName, quantity: entry.quantity ?? null, unit: entry.unit ?? null, price: entry.price ?? null, currency: 'PHP', purchasedAt: new Date().toISOString(), notes: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        await db.purchases.put(purchase)
        await queueUpsert('purchase', purchase)
      }
      setPurchases(visible(await db.purchases.toArray()))
      await syncNow('Purchases saved')
      return true
    }

    return true
  }

  // Single write path for the due modal: builds the task with the existing
  // reminder logic, persists it once, then closes and resets. Scheduling a
  // reminder here never touches the phone's push subscription.
  async function saveDueChoice(mode: 'dated' | 'none') {
    if (!duePrompt) return
    const title = duePrompt.title

    // Validate before anything is written. A rejected custom value leaves the
    // modal open and the typed title intact, so the user can correct it rather
    // than lose the task.
    let customMinutes: number | null = null
    if (mode === 'dated' && dueReminderOption === 'custom') {
      const problem = validateCustomReminder(Number(dueCustomAmount), dueCustomUnit)
      if (problem) {
        setDueCustomError(problem)
        return
      }
      customMinutes = toMinutes(Number(dueCustomAmount), dueCustomUnit)
      setDueCustomError(null)
    }

    if (mode === 'none') {
      const task = taskWithReminder(title, null, null)
      await persistTask(task, 'Task saved')
    } else {
      const nextDate = dueDate || null
      const nextTime = nextDate && dueTime ? dueTime : null
      if (!nextDate) return
      const task = taskWithReminder(title, nextDate, nextTime, dueReminderOption, customMinutes)
      await persistTask(task, 'Task saved')
    }

    setDuePrompt(null)
    resetDueForm()
    setDirectTaskTitle('')
    setExpandedAdd(null)
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
      // Reminder choice is preserved across edits: when only the title changes the
    // existing reminderAt/minutes are kept verbatim. If the date or time moves,
    // re-anchor the reminder using the offset the task already had. 'none' is
    // distinguishable because reminderMinutesBefore is null in that case.
    const keepMinutes = editingTask.reminderMinutesBefore ?? 1440
    const reminderEnabled = Boolean(nextDate) && editingTask.reminderEnabled && keepMinutes > 0
    const updated: Task = {
      ...editingTask,
      title: editTitle.trim() || editingTask.title,
      dueDate: nextDate,
      dueTime: nextTime,
      reminderEnabled,
      reminderMinutesBefore: reminderEnabled ? keepMinutes : null,
      reminderAt: reminderEnabled ? (dateChanged ? calculateReminderAt(nextDate, nextTime, keepMinutes) : (editingTask.reminderAt ?? calculateReminderAt(nextDate, nextTime, keepMinutes))) : null,
      reminderSentAt: dateChanged ? null : (editingTask.reminderSentAt ?? null),
      updatedAt: new Date().toISOString()
    }
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
    // Soft delete locally: keep a tombstone so a failed remote delete can't
    // resurrect the task on this device. purgeLocalTombstones drops it later.
    await db.tasks.put({ ...task, deletedAt: new Date().toISOString() })
    await queueTaskDelete(task.id)
    setTasks(prev => prev.filter(t => t.id !== task.id))
    await syncNow('Task deleted')
  }

  async function deleteShopping(item: ShoppingItem) {
    await db.shopping.put({ ...item, deletedAt: new Date().toISOString() })
    await queueDelete('shopping', item.id)
    setShopping(prev => prev.filter(i => i.id !== item.id))
    await syncNow('Shopping item deleted')
  }

  async function deletePurchase(item: Purchase) {
    await db.purchases.put({ ...item, deletedAt: new Date().toISOString() })
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

  async function chooseAmbiguousIntent(intent: 'shopping' | 'purchase') {
    if (!ambiguousInput || ambiguitySaveLockRef.current) return
    ambiguitySaveLockRef.current = true
    setSavingAmbiguity(true)
    const pending = ambiguousInput
    setAmbiguousInput(null)
    setAmbiguityEditMode(null)
    setAmbiguityDraftLines([])
    try {
      await saveParsed(pending, intent)
    } finally {
      ambiguitySaveLockRef.current = false
      setSavingAmbiguity(false)
    }
  }

  function beginAmbiguityEdit(intent: 'shopping' | 'purchase') {
    if (!ambiguousInput) return
    const source = intent === 'shopping'
      ? (ambiguousInput.shoppingItems?.length ? ambiguousInput.shoppingItems : ambiguousInput.shopping ? [ambiguousInput.shopping] : [])
      : (ambiguousInput.purchases ?? [])
    setAmbiguityEditMode(intent)
    setAmbiguityDraftLines(source.map(line => ({ ...line })))
  }

  function updateAmbiguityLine(index: number, patch: Partial<ParsedLine>) {
    setAmbiguityDraftLines(lines => lines.map((line, i) => i === index ? { ...line, ...patch } : line))
  }

  function addAmbiguityLine() {
    setAmbiguityDraftLines(lines => [...lines, { itemName: '', quantity: 1, unit: 'pcs', price: null }])
  }

  function removeAmbiguityLine(index: number) {
    setAmbiguityDraftLines(lines => lines.filter((_, i) => i !== index))
  }

  async function saveAmbiguityEdits() {
    if (!ambiguousInput || !ambiguityEditMode) return
    const cleaned = ambiguityDraftLines
      .map(line => ({
        ...line,
        itemName: line.itemName.trim(),
        quantity: line.quantity == null || Number.isNaN(Number(line.quantity)) ? null : Number(line.quantity),
        unit: line.unit?.trim() || null,
        price: ambiguityEditMode === 'purchase' && line.price != null && !Number.isNaN(Number(line.price)) ? Number(line.price) : null,
      }))
    if (!cleaned.length || cleaned.some(line => !line.itemName)) return
    const edited: ParsedInput = ambiguityEditMode === 'shopping'
      ? { ...ambiguousInput, intent: 'shopping', shoppingItems: cleaned, shopping: cleaned[0], ambiguous: undefined }
      : { ...ambiguousInput, intent: 'purchase', purchases: cleaned, ambiguous: undefined }
    await saveParsed(edited, ambiguityEditMode)
    setAmbiguousInput(null)
    setAmbiguityEditMode(null)
    setAmbiguityDraftLines([])
  }

  if (!profileReady) return <div className="boot">Loading Tandaan…</div>

  if (!name) {
    return (
      <main className="onboarding" style={{ gap: 10 }}>
        <TandaanLogo size={76} />
        <div className="brand">Tandaan</div>
        <p style={{ margin: '-2px 0 4px' }}>Your offline-first everyday memory.</p>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="onboarding-name">Your name</label>
          <input id="onboarding-name" autoFocus value={draftName} onChange={e => setDraftName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') completeOnboarding() }} placeholder="e.g. Daisy" />
        </div>
        <button className="primary" onClick={completeOnboarding} disabled={!draftName.trim()} style={{ width: '100%' }}>Continue</button>
     </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-row"><TandaanLogo size={44} /><div><div className="brand">Tandaan</div><div className="sync-status">{status}</div></div></div>
        <div className="header-actions">
          {flaggedItems.length > 0 && <button className="sync-warning" onClick={() => setFlaggedOpen(true)} title="Some changes could not be synced">{flaggedItems.length} failed to sync</button>}
          <button className={remindersEnabled ? 'icon-btn active' : 'icon-btn'} onClick={openRemindersSettings} aria-label={remindersEnabled ? 'Phone reminders enabled. Open settings' : 'Phone reminders off. Open settings'} title={remindersEnabled ? 'Phone reminders enabled' : 'Phone reminders off'}>{remindersEnabled ? <BellRing size={18} /> : <Bell size={18} />}</button>
          <button className="icon-btn" onClick={() => openSettings()} aria-label="My profile and settings" title="My profile and settings"><Settings size={18} /></button>
        </div>
      </header>

      {debtPage !== 'home' && (
        <DebtView
          debts={filteredDebts}
          allDebts={liveDebts}
          filter={debtFilter}
          search={debtSearch}
          addOpen={debtAddOpen}
          direction={debtDirection}
          person={debtPerson}
          amount={debtAmount}
          description={debtDescription}
          dueDate={debtDueDate}
          reminder={debtReminder}
          selected={selectedDebt}
          paymentAmount={paymentAmount}
          paymentNote={paymentNote}
          setFilter={setDebtFilter}
          setSearch={setDebtSearch}
          setAddOpen={setDebtAddOpen}
          setDirection={setDebtDirection}
          setPerson={setDebtPerson}
          setAmount={setDebtAmount}
          setDescription={setDebtDescription}
          setDueDate={setDebtDueDate}
          setReminder={setDebtReminder}
          setPaymentAmount={setPaymentAmount}
          setPaymentNote={setPaymentNote}
          onAdd={() => void addDebt()}
          onOpen={openDebtDetail}
          onBack={openDebtList}
          onPayment={() => selectedDebt && void addDebtPayment(selectedDebt)}
          onMarkPaid={() => selectedDebt && void markDebtPaid(selectedDebt)}
          onDelete={() => selectedDebt && void deleteDebt(selectedDebt)}
        />
      )}
      <button className="debt-home-summary card" onClick={openDebtList}>
        <span><HandCoins size={18}/> Debt / Utang</span>
        <strong>{formatDebtMoney(debtRemainingOwe + debtRemainingOwed)}</strong>
        <small>{formatDebtMoney(debtRemainingOwe)} I owe · {formatDebtMoney(debtRemainingOwed)} owed to me</small>
      </button>

      <section className="hero">
        <h1>{greeting}, {name}</h1>
        <p>{todayCount === 0 ? 'You are all caught up.' : `You have ${todayCount} task${todayCount === 1 ? '' : 's'} to keep in sight today.`}</p>
        <div className="summary-grid">
          <div className="summary-card card"><span>Today</span><strong>{todayCount}</strong><small>open tasks</small>{displayThemeStickers[0] && <img className="summary-card-sticker sticker-a" src={stickerUrl(theme, displayThemeStickers[0])} alt="" aria-hidden="true" />}</div>
          <div className="summary-card card"><span>Shopping</span><strong>{liveShopping.filter(i => !i.isPurchased).length}</strong><small>to buy</small>{displayThemeStickers[1] && <img className="summary-card-sticker sticker-b" src={stickerUrl(theme, displayThemeStickers[1])} alt="" aria-hidden="true" />}</div>
          <div className="summary-card card"><span>Purchases</span><strong>{money(purchaseTotal)}</strong><small>{purchases.length} recorded</small>{displayThemeStickers[2] && <img className="summary-card-sticker sticker-c" src={stickerUrl(theme, displayThemeStickers[2])} alt="" aria-hidden="true" />}</div>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading"><h2>Today</h2><span>{tasks.length} total</span></div>
        <div className="direct-add">
          <button type="button" className="direct-add-row" onClick={() => setExpandedAdd(expandedAdd === 'task' ? null : 'task')} aria-expanded={expandedAdd === 'task'} aria-label="Add a task">
            <span>Add a task</span><Plus size={17} />
          </button>
          {expandedAdd === 'task' && (
<div className="direct-add-fields direct-add-task-fields">
            <input value={directTaskTitle} onChange={e => setDirectTaskTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addTaskDirect() }} placeholder="Task title" aria-label="Task title" autoFocus />
              <button className="direct-add-btn" onClick={() => void addTaskDirect()} disabled={!directTaskTitle.trim()} aria-label="Save task"><Check size={17} /></button>
            </div>
          )}
        </div>
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
        <div className="section-heading"><h2>Shopping</h2><span>{liveShopping.filter(i => !i.isPurchased).length} remaining</span></div>
        <div className="direct-add">
          <button type="button" className="direct-add-row" onClick={() => setExpandedAdd(expandedAdd === 'shopping' ? null : 'shopping')} aria-expanded={expandedAdd === 'shopping'} aria-label="Add a shopping item">
            <span>Add an item</span><Plus size={17} />
          </button>
          {expandedAdd === 'shopping' && (
            <div className="direct-add-fields">
              <input className="grow" value={directShopName} onChange={e => setDirectShopName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addShoppingDirect() }} placeholder="Item" aria-label="Shopping item" autoFocus />
              <input className="num" type="number" min="0" step="any" value={directShopQty} onChange={e => setDirectShopQty(e.target.value)} placeholder="Qty" aria-label="Quantity" />
              <input className="unit" value={directShopUnit} onChange={e => setDirectShopUnit(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addShoppingDirect() }} placeholder="Unit" aria-label="Unit" />
              <button className="direct-add-btn" onClick={() => void addShoppingDirect()} disabled={!directShopName.trim()} aria-label="Save shopping item"><Check size={17} /></button>
            </div>
          )}
        </div>
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
        <div className="direct-add">
          <button type="button" className="direct-add-row" onClick={() => setExpandedAdd(expandedAdd === 'purchase' ? null : 'purchase')} aria-expanded={expandedAdd === 'purchase'} aria-label="Add a purchase">
            <span>Add a purchase</span><Plus size={17} />
          </button>
          {expandedAdd === 'purchase' && (
            <div className="direct-add-fields">
              <input className="grow" value={directPurchaseName} onChange={e => setDirectPurchaseName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addPurchaseDirect() }} placeholder="Item" aria-label="Purchase item" autoFocus />
              <input className="num" type="number" min="0" step="any" value={directPurchaseQty} onChange={e => setDirectPurchaseQty(e.target.value)} placeholder="Qty" aria-label="Quantity" />
              <input className="unit" value={directPurchaseUnit} onChange={e => setDirectPurchaseUnit(e.target.value)} placeholder="Unit" aria-label="Unit" />
              <input className="num price" type="number" min="0" step="0.01" value={directPurchasePrice} onChange={e => setDirectPurchasePrice(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addPurchaseDirect() }} placeholder="Price" aria-label="Price" />
              <button className="direct-add-btn" onClick={() => void addPurchaseDirect()} disabled={!directPurchaseName.trim()} aria-label="Save purchase"><Check size={17} /></button>
            </div>
          )}
        </div>
        <div className="task-list">
          {purchases.length > 0 && purchases.map(item => (
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
            <div className="modal-header">
              <div><strong>{ambiguityEditMode ? `Edit ${ambiguityEditMode === 'shopping' ? 'shopping list' : 'purchase list'}` : 'What did you mean?'}</strong><div className="modal-subtitle">{ambiguityEditMode ? 'Review each item before saving.' : ambiguousInput.ambiguous?.reason}</div></div>
              <button className="icon-btn" onClick={() => { setAmbiguousInput(null); setAmbiguityEditMode(null); setAmbiguityDraftLines([]) }} aria-label="Close"><X /></button>
            </div>

            {!ambiguityEditMode ? (
              <>
                <div className="review-block">
                  <div className="review-label">Shortcut input</div>
                  <div className="ambiguity-text">{ambiguousInput.original}</div>
                  {(ambiguousInput.ambiguous?.options ?? ['shopping', 'purchase']).map(option => {
                    const title = option === 'shopping' ? 'Shopping list' : 'Purchase'
                    const detail = option === 'shopping'
                      ? ((ambiguousInput.shoppingItems ?? [ambiguousInput.shopping]).filter(Boolean).map(item => `${item?.itemName}${item?.quantity != null ? ` · ${item.quantity} ${shortUnit(item?.unit)}` : ''}`).join(', ') || 'Items to buy')
                      : ((ambiguousInput.purchases ?? []).map(item => `${item.itemName}${item?.price != null ? ` · ${money(item.price)}` : item?.quantity != null ? ` · ${item.quantity} ${shortUnit(item.unit)}` : ''}`).join(', ') || 'Items already bought')
                    return (
                      <button key={option} className="intent-choice-card" onClick={() => void chooseAmbiguousIntent(option)} disabled={savingAmbiguity}>
                        <span><strong>{title}</strong><small>{detail}</small></span>
                        <span className="intent-add-label">{savingAmbiguity ? 'Saving…' : 'Add'}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="modal-actions ambiguity-secondary-actions"><button className="text-btn" onClick={() => { setInput(ambiguousInput.original); setAmbiguousInput(null) }}>Edit original text</button><button className="text-btn" onClick={() => setAmbiguousInput(null)}>Cancel</button></div>
              </>
            ) : (
              <>
                <div className="structured-editor-list">
                  {ambiguityDraftLines.map((line, index) => (
                    <div className="structured-editor-row" key={`${index}-${line.itemName}`}>
                      <div className="structured-editor-fields">
                        <input aria-label="Item name" placeholder="Item name" value={line.itemName} onChange={e => updateAmbiguityLine(index, { itemName: e.target.value })} />
                        <input aria-label="Quantity" type="number" min="0" step="0.001" value={line.quantity ?? ''} onChange={e => updateAmbiguityLine(index, { quantity: e.target.value === '' ? null : Number(e.target.value) })} />
                        <input aria-label="Unit" value={line.unit ?? ''} onChange={e => updateAmbiguityLine(index, { unit: e.target.value })} placeholder="pcs" />
                        {ambiguityEditMode === 'purchase' && <input aria-label="Price" type="number" min="0" step="0.01" value={line.price ?? ''} onChange={e => updateAmbiguityLine(index, { price: e.target.value === '' ? null : Number(e.target.value) })} placeholder="Price" />}
                      </div>
                      <button className="icon-btn danger-icon" onClick={() => removeAmbiguityLine(index)} aria-label={`Remove item ${index + 1}`}><X size={16} /></button>
                    </div>
                  ))}
                </div>
                <button className="secondary add-item-btn" onClick={addAmbiguityLine}><Plus size={16} /> Add item</button>
                <div className="modal-actions"><button className="secondary" onClick={() => { setAmbiguityEditMode(null); setAmbiguityDraftLines([]) }}>Back</button><button className="primary" disabled={!ambiguityDraftLines.length || ambiguityDraftLines.some(line => !line.itemName.trim())} onClick={() => void saveAmbiguityEdits()}>Save list</button></div>
              </>
            )}
          </div>
        </div>
      )}

      {duePrompt && (
        <div className="modal-backdrop">
          <div className="modal card">
            <div className="modal-header"><div><strong>When is this due?</strong><div className="modal-subtitle">{duePrompt.title}</div></div><button className="icon-btn" onClick={() => setDuePrompt(null)}><X /></button></div>
            {/* Single screen: pick a date, optionally a time, then save. No second screen, so nothing has to be navigated. */}
            <div className="due-compact">
              <span className="due-compact-label">Date</span>
              <div className="due-choice-row">
                <button type="button" className={dueDatePreset === 'today' ? 'due-choice active' : 'due-choice'} aria-pressed={dueDatePreset === 'today'} onClick={() => chooseDuePreset('today')}>Today</button>
                <button type="button" className={dueDatePreset === 'tomorrow' ? 'due-choice active' : 'due-choice'} aria-pressed={dueDatePreset === 'tomorrow'} onClick={() => chooseDuePreset('tomorrow')}>Tomorrow</button>
              </div>

              {/* Custom date. The native input carries the same floor as the
                  presets, so the OS picker greys out yesterday (and, with
                  Tomorrow active, today) instead of relying on save-time checks. */}
              <div className="due-choice-row single">
                <button type="button" className={dueDatePreset === 'custom' ? 'due-choice active' : 'due-choice'} aria-pressed={dueDatePreset === 'custom'} onClick={() => chooseDuePreset('custom')}>Choose date</button>
              </div>
              {dueDatePreset === 'custom' && (
                <input
                  className="due-date-input"
                  type="date"
                  aria-label="Due date"
                  min={dueDateMin}
                  value={dueDate}
                  onChange={e => {
                    const picked = e.target.value
                    // min on the control stops most of this, but a value can still
                    // arrive from typing or from a date that has since passed.
                    if (picked && !isDueDateAllowed(picked, dueDateMin)) { setDueDate(dueDateMin); return }
                    setDueDate(picked)
                  }}
                />
              )}

              <span className="due-compact-label">Time</span>
              <div className="due-time-wrap">
                <button type="button" className={!dueTime ? 'due-choice active' : 'due-choice'} onClick={() => { setDueTime(''); if (!dueReminderTouched) setDueReminderOption(defaultReminderOption('')) }}>No time</button>
                {/* The native time input stays mounted and transparent on top of the
                    "Set time" cell, reusing the existing overlay pattern, so tapping
                    it opens the real OS picker on iOS. */}
                <div
                  className={dueTime ? 'due-choice-cell active' : 'due-choice-cell'}
                  role="button"
                  tabIndex={0}
                  aria-label={dueTime ? 'Change due time' : 'Set due time'}
                  onClick={() => {
                    const input = dueTimeRef.current
                    if (!input) return
                    try {
                      if (typeof input.showPicker === 'function') input.showPicker()
                      else input.click()
                    } catch {
                      input.click()
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    const input = dueTimeRef.current
                    if (!input) return
                    try {
                      if (typeof input.showPicker === 'function') input.showPicker()
                      else input.click()
                    } catch {
                      input.click()
                    }
                  }}
                >
                  <span className="due-choice-label">{dueTime || 'Set time'}</span>
                  <input
                    ref={dueTimeRef}
                    className="due-time-input-overlay"
                    style={{ pointerEvents: 'none' }}
                    type="time"
                    value={dueTime}
                    aria-label="Due time"
                    onChange={e => { setDueTime(e.target.value); if (!dueReminderTouched) setDueReminderOption(defaultReminderOption(e.target.value)) }}
                  />
                </div>
              </div>

              <div className="reminder-block">
                <span className="due-compact-label">Remind me</span>
                <div className="reminder-chips">
                  {REMINDER_OPTIONS.map(option => (
                    <button key={option.id} type="button" className={dueReminderOption === option.id ? 'reminder-chip active' : 'reminder-chip'} aria-pressed={dueReminderOption === option.id} onClick={() => { setDueReminderTouched(true); setDueReminderOption(option.id); if (option.id !== 'custom') setDueCustomError(null) }}>{option.label}</button>
                  ))}
                </div>
                {dueReminderOption === 'custom' && (
                  <div className="reminder-custom">
                    <input
                      className="reminder-custom-amount"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      aria-label="Custom reminder amount"
                      placeholder="30"
                      value={dueCustomAmount}
                      onChange={e => { setDueCustomAmount(e.target.value); setDueCustomError(null) }}
                    />
                    <select className="reminder-custom-unit" aria-label="Custom reminder unit" value={dueCustomUnit} onChange={e => { setDueCustomUnit(e.target.value as ReminderUnit); setDueCustomError(null) }}>
                      {REMINDER_UNITS.map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
                    </select>
                  </div>
                )}
                {dueCustomError && <p className="reminder-error" role="alert">{dueCustomError}</p>}
              </div>

              <div className="modal-actions">
                <button className="primary full" disabled={!dueDate} onClick={() => void saveDueChoice('dated')}>Save task</button>
                <button className="text-btn full" onClick={() => void saveDueChoice('none')}>No due date</button>
              </div>
            </div>
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
              <div className="settings-section-title"><Palette size={17} /><div>
                <strong>{colorPickerStep === 'animal' ? 'Animal theme' : `${themeOption(draftTheme).name} colour`}</strong>
                <span>{colorPickerStep === 'animal'
                  ? 'Step 1 of 2 — pick an animal. Its sticker pack is included automatically.'
                  : 'Step 2 of 2 — pick a colour. Stickers and artwork stay exactly the same.'}</span>
              </div></div>

              {colorPickerStep === 'animal' ? (
                <>
                  <div className="theme-grid">
                    {THEME_OPTIONS.map(option => (
                      <button key={option.id} className={draftTheme === option.id ? 'theme-choice active' : 'theme-choice'} onClick={() => setDraftTheme(option.id)}>
                        <img className="theme-choice-sticker" src={stickerUrl(option.id, STICKERS[option.id][0])} alt="" aria-hidden="true" />
                        <span className="theme-choice-copy"><strong>{option.name}</strong><small>{option.description}</small></span>
                        {draftTheme === option.id && <CheckCircle2 size={17} />}
                      </button>
                    ))}
                  </div>
                  <button className="primary full" onClick={() => setColorPickerStep('color')}>Continue to colours</button>
                </>
              ) : (
                <>
                  <div className="color-grid">
                    {COLOR_OPTIONS.map(option => {
                      const isOriginal = option.id === 'original'
                      const swatch = isOriginal ? THEME_OPTIONS.find(t => t.id === draftTheme)?.swatch ?? '#8b5cf6' : option.swatch
                      return (
                        <button
                          key={option.id}
                          className={draftThemeColor === option.id ? 'color-choice active' : 'color-choice'}
                          onClick={() => setDraftThemeColor(option.id)}
                          aria-pressed={draftThemeColor === option.id}
                        >
                          <span className="color-swatch" style={{ background: swatch }} aria-hidden="true" />
                          <strong>{option.name}</strong>
                          {draftThemeColor === option.id && <CheckCircle2 size={15} />}
                        </button>
                      )
                    })}
                  </div>
                  <div className="color-preview" aria-hidden="true">
                    <span className="color-preview-dot" style={{ background: colorSwatch(draftTheme, draftThemeColor) }} />
                    <span className="color-preview-bar" style={{ background: colorSwatch(draftTheme, draftThemeColor) }} />
                    <span className="color-preview-bar dim" style={{ background: colorSwatch(draftTheme, draftThemeColor) }} />
                  </div>
                  <button className="secondary full" onClick={() => setColorPickerStep('animal')}>Back to animals</button>
                </>
              )}
            </section>

            <section className="settings-section">
              <div className="settings-section-title"><Palette size={17} /><div><strong>Personalize {themeOption(draftTheme).name}</strong><span>The {themeOption(draftTheme).name} sticker pack is already included. You only need to choose an optional background.</span></div></div>

              <div className="custom-theme-preview">
                {draftCustomizations.backgrounds[draftTheme] && <div className="custom-theme-preview-bg" style={{ backgroundImage: `url(\"${draftCustomizations.backgrounds[draftTheme]}\")` }} aria-hidden="true" />}
                <div className="custom-theme-preview-overlay" aria-hidden="true" />
                <div className="custom-theme-preview-copy"><strong>{themeOption(draftTheme).name}</strong><span>Sticker pack included automatically</span></div>
                <div className="custom-theme-preview-stickers" style={{ overflowX: 'auto', flexWrap: 'nowrap', width: '100%', paddingBottom: 2 }}>
                  {STICKERS[draftTheme].slice(0, 6).map(file => <img key={file} src={stickerUrl(draftTheme, file)} alt="" aria-hidden="true" />)}
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
              <div className="reminders-setting" ref={remindersToggleRef}>
                <div className="reminders-setting-copy">
                  <span className="reminders-setting-label"><Bell size={16} /> Phone reminders</span>
                  <span className="reminders-setting-hint">Get notified for scheduled task reminders</span>
                </div>
                <button
                  type="button"
                  className={`switch${remindersEnabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={remindersEnabled}
                  aria-label="Phone reminders"
                  disabled={remindersBusy}
                  onClick={() => void toggleReminders()}
                >
                  <span className="switch-knob" />
                  <span className="switch-state">{remindersBusy ? '…' : remindersEnabled ? 'On' : 'Off'}</span>
                </button>
              </div>
              {remindersMessage && (
                <div className={remindersMessageIsError ? 'inline-error' : 'reminders-message-ok'}>{remindersMessage}</div>
              )}
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

      {flaggedOpen && (
        <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setFlaggedOpen(false) }}><div className="modal card"><div className="modal-header"><strong>Changes that did not sync</strong><button className="icon-btn" onClick={() => setFlaggedOpen(false)}><X /></button></div>
          <p className="modal-note">The server refused these {MAX_RETRIES} times. Everything is still saved on this phone. Retry each one, or discard it to stop trying.</p>
          {flaggedItems.length === 0 && <p>Nothing is stuck right now.</p>}
          {flaggedItems.map(item => (
            <div className="flagged-row" key={item.id}>
              <div className="flagged-text">
                <strong>{item.operation === 'delete' ? 'Delete' : 'Save'} {item.entity === 'task' ? 'task' : item.entity === 'shopping' ? 'shopping item' : 'purchase'}</strong>
                <small>Refused {item.retryCount ?? MAX_RETRIES} time{item.retryCount === 1 ? '' : 's'}{item.lastError ? ` · ${item.lastError}` : ''}</small>
              </div>
              <div className="flagged-actions">
                {item.id !== undefined && <button className="secondary" onClick={() => void handleRetryItem(item.id!)}>Retry</button>}
                {item.id !== undefined && <button className="danger" onClick={() => void handleDiscardItem(item.id!)}>Discard</button>}
              </div>
            </div>
          ))}
        </div></div>
      )}
    </main>
  )
}

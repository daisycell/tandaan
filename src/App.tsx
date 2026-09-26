import { useEffect, useMemo, useState } from 'react'
import { CalendarPlus, Check, Circle, Clock3, Pencil, Plus, ShoppingCart, Sparkles, Trash2, X } from 'lucide-react'
import { db, getLocalName, queueDelete, queueTaskDelete, queueTaskUpsert, queueUpsert, setLocalName } from './db'
import { formatDue, greetingForHour, todayISO } from './dateUtils'
import { parseInput } from './parser'
import { supabase } from './supabase'
import { getRemoteProfile, getUserId, syncAll, syncProfile } from './sync'
import type { Purchase, ShoppingItem, Task } from './types'

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
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

export default function App() {
  const [name, setName] = useState('')
  const [draftName, setDraftName] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [shopping, setShopping] = useState<ShoppingItem[]>([])
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('Offline-first ready')
  const [profileReady, setProfileReady] = useState(false)

  const [duePrompt, setDuePrompt] = useState<{ title: string } | null>(null)
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('')

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

  useEffect(() => {
    (async () => {
      try {
        setTasks(await db.tasks.toArray())
        setShopping(await db.shopping.toArray())
        setPurchases(await db.purchases.toArray())
        const saved = await getLocalName()
        setName(saved)

        if (supabase) {
          const userId = await getUserId()
          if (userId) {
            try {
              const profile = await getRemoteProfile()
              if (profile?.display_name) {
                await setLocalName(profile.display_name)
                setName(profile.display_name)
              } else if (saved) {
                await syncProfile(saved, Intl.DateTimeFormat().resolvedOptions().timeZone)
              }
              const synced = await syncAll()
              setTasks(synced.tasks)
              setShopping(synced.shoppingItems)
              setPurchases(synced.purchases)
              setStatus('Synced · offline ready')
            } catch {
              setStatus('Offline · changes saved on this phone')
            }
          }
        }
      } catch {
        setStatus('Local storage unavailable')
      } finally {
        setProfileReady(true)
      }
    })()
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
        await syncProfile(clean, Intl.DateTimeFormat().resolvedOptions().timeZone)
        setStatus('Profile saved · synced')
      } catch {
        setStatus('Profile saved locally · sync pending')
      }
    }
  }

  async function persistTask(task: Task, message = 'Saved') {
    await db.tasks.put(task)
    await queueTaskUpsert(task)
    setTasks(prev => prev.some(t => t.id === task.id) ? prev.map(t => t.id === task.id ? task : t) : [task, ...prev])
    await syncNow(message)
  }

  async function persistShopping(item: ShoppingItem, message = 'Shopping item saved') {
    await db.shopping.put(item)
    await queueUpsert('shopping', item)
    setShopping(prev => prev.some(i => i.id === item.id) ? prev.map(i => i.id === item.id ? item : i) : [item, ...prev])
    await syncNow(message)
  }

  async function persistPurchase(item: Purchase, message = 'Purchase saved') {
    await db.purchases.put(item)
    await queueUpsert('purchase', item)
    setPurchases(prev => prev.some(i => i.id === item.id) ? prev.map(i => i.id === item.id ? item : i) : [item, ...prev])
    await syncNow(message)
  }

  async function addFromText() {
    const raw = input.trim()
    if (!raw) return
    const parsed = parseInput(raw)

    if (parsed.intent === 'task') {
      const title = parsed.title || raw
      if (parsed.dueDate) {
        const task: Task = { id: newId(), title, isCompleted: false, dueDate: parsed.dueDate, dueTime: parsed.dueTime ?? null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        await persistTask(task)
      } else {
        setDuePrompt({ title })
        setDueDate('')
        setDueTime('')
      }
      setInput('')
      return
    }

    if (parsed.intent === 'shopping' && parsed.shopping) {
      const item: ShoppingItem = { id: newId(), name: parsed.shopping.name, quantity: parsed.shopping.quantity ?? null, unit: parsed.shopping.unit ?? null, expectedPrice: parsed.shopping.expectedPrice ?? null, isPurchased: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      await persistShopping(item)
      setInput('')
      return
    }

    if (parsed.intent === 'purchase' && parsed.purchases?.length) {
      for (const entry of parsed.purchases) {
        const purchase: Purchase = { id: newId(), itemName: entry.itemName, quantity: entry.quantity ?? null, unit: entry.unit ?? null, price: entry.price ?? null, currency: 'PHP', purchasedAt: new Date().toISOString(), notes: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        await db.purchases.put(purchase)
        await queueUpsert('purchase', purchase)
      }
      const localPurchases = await db.purchases.toArray()
      setPurchases(localPurchases)
      await syncNow('Purchases saved')
      setInput('')
      return
    }

    const fallback: Task = { id: newId(), title: raw, isCompleted: false, dueDate: null, dueTime: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    setDuePrompt({ title: fallback.title })
    setInput('')
  }

  async function saveDueChoice(mode: 'today' | 'tomorrow' | 'custom' | 'none') {
    if (!duePrompt) return
    let nextDate: string | null = null
    let nextTime: string | null = null
    if (mode === 'today') nextDate = localISODate(new Date())
    if (mode === 'tomorrow') nextDate = tomorrowISO()
    if (mode === 'custom') {
      nextDate = dueDate || null
      nextTime = dueDate && dueTime ? dueTime : null
    }
    const now = new Date().toISOString()
    const task: Task = { id: newId(), title: duePrompt.title, isCompleted: false, dueDate: nextDate, dueTime: nextTime, createdAt: now, updatedAt: now }
    await persistTask(task, 'Task saved')
    setDuePrompt(null)
    setDueDate('')
    setDueTime('')
  }

  function startEditTask(task: Task) {
    setEditingTask(task)
    setEditTitle(task.title)
    setEditDueDate(task.dueDate ?? '')
    setEditDueTime(task.dueTime ?? '')
  }

  async function saveTaskEdit() {
    if (!editingTask) return
    const updated: Task = { ...editingTask, title: editTitle.trim() || editingTask.title, dueDate: editDueDate || null, dueTime: editDueDate && editDueTime ? editDueTime : null, updatedAt: new Date().toISOString() }
    await persistTask(updated, 'Task updated')
    setEditingTask(null)
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
    const updated: ShoppingItem = { ...editingShopping, name: editShoppingName.trim() || editingShopping.name, quantity: editShoppingQty ? Number(editShoppingQty) : null, unit: editShoppingUnit.trim() || null, expectedPrice: editShoppingPrice ? Number(editShoppingPrice) : null, updatedAt: new Date().toISOString() }
    await persistShopping(updated, 'Shopping item updated')
    setEditingShopping(null)
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
    const updated: Purchase = { ...editingPurchase, itemName: editPurchaseName.trim() || editingPurchase.itemName, quantity: editPurchaseQty ? Number(editPurchaseQty) : null, unit: editPurchaseUnit.trim() || null, price: editPurchasePrice ? Number(editPurchasePrice) : null, updatedAt: new Date().toISOString() }
    await persistPurchase(updated, 'Purchase updated')
    setEditingPurchase(null)
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
        <div className="brand-row"><div className="brand-mark small"><ShoppingCart size={22} /></div><div><div className="brand">Tandaan</div><div className="sync-status">{status}</div></div></div>
        <button className="icon-btn" aria-label="Reminder status"><Clock3 size={19} /></button>
      </header>

      <section className="hero">
        <h1>{greeting}, {name} 👋</h1>
        <p>{todayCount === 0 ? 'You are all caught up.' : `You have ${todayCount} task${todayCount === 1 ? '' : 's'} to keep in sight today.`}</p>
      </section>

      <section className="quick-add card">
        <div className="section-title"><div><strong>Quick Add</strong><span>Type naturally. Tandaan decides: task, shopping, or purchase.</span></div><div className="beta-pill">smart add</div></div>
        <div className="input-row">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addFromText() }} placeholder="Try: Pay electricity tomorrow at 6 PM" />
          <button className="primary add-btn" onClick={addFromText}><Plus size={18} /> Add</button>
        </div>
        <div className="quick-hints">Examples: “Buy bread” · “Rice 40” · “Egg 1 tray 400” · “Mabakal bugas kag itlog”</div>
      </section>

      <section className="section-block">
        <div className="section-heading"><h2>Today</h2><span>{tasks.length} total</span></div>
        <div className="task-list">
          {tasks.length === 0 && <div className="empty card">No tasks yet. Add one above.</div>}
          {tasks.map(task => (
            <div className="task-card card" key={task.id}>
              <button className="check-btn" onClick={() => toggleTask(task)} aria-label={task.isCompleted ? 'Mark incomplete' : 'Complete task'}>{task.isCompleted ? <Check /> : <Circle />}</button>
              <div className="task-main">
                <div className={task.isCompleted ? 'task-title completed' : 'task-title'}>{task.title}</div>
                {task.dueDate && <div className="due-line"><Clock3 size={15} /> {formatDue(task.dueDate, task.dueTime)}</div>}
              </div>
              <div className="task-actions">
                {!task.dueDate && <button className="icon-btn" onClick={() => startEditTask(task)} title="Set due date"><CalendarPlus size={17} /></button>}
                <button className="icon-btn" onClick={() => startEditTask(task)} title="Edit"><Pencil size={17} /></button>
                <button className="icon-btn danger" onClick={() => deleteTask(task)} title="Delete"><Trash2 size={17} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading"><h2>Shopping</h2><span>{shopping.filter(i => !i.isPurchased).length} remaining</span></div>
        <div className="task-list">
          {shopping.length === 0 && <div className="empty card">No shopping items yet.</div>}
          {shopping.map(item => (
            <div className="task-card card" key={item.id}>
              <button className="check-btn" onClick={() => toggleShopping(item)} aria-label={item.isPurchased ? 'Mark not bought' : 'Mark bought'}>{item.isPurchased ? <Check /> : <Circle />}</button>
              <div className="task-main">
                <div className={item.isPurchased ? 'task-title completed' : 'task-title'}>{item.name}</div>
                {(item.quantity != null || item.unit || item.expectedPrice != null) && (
                  <div className="detail-line">
                    {item.quantity != null && <span>{item.quantity} {shortUnit(item.unit)}</span>}
                    {item.expectedPrice != null && <span>{money(item.expectedPrice)}</span>}
                    {item.isPurchased && <span className="bought-pill">bought</span>}
                  </div>
                )}
              </div>
              <div className="task-actions">
                <button className="icon-btn" onClick={() => startEditShopping(item)} title="Edit shopping item"><Pencil size={17} /></button>
                <button className="icon-btn danger" onClick={() => deleteShopping(item)} title="Delete shopping item"><Trash2 size={17} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading"><h2>Purchases</h2><span>{money(purchaseTotal)}{pricedPurchaseCount < purchases.length ? ' · some prices missing' : ''}</span></div>
        <div className="purchase-total card">
          <div><span>Total purchases</span><strong>{money(purchaseTotal)}</strong></div>
          <small>{purchases.length} item{purchases.length === 1 ? '' : 's'} recorded</small>
        </div>
        <div className="task-list">
          {purchases.length === 0 && <div className="empty card">No purchases yet. Try “Rice 40” or “Egg 1 tray 400”.</div>}
          {purchases.map(item => (
            <div className="task-card card" key={item.id}>
              <div className="purchase-dot">₱</div>
              <div className="task-main">
                <div className="task-title">{item.itemName}</div>
                <div className="detail-line">
                  {item.quantity != null && <span>{item.quantity} {shortUnit(item.unit)}</span>}
                  {item.price != null ? <span>{money(item.price)}</span> : <span className="muted-pill">price not entered</span>}
                </div>
              </div>
              <div className="task-actions">
                <button className="icon-btn" onClick={() => startEditPurchase(item)} title="Edit purchase"><Pencil size={17} /></button>
                <button className="icon-btn danger" onClick={() => deletePurchase(item)} title="Delete purchase"><Trash2 size={17} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {duePrompt && (
        <div className="modal-backdrop">
          <div className="modal card">
            <div className="modal-header"><div><strong>Add task</strong><div className="modal-subtitle">{duePrompt.title}</div></div><button className="icon-btn" onClick={() => setDuePrompt(null)}><X /></button></div>
            <div className="due-prompt-large"><strong>When is this due?</strong><span>You can skip the deadline completely.</span></div>
            <div className="choice-grid">
              <button className="choice-card" onClick={() => saveDueChoice('today')}>Today</button>
              <button className="choice-card" onClick={() => saveDueChoice('tomorrow')}>Tomorrow</button>
              <button className="choice-card wide" onClick={() => saveDueChoice('none')}>No due date</button>
            </div>
            <div className="custom-due card-inner">
              <label>Choose date <span>(optional time)</span></label>
              <div className="date-time-row">
                <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
                <input aria-label="Optional time" type="time" value={dueTime} onChange={e => setDueTime(e.target.value)} disabled={!dueDate} />
              </div>
              <button className="primary full" disabled={!dueDate} onClick={() => saveDueChoice('custom')}><CalendarPlus size={17} /> Save with this date</button>
            </div>
          </div>
        </div>
      )}

      {editingTask && (
        <div className="modal-backdrop">
          <div className="modal card">
            <div className="modal-header"><strong>Edit task</strong><button className="icon-btn" onClick={() => setEditingTask(null)}><X /></button></div>
            <label>Task</label><input value={editTitle} onChange={e => setEditTitle(e.target.value)} />
            <div className="custom-due card-inner">
              <label>Due date <span>(time optional)</span></label>
              <div className="date-time-row"><input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} /><input aria-label="Optional time" type="time" value={editDueTime} onChange={e => setEditDueTime(e.target.value)} disabled={!editDueDate} /></div>
              {editDueDate && <button className="secondary full" onClick={() => { setEditDueDate(''); setEditDueTime('') }}>Remove due date</button>}
            </div>
            <div className="modal-actions"><button className="secondary" onClick={() => setEditingTask(null)}>Cancel</button><button className="primary" onClick={saveTaskEdit}>Save changes</button></div>
          </div>
        </div>
      )}

      {editingShopping && (
        <div className="modal-backdrop">
          <div className="modal card">
            <div className="modal-header"><strong>Edit shopping item</strong><button className="icon-btn" onClick={() => setEditingShopping(null)}><X /></button></div>
            <label>Item</label><input value={editShoppingName} onChange={e => setEditShoppingName(e.target.value)} />
            <div className="two-col"><div><label>Quantity</label><input type="number" min="0" step="0.001" value={editShoppingQty} onChange={e => setEditShoppingQty(e.target.value)} /></div><div><label>Unit</label><input value={editShoppingUnit} onChange={e => setEditShoppingUnit(e.target.value)} placeholder="kg, tray, pcs" /></div></div>
            <label>Expected price (optional)</label><input type="number" min="0" step="0.01" value={editShoppingPrice} onChange={e => setEditShoppingPrice(e.target.value)} />
            <div className="modal-actions"><button className="secondary" onClick={() => setEditingShopping(null)}>Cancel</button><button className="primary" onClick={saveShoppingEdit}>Save changes</button></div>
          </div>
        </div>
      )}

      {editingPurchase && (
        <div className="modal-backdrop">
          <div className="modal card">
            <div className="modal-header"><strong>Edit purchase</strong><button className="icon-btn" onClick={() => setEditingPurchase(null)}><X /></button></div>
            <label>Item</label><input value={editPurchaseName} onChange={e => setEditPurchaseName(e.target.value)} />
            <div className="two-col"><div><label>Quantity</label><input type="number" min="0" step="0.001" value={editPurchaseQty} onChange={e => setEditPurchaseQty(e.target.value)} /></div><div><label>Unit</label><input value={editPurchaseUnit} onChange={e => setEditPurchaseUnit(e.target.value)} placeholder="kg, tray, pcs" /></div></div>
            <label>Price (optional)</label><input type="number" min="0" step="0.01" value={editPurchasePrice} onChange={e => setEditPurchasePrice(e.target.value)} />
            <div className="modal-actions"><button className="secondary" onClick={() => setEditingPurchase(null)}>Cancel</button><button className="primary" onClick={savePurchaseEdit}>Save changes</button></div>
          </div>
        </div>
      )}
    </main>
  )
}

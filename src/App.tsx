import { useEffect, useMemo, useState } from 'react'
import { CalendarPlus, Check, Circle, Clock3, Pencil, Plus, ShoppingCart, Sparkles, Trash2, X } from 'lucide-react'
import { db, getLocalName, setLocalName } from './db'
import { formatDue, greetingForHour } from './dateUtils'
import { detectIntent, extractDueInfo } from './parser'
import { supabase } from './supabase'
import type { Task } from './types'

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toDbTask(task: Task, userId: string) {
  return {
    id: task.id,
    user_id: userId,
    title: task.title,
    is_completed: task.isCompleted,
    due_date: task.dueDate ?? null,
    due_time: task.dueTime ?? null,
    created_at: task.createdAt,
    updated_at: task.updatedAt
  }
}

export default function App() {
  const [name, setName] = useState('')
  const [draftName, setDraftName] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('Offline-first ready')
  const [profileReady, setProfileReady] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDueDate, setEditDueDate] = useState('')
  const [editDueTime, setEditDueTime] = useState('')
  const [duePromptId, setDuePromptId] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      const saved = await getLocalName()
      setName(saved)
      if (supabase) {
        const { data, error } = await supabase.auth.getSession()
        if (!data.session) await supabase.auth.signInAnonymously()
        if (error) setStatus('Local mode · cloud unavailable')
      } else {
        setStatus('Local mode · connect Supabase later')
      }
      setProfileReady(true)
    })()
  }, [])

  useEffect(() => {
    db.tasks.toArray().then(setTasks)
  }, [])

  const greeting = useMemo(() => greetingForHour(new Date().getHours()), [])
  const todayCount = tasks.filter(t => !t.isCompleted && (!t.dueDate || t.dueDate === new Date().toISOString().slice(0, 10))).length

  async function completeOnboarding() {
    const clean = draftName.trim()
    if (!clean) return
    await setLocalName(clean)
    setName(clean)
    if (supabase) {
      const { data } = await supabase.auth.getSession()
      if (data.session?.user) {
        await supabase.from('profiles').upsert({
          id: data.session.user.id,
          display_name: clean,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          onboarding_complete: true
        })
      }
    }
  }

  async function createTask(title: string, dueDate?: string | null, dueTime?: string | null) {
    const now = new Date().toISOString()
    const task: Task = {
      id: newId(),
      title,
      isCompleted: false,
      dueDate: dueDate ?? null,
      dueTime: dueTime ?? null,
      createdAt: now,
      updatedAt: now
    }
    await db.tasks.put(task)
    setTasks(prev => [task, ...prev])
    setStatus('Saved locally')

    if (supabase) {
      const { data } = await supabase.auth.getSession()
      const userId = data.session?.user?.id
      if (userId) {
        const { error } = await supabase.from('tasks').insert(toDbTask(task, userId))
        if (!error) setStatus('Saved · synced')
      }
    }
    return task
  }

  async function addFromText() {
    const raw = input.trim()
    if (!raw) return
    const intent = detectIntent(raw)
    if (intent === 'shopping') {
      setStatus('Shopping intent detected — shopping module comes next')
      setInput('')
      return
    }
    if (intent === 'purchase') {
      setStatus('Purchase intent detected — purchase module comes next')
      setInput('')
      return
    }
    const due = extractDueInfo(raw)
    const task = await createTask(due.cleanedTitle || raw, due.dueDate, due.dueTime)
    setInput('')
    if (!due.dueDate) setDuePromptId(task.id)
  }

  async function toggleTask(task: Task) {
    const updated = { ...task, isCompleted: !task.isCompleted, updatedAt: new Date().toISOString() }
    await db.tasks.put(updated)
    setTasks(prev => prev.map(t => t.id === task.id ? updated : t))
    if (supabase) {
      const { data } = await supabase.auth.getSession()
      const userId = data.session?.user?.id
      if (userId) await supabase.from('tasks').update({ is_completed: updated.isCompleted, updated_at: updated.updatedAt }).eq('id', updated.id).eq('user_id', userId)
    }
  }

  async function deleteTask(task: Task) {
    await db.tasks.delete(task.id)
    setTasks(prev => prev.filter(t => t.id !== task.id))
    if (supabase) {
      const { data } = await supabase.auth.getSession()
      const userId = data.session?.user?.id
      if (userId) await supabase.from('tasks').delete().eq('id', task.id).eq('user_id', userId)
    }
  }

  function startEdit(task: Task) {
    setEditingId(task.id)
    setEditTitle(task.title)
    setEditDueDate(task.dueDate ?? '')
    setEditDueTime(task.dueTime ?? '')
    setDuePromptId(null)
  }

  async function saveEdit() {
    if (!editingId) return
    const task = tasks.find(t => t.id === editingId)
    if (!task) return
    const updated = { ...task, title: editTitle.trim() || task.title, dueDate: editDueDate || null, dueTime: editDueTime || null, updatedAt: new Date().toISOString() }
    await db.tasks.put(updated)
    setTasks(prev => prev.map(t => t.id === updated.id ? updated : t))
    setEditingId(null)
    if (supabase) {
      const { data } = await supabase.auth.getSession()
      const userId = data.session?.user?.id
      if (userId) await supabase.from('tasks').update({ title: updated.title, due_date: updated.dueDate, due_time: updated.dueTime, updated_at: updated.updatedAt }).eq('id', updated.id).eq('user_id', userId)
    }
  }

  async function savePrompt(id: string, mode: 'today' | 'tomorrow' | 'none' | 'custom') {
    const task = tasks.find(t => t.id === id)
    if (!task) return
    let dueDate: string | null = null
    if (mode === 'today') dueDate = new Date().toISOString().slice(0, 10)
    if (mode === 'tomorrow') {
      const d = new Date(); d.setDate(d.getDate() + 1); dueDate = d.toISOString().slice(0, 10)
    }
    const updated = { ...task, dueDate, dueTime: null, updatedAt: new Date().toISOString() }
    await db.tasks.put(updated)
    setTasks(prev => prev.map(t => t.id === id ? updated : t))
    setDuePromptId(null)
    if (mode === 'custom') startEdit(updated)
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
        <button className="icon-btn" aria-label="Settings"><Clock3 size={19} /></button>
      </header>

      <section className="hero">
        <h1>{greeting}, {name} 👋</h1>
        <p>{todayCount === 0 ? 'You are all caught up.' : `You have ${todayCount} task${todayCount === 1 ? '' : 's'} to keep in sight today.`}</p>
      </section>

      <section className="quick-add card">
        <div className="section-title"><div><strong>Quick Add</strong><span>Type naturally. Smart routing is coming next.</span></div><div className="beta-pill">v2 foundation</div></div>
        <div className="input-row">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addFromText() }} placeholder="Try: Pay electricity tomorrow at 6 PM" />
          <button className="primary add-btn" onClick={addFromText}><Plus size={18} /> Add</button>
        </div>
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
                {duePromptId === task.id && (
                  <div className="due-prompt">
                    <strong>When is this due?</strong>
                    <div className="choice-row">
                      <button onClick={() => savePrompt(task.id, 'today')}>Today</button>
                      <button onClick={() => savePrompt(task.id, 'tomorrow')}>Tomorrow</button>
                      <button onClick={() => savePrompt(task.id, 'custom')}><CalendarPlus size={15} /> Date & time</button>
                      <button onClick={() => savePrompt(task.id, 'none')}>No due date</button>
                    </div>
                  </div>
                )}
              </div>
              <div className="task-actions">
                {!task.dueDate && <button className="icon-btn" onClick={() => startEdit(task)} title="Set due date"><CalendarPlus size={17} /></button>}
                <button className="icon-btn" onClick={() => startEdit(task)} title="Edit"><Pencil size={17} /></button>
                <button className="icon-btn danger" onClick={() => deleteTask(task)} title="Delete"><Trash2 size={17} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="coming card"><div className="coming-icon"><ShoppingCart /></div><div><strong>Shopping & Purchases</strong><p>The backend-ready tables are prepared next for this module.</p></div><X size={16} aria-hidden /> </section>

      {editingId && (
        <div className="modal-backdrop">
          <div className="modal card">
            <div className="modal-header"><strong>Edit task</strong><button className="icon-btn" onClick={() => setEditingId(null)}><X /></button></div>
            <label>Task</label><input value={editTitle} onChange={e => setEditTitle(e.target.value)} />
            <label>Due date</label><input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} />
            <label>Optional time</label><input type="time" value={editDueTime} onChange={e => setEditDueTime(e.target.value)} />
            <div className="modal-actions"><button className="secondary" onClick={() => setEditingId(null)}>Cancel</button><button className="primary" onClick={saveEdit}>Save changes</button></div>
          </div>
        </div>
      )}
    </main>
  )
}

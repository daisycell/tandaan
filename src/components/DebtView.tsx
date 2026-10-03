import { ArrowLeft, Bell, Check, HandCoins, Plus, Search, Trash2, X } from 'lucide-react'
import type { Debt, DebtDirection } from '../types'
import { debtStatus, formatDebtMoney, paidPercent, remainingCents, sortDebtPayments, totalPaidCents } from '../debt'

type Props = {
  debts: Debt[]
  allDebts: Debt[]
  filter: 'all' | 'owe' | 'owed_to_me' | 'overdue' | 'paid'
  search: string
  addOpen: boolean
  direction: DebtDirection
  person: string
  amount: string
  description: string
  dueDate: string
  reminder: boolean
  selected: Debt | null
  paymentAmount: string
  paymentNote: string
  setFilter: (v: Props['filter']) => void
  setSearch: (v: string) => void
  setAddOpen: (v: boolean) => void
  setDirection: (v: DebtDirection) => void
  setPerson: (v: string) => void
  setAmount: (v: string) => void
  setDescription: (v: string) => void
  setDueDate: (v: string) => void
  setReminder: (v: boolean) => void
  setPaymentAmount: (v: string) => void
  setPaymentNote: (v: string) => void
  onAdd: () => void
  onOpen: (id: string) => void
  onBack: () => void
  onPayment: () => void
  onMarkPaid: () => void
  onDelete: () => void
  homeMode?: boolean
  onSeeAll?: () => void
  onHome?: () => void
}

function statusLabel(status: ReturnType<typeof debtStatus>) {
  return status === 'paid' ? 'Paid' : status === 'overdue' ? 'Overdue' : status === 'partially_paid' ? 'Partially paid' : 'Active'
}

export default function DebtView(p: Props) {
  if (p.homeMode) {
    const activeDebts = p.allDebts.filter(d => remainingCents(d) > 0)
    const preview = activeDebts.slice().sort((a, b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31')).slice(0, 3)
    return <section className="section-block debt-home-section">
      <div className="section-heading"><h2>Debt</h2><span>{activeDebts.length} active</span></div>
      <div className="debt-summary-strip">
        <div><span>I owe</span><strong>{formatDebtMoney(p.allDebts.filter(d=>d.direction==='owe').reduce((s,d)=>s+remainingCents(d),0))}</strong></div>
        <div><span>Owed to me</span><strong>{formatDebtMoney(p.allDebts.filter(d=>d.direction==='owed_to_me').reduce((s,d)=>s+remainingCents(d),0))}</strong></div>
      </div>
      <div className="direct-add">
        <button type="button" className="direct-add-row" onClick={()=>p.setAddOpen(!p.addOpen)} aria-expanded={p.addOpen} aria-label="Add a debt">
          <span>Add a debt</span><Plus size={17}/>
        </button>
        {p.addOpen && <div className="debt-form">
          <div className="filter-tabs"><button className={p.direction==='owe'?'filter-tab active':'filter-tab'} onClick={()=>p.setDirection('owe')}>I owe</button><button className={p.direction==='owed_to_me'?'filter-tab active':'filter-tab'} onClick={()=>p.setDirection('owed_to_me')}>Owed to me</button></div>
          <input value={p.person} onChange={e=>p.setPerson(e.target.value)} placeholder="Person name"/>
          <input inputMode="decimal" value={p.amount} onChange={e=>p.setAmount(e.target.value)} placeholder="Amount (₱)"/>
          <input value={p.description} onChange={e=>p.setDescription(e.target.value)} placeholder="What is it for? (optional)"/>
          <input type="date" value={p.dueDate} onChange={e=>p.setDueDate(e.target.value)}/>
          <label className="debt-reminder-toggle"><input type="checkbox" checked={p.reminder} onChange={e=>p.setReminder(e.target.checked)}/> Remind me</label>
          <button className="primary full" onClick={p.onAdd} disabled={!p.person.trim() || !p.amount.trim()}><Check size={16}/> Add debt</button>
        </div>}
      </div>
      <div className="task-list">
        {preview.length === 0 ? <div className="empty card list-empty"><HandCoins size={22}/><span>No active debts.</span></div> : preview.map(d => {
          const remaining = remainingCents(d)
          const pct = paidPercent(d)
          return <button key={d.id} className="task-card card debt-home-card" onClick={()=>p.onOpen(d.id)}>
            <div className="task-main"><div className="task-title">{d.personName}</div><div className="detail-line"><span>{d.direction==='owe'?'I owe':'Owed to me'}</span><span>{formatDebtMoney(remaining)}</span></div><div className="debt-progress"><span style={{width:`${pct}%`}} /></div></div>
          </button>
        })}
      </div>
      {activeDebts.length > 3 && p.onSeeAll && <button className="summary-see-all section-see-all" onClick={p.onSeeAll}>See all</button>}
    </section>
  }
  if (p.selected) {
    const d = p.selected
    const remaining = remainingCents(d)
    const paid = totalPaidCents(d)
    const pct = paidPercent(d)
    return <section className="debt-page card">
      <div className="debt-detail-head">
        <button className="secondary debt-back" onClick={p.onBack}><ArrowLeft size={16}/> Debt</button>
        <button className="icon-btn" onClick={p.onDelete} aria-label="Delete debt"><Trash2 size={17}/></button>
      </div>
      <div className="debt-detail-title">
        <div className="debt-avatar"><HandCoins size={22}/></div>
        <div><h2>{d.personName}</h2><span>{d.direction === 'owe' ? 'I owe' : 'Owed to me'}</span></div>
      </div>
      <div className="debt-balance-card">
        <span>Remaining</span><strong>{formatDebtMoney(remaining)}</strong>
        <div className="debt-progress"><span style={{width: `${pct}%`}} /></div>
        <small>{formatDebtMoney(paid)} paid of {formatDebtMoney(d.originalAmountCents)} · {pct}%</small>
      </div>
      <div className="debt-detail-grid">
        <div><span>Status</span><strong>{statusLabel(debtStatus(d, new Date().toISOString().slice(0,10)))}</strong></div>
        <div><span>Due</span><strong>{d.dueDate ? new Date(`${d.dueDate}T00:00:00`).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'}) : 'No due date'}</strong></div>
      </div>
      {d.description && <p className="debt-description">{d.description}</p>}
      {remaining > 0 && <div className="debt-payment-box">
        <h3>Add payment</h3>
        <input inputMode="decimal" value={p.paymentAmount} onChange={e=>p.setPaymentAmount(e.target.value)} placeholder="Amount" aria-label="Payment amount"/>
        <input value={p.paymentNote} onChange={e=>p.setPaymentNote(e.target.value)} placeholder="Note (optional)" aria-label="Payment note"/>
        <button className="primary full" onClick={p.onPayment}><Check size={16}/> Add payment</button>
        <button className="secondary full" onClick={p.onMarkPaid}>Mark fully paid</button>
      </div>}
      <div className="debt-history">
        <div className="section-heading"><h3>Payment history</h3><span>{d.payments.length}</span></div>
        {d.payments.length === 0 ? <p className="debt-empty">No payments yet.</p> : sortDebtPayments(d.payments).map(x=><div className="debt-payment-row" key={x.id}><div><strong>{formatDebtMoney(x.amountCents)}</strong><span>{new Date(x.paidAt).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'})}{x.note ? ` · ${x.note}` : ''}</span></div></div>)}
      </div>
      {d.reminderEnabled && remaining > 0 && <div className="debt-reminder"><Bell size={16}/><span>Reminder scheduled for {d.dueDate ? new Date(`${d.dueDate}T00:00:00`).toLocaleDateString('en-PH',{month:'short',day:'numeric'}) : 'the due date'}.</span></div>}
    </section>
  }

  return <section className="debt-page card">
    <div className="debt-page-head">
      <div className="debt-list-title"><button className="icon-btn list-back-btn" onClick={p.onHome} aria-label="Back to Home" title="Back to Home"><ArrowLeft size={18}/></button><div><h2>Debt</h2><p>Keep balances and payments in one place.</p></div></div>
      <button className="primary" onClick={()=>p.setAddOpen(!p.addOpen)}><Plus size={16}/> Add debt</button>
    </div>
    <div className="debt-summary-strip"><div><span>I owe</span><strong>{formatDebtMoney(p.allDebts.filter(d=>d.direction==='owe').reduce((s,d)=>s+remainingCents(d),0))}</strong></div><div><span>Owed to me</span><strong>{formatDebtMoney(p.allDebts.filter(d=>d.direction==='owed_to_me').reduce((s,d)=>s+remainingCents(d),0))}</strong></div></div>
    {p.addOpen && <div className="debt-form">
      <div className="filter-tabs"><button className={p.direction==='owe'?'filter-tab active':'filter-tab'} onClick={()=>p.setDirection('owe')}>I owe</button><button className={p.direction==='owed_to_me'?'filter-tab active':'filter-tab'} onClick={()=>p.setDirection('owed_to_me')}>Owed to me</button></div>
      <input value={p.person} onChange={e=>p.setPerson(e.target.value)} placeholder="Person name"/>
      <input inputMode="decimal" value={p.amount} onChange={e=>p.setAmount(e.target.value)} placeholder="Amount (₱)"/>
      <input value={p.description} onChange={e=>p.setDescription(e.target.value)} placeholder="What is it for? (optional)"/>
      <div className="two-col"><input type="date" value={p.dueDate} onChange={e=>p.setDueDate(e.target.value)}/><label className="debt-check"><input type="checkbox" checked={p.reminder} onChange={e=>p.setReminder(e.target.checked)}/> Reminder</label></div>
      <div className="modal-actions"><button className="secondary" onClick={()=>p.setAddOpen(false)}>Cancel</button><button className="primary" onClick={p.onAdd}>Save debt</button></div>
    </div>}
    <div className="debt-toolbar"><div className="debt-search"><Search size={15}/><input value={p.search} onChange={e=>p.setSearch(e.target.value)} placeholder="Search debts"/></div><div className="filter-tabs debt-filters">
      {(['all','owe','owed_to_me','overdue','paid'] as const).map(f=><button key={f} className={p.filter===f?'filter-tab active':'filter-tab'} onClick={()=>p.setFilter(f)}>{f==='all'?'All':f==='owe'?'I owe':f==='owed_to_me'?'Owed to me':f[0].toUpperCase()+f.slice(1)}</button>)}
    </div></div>
    <div className="debt-list">
      {p.debts.length===0 && <div className="empty"><HandCoins size={24}/><strong>No debts yet.</strong><span>Add your first debt above.</span></div>}
      {p.debts.map(d=>{const rem=remainingCents(d);const pct=paidPercent(d);const st=debtStatus(d,new Date().toISOString().slice(0,10));return <button className="debt-list-card" key={d.id} onClick={()=>p.onOpen(d.id)}><div className="debt-list-main"><strong>{d.personName}</strong><span>{d.direction==='owe'?'I owe':'Owed to me'} · {statusLabel(st)}</span></div><div className="debt-list-amount"><strong>{formatDebtMoney(rem)}</strong><small>{pct}% paid</small></div><div className="debt-progress"><span style={{width:`${pct}%`}}/></div>{d.dueDate&&<small className={st==='overdue'?'debt-overdue':''}>Due {new Date(`${d.dueDate}T00:00:00`).toLocaleDateString('en-PH',{month:'short',day:'numeric'})}</small>}</button>})}
    </div>
  </section>
}

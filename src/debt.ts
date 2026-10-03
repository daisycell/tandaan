import type { Debt, DebtPayment } from './types'

export function parseAmountToCents(value: string | number): number | null {
  const raw = String(value).trim().replace(/,/g, '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

export function formatDebtMoney(cents: number): string {
  const safe = Math.max(0, Math.trunc(cents))
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
  }).format(safe / 100)
}

export function totalPaidCents(debt: Pick<Debt, 'payments'>): number {
  return debt.payments.reduce((sum, payment) => sum + Math.max(0, Math.trunc(payment.amountCents)), 0)
}

export function remainingCents(debt: Pick<Debt, 'originalAmountCents' | 'payments'>): number {
  return Math.max(0, Math.trunc(debt.originalAmountCents) - totalPaidCents(debt))
}

export function paidPercent(debt: Pick<Debt, 'originalAmountCents' | 'payments'>): number {
  if (debt.originalAmountCents <= 0) return 0
  return Math.min(100, Math.round((totalPaidCents(debt) / debt.originalAmountCents) * 100))
}

export type DebtStatus = 'active' | 'partially_paid' | 'overdue' | 'paid'

export function debtStatus(debt: Pick<Debt, 'originalAmountCents' | 'payments' | 'dueDate'>, today: string): DebtStatus {
  if (remainingCents(debt) === 0) return 'paid'
  if (debt.dueDate && debt.dueDate < today) return 'overdue'
  if (totalPaidCents(debt) > 0) return 'partially_paid'
  return 'active'
}

export function makeDebtPayment(amountCents: number, paidAt: string, method: string | null, note: string | null): DebtPayment {
  return {
    id: crypto.randomUUID(),
    amountCents: Math.trunc(amountCents),
    paidAt,
    method,
    note,
  }
}

export function sortDebtPayments(payments: DebtPayment[]): DebtPayment[] {
  return [...payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt))
}

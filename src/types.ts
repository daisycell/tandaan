export type Task = {
  id: string
  title: string
  isCompleted: boolean
  dueDate?: string | null
  dueTime?: string | null
  reminderEnabled?: boolean
  /** Lead time in minutes. null means the user chose "No reminder". */
  reminderMinutesBefore?: number | null
  reminderAt?: string | null
  reminderSentAt?: string | null
  createdAt: string
  updatedAt: string
  // Set when the record is soft-deleted. Tombstones stay in local storage and
  // in Supabase for TOMBSTONE_RETENTION_DAYS so other devices can purge their
  // copy instead of resurrecting the record. Never render these.
  deletedAt?: string | null
}

export type ShoppingItem = {
  id: string
  name: string
  quantity: number | null
  unit: string | null
  expectedPrice: number | null
  isPurchased: boolean
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

export type Purchase = {
  id: string
  itemName: string
  quantity: number | null
  unit: string | null
  price: number | null
  currency: string
  purchasedAt: string
  notes: string | null
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

export type ThemeId = 'cat' | 'dog' | 'capybara' | 'strawberry'

// Pastel palette applied on top of an animal theme. 'original' reproduces that
// animal's current look exactly, so the feature is purely additive.
export type ThemeColorId = 'original' | 'charcoal' | 'maroon' | 'pink' | 'yellow' | 'purple'

export type Profile = {
  id: string
  displayName: string
  timezone: string
  onboardingComplete: boolean
  theme?: ThemeId
}


export type DebtDirection = 'owe' | 'owed_to_me'

export type DebtPayment = {
  id: string
  amountCents: number
  paidAt: string
  method: string | null
  note: string | null
}

export type Debt = {
  id: string
  direction: DebtDirection
  personName: string
  description: string | null
  originalAmountCents: number
  dueDate: string | null
  reminderEnabled: boolean
  reminderMinutesBefore: number | null
  reminderAt: string | null
  reminderSentAt: string | null
  payments: DebtPayment[]
  notes: string | null
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

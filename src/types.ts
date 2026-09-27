export type Task = {
  id: string
  title: string
  isCompleted: boolean
  dueDate?: string | null
  dueTime?: string | null
  reminderEnabled?: boolean
  reminderMinutesBefore?: number
  reminderAt?: string | null
  reminderSentAt?: string | null
  createdAt: string
  updatedAt: string
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
}

export type ThemeId = 'purple' | 'midnight' | 'lavender' | 'rose' | 'ocean' | 'emerald'

export type Profile = {
  id: string
  displayName: string
  timezone: string
  onboardingComplete: boolean
  theme?: ThemeId
}

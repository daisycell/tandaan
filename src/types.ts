export type Task = {
  id: string
  title: string
  isCompleted: boolean
  dueDate?: string | null
  dueTime?: string | null
  createdAt: string
  updatedAt: string
}

export type Profile = {
  id: string
  displayName: string
  timezone: string
  onboardingComplete: boolean
}

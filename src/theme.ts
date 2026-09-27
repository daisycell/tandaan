import type { ThemeId } from './types'

export type ThemeOption = {
  id: ThemeId
  name: string
  description: string
  swatch: string
  emoji: string
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'cat', name: 'Cat', description: 'Cozy purple', swatch: '#8b5cf6', emoji: '🐱' },
  { id: 'dog', name: 'Golden Retriever', description: 'Warm and cheerful', swatch: '#d89b2b', emoji: '🐕' },
  { id: 'capybara', name: 'Capybara', description: 'Calm and earthy', swatch: '#8a7658', emoji: '🦫' },
]

export const DEFAULT_THEME: ThemeId = 'cat'

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return THEME_OPTIONS.some(option => option.id === value)
}

export function themeOption(theme: ThemeId) {
  return THEME_OPTIONS.find(option => option.id === theme) ?? THEME_OPTIONS[0]
}

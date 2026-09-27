import type { ThemeId } from './types'

export type ThemeOption = {
  id: ThemeId
  name: string
  description: string
  swatch: string
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'purple', name: 'Royal Purple', description: 'Tandaan default', swatch: '#8b5cf6' },
  { id: 'midnight', name: 'Midnight Violet', description: 'Deep and calm', swatch: '#7c3aed' },
  { id: 'lavender', name: 'Soft Lavender', description: 'Brighter purple', swatch: '#a78bfa' },
  { id: 'rose', name: 'Berry Rose', description: 'Warm accent', swatch: '#e11d48' },
  { id: 'ocean', name: 'Ocean Blue', description: 'Cool and focused', swatch: '#0ea5e9' },
  { id: 'emerald', name: 'Emerald', description: 'Fresh and calm', swatch: '#10b981' },
]

export const DEFAULT_THEME: ThemeId = 'purple'

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return THEME_OPTIONS.some(option => option.id === value)
}

import type { ThemeColorId, ThemeId } from './types'

export type ThemeOption = {
  id: ThemeId
  name: string
  description: string
  swatch: string
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'cat', name: 'Cat', description: 'Cozy purple', swatch: '#8b5cf6' },
  { id: 'dog', name: 'Golden Retriever', description: 'Warm and cheerful', swatch: '#d89b2b' },
  { id: 'capybara', name: 'Capybara', description: 'Calm and earthy', swatch: '#8a7658' },
]

export const DEFAULT_THEME: ThemeId = 'cat'
export const DEFAULT_THEME_COLOR: ThemeColorId = 'original'

export const STICKERS: Record<ThemeId, string[]> = {
  cat: Array.from({ length: 10 }, (_, i) => `ca${i + 1}.png`),
  dog: Array.from({ length: 10 }, (_, i) => `do${i + 1}.png`),
  capybara: Array.from({ length: 10 }, (_, i) => `cap${i + 1}.png`),
}

export function stickerUrl(theme: ThemeId, filename: string) {
  return `/stickers/${theme}/${filename}`
}

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return THEME_OPTIONS.some(option => option.id === value)
}

// --- Pastel colour variants -------------------------------------------------
// The animal picks the sticker pack. The colour picks the accent + background
// palette only. Sticker artwork is never affected by colour.

export type ColorOption = {
  id: ThemeColorId
  name: string
  swatch: string
}

export const COLOR_OPTIONS: ColorOption[] = [
  { id: 'original', name: 'Original', swatch: '#8b5cf6' },
  { id: 'charcoal', name: 'Charcoal', swatch: '#3a3a42' },
  { id: 'maroon', name: 'Maroon', swatch: '#a4506b' },
  { id: 'pink', name: 'Pink', swatch: '#e89bb0' },
  { id: 'yellow', name: 'Yellow', swatch: '#d9b84f' },
  { id: 'blue', name: 'Blue', swatch: '#7aa5e0' },
]

export type Palette = {
  accent: string
  accentStrong: string
  accentSoft: string
  accentBorder: string
  bg: string
  bgSecondary: string
  surface: string
  surface2: string
  surface3: string
  border: string
  borderStrong: string
  headerBg: string
  headerBgFade: string
}

// The exact tokens that ship today, one set per animal. These back the
// 'original' colour and must never drift, or existing users see a change.
const BASE_PALETTES: Record<ThemeId, Palette> = {
  cat: {
    accent: '#8b5cf6', accentStrong: '#7c3aed', accentSoft: 'rgba(139,92,246,.16)', accentBorder: 'rgba(196,181,253,.34)',
    bg: '#0b0715', bgSecondary: '#130d21', surface: 'rgba(21,14,35,.92)', surface2: '#17102a', surface3: '#21183b',
    border: '#31234b', borderStrong: '#49356c',
    // Preserved verbatim from the current hardcoded .app-header gradient so the
    // 'original' colour renders exactly as it does today.
    headerBg: 'rgba(11,7,21,.96)', headerBgFade: 'rgba(11,7,21,.8)',
  },
  dog: {
    accent: '#d89b2b', accentStrong: '#b97812', accentSoft: 'rgba(216,155,43,.16)', accentBorder: 'rgba(245,196,95,.34)',
    bg: '#130e07', bgSecondary: '#1f160b', surface: 'rgba(31,22,11,.92)', surface2: '#261b0f', surface3: '#362613',
    border: '#4d391e', borderStrong: '#73552a',
    headerBg: 'rgba(11,7,21,.96)', headerBgFade: 'rgba(11,7,21,.8)',
  },
  capybara: {
    accent: '#9a7b58', accentStrong: '#72563a', accentSoft: 'rgba(154,123,88,.17)', accentBorder: 'rgba(210,181,145,.34)',
    bg: '#100d08', bgSecondary: '#1a1510', surface: 'rgba(28,23,17,.93)', surface2: '#211a13', surface3: '#302419',
    border: '#433426', borderStrong: '#63503a',
    headerBg: 'rgba(11,7,21,.96)', headerBgFade: 'rgba(11,7,21,.8)',
  },
}

type ColorSpec = {
  name: string
  swatch: string
  accent: string
  accentStrong: string
  accentBorder: string
  /** Dark hue mixed into the animal's neutrals so each animal keeps its character. */
  tint: string
  /** How far the neutrals shift toward the tint. */
  tintWeight: number
}

// Tints are deliberately deep rather than pastel: mixing a near-black surface
// toward a pastel hex raises luminance fast and kills text contrast.
const COLOR_SPECS: Record<Exclude<ThemeColorId, 'original'>, ColorSpec> = {
  charcoal: { name: 'Charcoal', swatch: '#3a3a42', accent: '#3a3a42', accentStrong: '#2a2a31', accentBorder: 'rgba(150,150,166,.30)', tint: '#2b2b33', tintWeight: 0.3 },
  maroon: { name: 'Maroon', swatch: '#a4506b', accent: '#a4506b', accentStrong: '#843d54', accentBorder: 'rgba(214,150,172,.32)', tint: '#481f2d', tintWeight: 0.26 },
  pink: { name: 'Pink', swatch: '#e89bb0', accent: '#e89bb0', accentStrong: '#d4798f', accentBorder: 'rgba(246,196,210,.34)', tint: '#4f2739', tintWeight: 0.26 },
  yellow: { name: 'Yellow', swatch: '#d9b84f', accent: '#d9b84f', accentStrong: '#bb9a34', accentBorder: 'rgba(240,216,150,.34)', tint: '#493c12', tintWeight: 0.26 },
  blue: { name: 'Blue', swatch: '#7aa5e0', accent: '#7aa5e0', accentStrong: '#5b87c9', accentBorder: 'rgba(178,205,244,.34)', tint: '#1e3357', tintWeight: 0.26 },
}

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

function toHex(value: number) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

function mixHex(from: string, to: string, weight: number) {
  const a = hexToRgb(from)
  const b = hexToRgb(to)
  return `#${toHex(a.r + (b.r - a.r) * weight)}${toHex(a.g + (b.g - a.g) * weight)}${toHex(a.b + (b.b - a.b) * weight)}`
}

function alpha(hex: string, alphaValue: number) {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r},${g},${b},${alphaValue})`
}

const NEUTRAL_KEYS = ['bg', 'bgSecondary', 'surface', 'surface2', 'surface3', 'border', 'borderStrong'] as const

function buildPalette(theme: ThemeId, color: ThemeColorId): Palette {
  const base = BASE_PALETTES[theme]
  if (color === 'original') return base

  const spec = COLOR_SPECS[color]
  const palette: Palette = {
    accent: spec.accent,
    accentStrong: spec.accentStrong,
    accentSoft: alpha(spec.accent, 0.16),
    accentBorder: spec.accentBorder,
    bg: '', bgSecondary: '', surface: '', surface2: '', surface3: '', border: '', borderStrong: '',
    headerBg: alpha(mixHex(base.bg, spec.tint, 0.14), 0.96),
    headerBgFade: alpha(mixHex(base.bg, spec.tint, 0.09), 0.8),
  }

  for (const key of NEUTRAL_KEYS) {
    const value = base[key]
    // 'surface' carries an alpha channel, so it is blended as a flat colour and
    // its original opacity is reapplied afterwards.
    const alphaMatch = value.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/)
    if (alphaMatch) {
      const baseHex = `#${toHex(Number(alphaMatch[1]))}${toHex(Number(alphaMatch[2]))}${toHex(Number(alphaMatch[3]))}`
      const mixed = mixHex(baseHex, spec.tint, spec.tintWeight).replace('#', '')
      palette[key] = `rgba(${parseInt(mixed.slice(0, 2), 16)},${parseInt(mixed.slice(2, 4), 16)},${parseInt(mixed.slice(4, 6), 16)},${alphaMatch[4]})`
    } else {
      // Borders take a lighter touch of tint so they stay visible.
      const weight = key === 'border' || key === 'borderStrong' ? spec.tintWeight * 0.7 : spec.tintWeight
      palette[key] = mixHex(value, spec.tint, weight)
    }
  }

  return palette
}

export const COLOR_PALETTES: Record<ThemeId, Record<ThemeColorId, Palette>> = {
  cat: Object.fromEntries(COLOR_OPTIONS.map(c => [c.id, buildPalette('cat', c.id)])) as Record<ThemeColorId, Palette>,
  dog: Object.fromEntries(COLOR_OPTIONS.map(c => [c.id, buildPalette('dog', c.id)])) as Record<ThemeColorId, Palette>,
  capybara: Object.fromEntries(COLOR_OPTIONS.map(c => [c.id, buildPalette('capybara', c.id)])) as Record<ThemeColorId, Palette>,
}

export function isThemeColorId(value: string | null | undefined): value is ThemeColorId {
  return COLOR_OPTIONS.some(option => option.id === value)
}

export function colorOption(color: ThemeColorId) {
  return COLOR_OPTIONS.find(option => option.id === color) ?? COLOR_OPTIONS[0]
}

/** Swatch for a given animal + colour pair, for the picker's preview chips. */
export function colorSwatch(theme: ThemeId, color: ThemeColorId) {
  return COLOR_PALETTES[theme][color].accent
}

export function themeOption(theme: ThemeId) {
  return THEME_OPTIONS.find(option => option.id === theme) ?? THEME_OPTIONS[0]
}

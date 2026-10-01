import { env, pipeline } from '@huggingface/transformers'
import { parseInput, type ParsedInput } from './parser'

// Lazy, on-device intent understanding. The model is downloaded only on the
// first Quick Add that needs it, then reused from the browser cache.
const MODEL_ID = 'onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX'
const LABELS = [
  'an action the user needs to do or perform',
  'an item or list of items the user plans to buy',
  'something the user already bought or purchased',
  'a note or information the user wants to save',
]

type Classifier = (text: string, labels: string[], options?: Record<string, unknown>) => Promise<any>
let classifierPromise: Promise<Classifier> | null = null

function canUseWebGPU() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

async function getClassifier() {
  if (classifierPromise) return classifierPromise
  env.useBrowserCache = true
  env.allowLocalModels = false
  env.allowRemoteModels = true
  classifierPromise = pipeline('zero-shot-classification', MODEL_ID, {
    device: canUseWebGPU() ? 'webgpu' : 'wasm',
  }) as unknown as Promise<Classifier>
  try {
    return await classifierPromise
  } catch (error) {
    classifierPromise = null
    throw error
  }
}

function labelToIntent(label: string): ParsedInput['intent'] {
  const value = label.toLowerCase()
  if (value.includes('already bought') || value.includes('purchased')) return 'purchase'
  if (value.includes('plans to buy') || value.includes('item') || value.includes('list of items')) return 'shopping'
  if (value.includes('note') || value.includes('information')) return 'note'
  return 'task'
}



export async function parseInputWithAI(text: string): Promise<ParsedInput> {
  const fallback = parseInput(text)
  const raw = text.trim()
  if (!raw) return fallback

  // This function is only called by Quick Add for an ambiguous result.
  // Keep the guard here too so other callers can never accidentally invoke
  // the model for an already-clear input.
  if (!fallback.ambiguous) return fallback

  try {
    const classifier = await getClassifier()
    const result = await classifier(raw, LABELS, { multi_label: false })
    const labels = Array.isArray(result?.labels) ? result.labels : []
    const scores = Array.isArray(result?.scores) ? result.scores : []
    const topLabel = typeof labels[0] === 'string' ? labels[0] : ''
    const topScore = Number(scores[0] ?? 0)
    const secondScore = Number(scores[1] ?? 0)
    const intent = labelToIntent(topLabel)

    if (!topLabel || topScore < 0.52 || topScore - secondScore < 0.10) return fallback

    if (intent === 'task') {
      const task = parseInput(raw)
      return { ...task, intent: 'task', ambiguous: undefined }
    }
    if (intent === 'shopping') {
      const parsed = parseInput(raw)
      return {
        ...parsed,
        intent: 'shopping',
        shoppingItems: parsed.shoppingItems?.length ? parsed.shoppingItems : [{ itemName: raw }],
        shopping: parsed.shopping ?? { itemName: raw },
        ambiguous: undefined,
      }
    }
    if (intent === 'purchase') {
      const parsed = parseInput(raw)
      if (parsed.purchases?.length) return { ...parsed, intent: 'purchase', ambiguous: undefined }
      return { ...fallback, intent: 'purchase', ambiguous: undefined }
    }

    return { ...fallback, intent: 'note', title: fallback.title || raw, ambiguous: undefined }
  } catch {
    return fallback
  }
}

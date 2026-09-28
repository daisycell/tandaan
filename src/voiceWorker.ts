import { env, pipeline } from '@huggingface/transformers'

env.useBrowserCache = true
env.allowLocalModels = false

type WorkerModel = 'onnx-community/whisper-tiny' | 'onnx-community/whisper-base'
type WorkerDevice = 'webgpu' | 'wasm'

type WorkerMessage =
  | { id: number; type: 'prepare'; modelId: WorkerModel; online: boolean; webgpuAvailable: boolean }
  | { id: number; type: 'transcribe'; modelId: WorkerModel; audio: Float32Array; online: boolean; webgpuAvailable: boolean }
  | { id: number; type: 'reset' }

type WorkerResult = {
  id: number
  type: 'progress' | 'ready' | 'result' | 'error'
  progress?: number
  cached?: boolean
  text?: string
  error?: string
  fatal?: boolean
}

let transcriber: any = null
let currentModel: WorkerModel | null = null
let currentDevice: WorkerDevice | null = null
let loadingPromise: Promise<any> | null = null
let loadingModel: WorkerModel | null = null
let transcribingNow = false

const VOICE_DIAGNOSTIC_PREFIX = '[Tandaan Voice]'
const diagnostic = (event: string, details: Record<string, unknown> = {}) => {
  self.console?.info?.(VOICE_DIAGNOSTIC_PREFIX, event, { tMs: Math.round(performance.now()), ...details })
}

const scope = self as unknown as {
  postMessage: (message: WorkerResult) => void
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null
}

function post(message: WorkerResult) {
  scope.postMessage(message)
}

async function loadModel(modelId: WorkerModel, online: boolean, webgpuAvailable: boolean, requestId: number) {
  if (transcriber && currentModel === modelId) return { cached: true }

  // currentModel is assigned only after loading finishes. loadingModel prevents
  // concurrent pipeline() calls from allocating multiple model instances.
  if (loadingPromise && loadingModel === modelId) {
    await loadingPromise
    return { cached: true }
  }

  const isMobile = modelId === 'onnx-community/whisper-tiny'
  if (isMobile && !webgpuAvailable) {
    throw new Error('On-device voice is unavailable on this phone because WebGPU is not available. No WASM fallback will be loaded.')
  }

  const device: WorkerDevice = isMobile ? 'webgpu' : (webgpuAvailable ? 'webgpu' : 'wasm')
  const dtype = isMobile ? 'q4f16' : 'q8'

  // On offline launches, prevent remote fetches; browser cache remains usable.
  env.allowRemoteModels = online

  const options: Record<string, unknown> = {
    device,
    dtype,
    progress_callback: (info: any) => {
      if (info?.status === 'progress' && typeof info.progress === 'number') {
        post({ id: requestId, type: 'progress', progress: Math.max(0, Math.min(100, Math.round(info.progress))) })
      }
    },
  }

  loadingModel = modelId
  loadingPromise = pipeline('automatic-speech-recognition', modelId, options)

  try {
    transcriber = await loadingPromise
    currentModel = modelId
    currentDevice = device
    post({ id: requestId, type: 'progress', progress: 100 })
    return { cached: false }
  } finally {
    loadingPromise = null
    loadingModel = null
  }
}

function clearEngine() {
  transcriber = null
  currentModel = null
  currentDevice = null
  loadingPromise = null
  loadingModel = null
  transcribingNow = false
}

scope.onmessage = async event => {
  const message = event.data
  try {
    if (message.type === 'reset') {
      clearEngine()
      return
    }

    if (message.type === 'prepare') {
      const result = await loadModel(message.modelId, message.online, message.webgpuAvailable, message.id)
      post({ id: message.id, type: 'ready', cached: result.cached })
      return
    }

    if (message.type !== 'transcribe') return

    if (!message.audio?.length) throw new Error('The recorded audio was empty.')
    if (transcribingNow) throw new Error('Voice is still processing the previous recording. Please wait a moment.')
    transcribingNow = true

    await loadModel(message.modelId, message.online, message.webgpuAvailable, message.id)
    if (!transcriber) throw new Error('Voice engine is not ready.')

    diagnostic('inference-entered', { id: message.id, modelId: message.modelId, device: currentDevice, samples: message.audio.length })
    const inferenceStartedAt = performance.now()
    const output = await transcriber(message.audio, {
      task: 'transcribe',
      return_timestamps: false,
      language: undefined,
      max_new_tokens: 32,
    })

    const text = String(output?.text ?? '').replace(/\s+/g, ' ').trim()
    diagnostic('inference-finished', { id: message.id, durationMs: Math.round(performance.now() - inferenceStartedAt), textLength: text.length })
    if (!text) throw new Error('No speech was recognized. Try a short, clear command.')
    post({ id: message.id, type: 'result', text })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    diagnostic('worker-exception', { id: message.id, type: message.type, message: detail })
    const lower = detail.toLowerCase()
    const fatal = /out of memory|memory|sassert|assertion|abort|webassembly|wasm|worker stopped|execution.*terminated|context lost|device lost|gpu.*lost/.test(lower)
    if (fatal) clearEngine()
    post({ id: message.id, type: 'error', error: detail, fatal })
  } finally {
    if (message.type === 'transcribe') transcribingNow = false
  }
}

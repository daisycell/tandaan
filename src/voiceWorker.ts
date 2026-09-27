import { env, pipeline } from '@huggingface/transformers'

env.useBrowserCache = true
env.allowRemoteModels = true
env.allowLocalModels = false

type WorkerModel = 'Xenova/whisper-tiny' | 'Xenova/whisper-base'

type WorkerMessage =
  | { id: number; type: 'prepare'; modelId: WorkerModel; online: boolean }
  | { id: number; type: 'transcribe'; modelId: WorkerModel; audio: Float32Array }
  | { id: number; type: 'reset' }

type WorkerResult = {
  id: number
  type: 'progress' | 'ready' | 'result' | 'error'
  progress?: number
  cached?: boolean
  text?: string
  error?: string
}

let transcriber: any = null
let currentModel: WorkerModel | null = null
let loadingPromise: Promise<any> | null = null

const scope = self as unknown as {
  postMessage: (message: WorkerResult) => void
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null
}

function post(message: WorkerResult) {
  scope.postMessage(message)
}

async function loadModel(modelId: WorkerModel, online: boolean, requestId: number) {
  if (transcriber && currentModel === modelId) return { cached: true }
  if (loadingPromise && currentModel === modelId) {
    await loadingPromise
    return { cached: true }
  }

  if (!online) {
    // The pipeline performs the authoritative offline cache check. If the model is
    // missing or incomplete, it throws and we surface that instead of guessing from
    // a cache directory entry.
  }

  const createOptions: Record<string, unknown> = {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (info: any) => {
      if (info?.status === 'progress' && typeof info.progress === 'number') {
        post({ id: requestId, type: 'progress', progress: Math.max(0, Math.min(100, Math.round(info.progress))) })
      }
    },
  }
  if (!online) createOptions.local_files_only = true

  loadingPromise = pipeline('automatic-speech-recognition', modelId, createOptions)
  try {
    transcriber = await loadingPromise
    currentModel = modelId
    post({ id: requestId, type: 'progress', progress: 100 })
    return { cached: false }
  } catch (error) {
    transcriber = null
    currentModel = null
    throw error
  } finally {
    loadingPromise = null
  }
}

scope.onmessage = async event => {
  const message = event.data
  try {
    if (message.type === 'reset') {
      transcriber = null
      currentModel = null
      loadingPromise = null
      return
    }

    if (message.type === 'prepare') {
      const result = await loadModel(message.modelId, message.online, message.id)
      post({ id: message.id, type: 'ready', cached: result.cached })
      return
    }

    if (!message.audio?.length) throw new Error('The recorded audio was empty.')
    await loadModel(message.modelId, navigator.onLine !== false, message.id)
    if (!transcriber) throw new Error('Voice engine is not ready.')

    const output = await transcriber(message.audio, {
      task: 'transcribe',
      return_timestamps: false,
      language: undefined,
      chunk_length_s: 15,
    })

    const text = String(output?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) throw new Error('No speech was recognized. Try a short, clear command.')
    post({ id: message.id, type: 'result', text })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    transcriber = null
    currentModel = null
    loadingPromise = null
    post({ id: message.id, type: 'error', error: detail })
  }
}

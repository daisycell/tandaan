import { ModelManager, WhisperWasmService } from '@timur00kh/whisper.wasm'

let service: WhisperWasmService | null = null
let modelManager: ModelManager | null = null
let initializedModel: string | null = null

function getModelManager() {
  if (!modelManager) modelManager = new ModelManager({ logLevel: 0 })
  return modelManager
}

async function prepare(modelId: 'tiny-q5_1' | 'base-q5_1', onProgress?: (progress: number) => void) {
  if (service && initializedModel === modelId) {
    onProgress?.(100)
    return
  }

  service = new WhisperWasmService({ logLevel: 0 })
  const supported = await service.checkWasmSupport()
  if (!supported) throw new Error('This browser does not support offline voice WebAssembly.')

  const model = await getModelManager().loadModel(modelId, true, progress => onProgress?.(progress))
  await service.initModel(model)
  initializedModel = modelId
  onProgress?.(100)
}

const workerScope = self as unknown as {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent) => void) | null
}

workerScope.onmessage = async (event: MessageEvent) => {
  const message = event.data as {
    id: number
    type: 'prepare' | 'transcribe'
    modelId: 'tiny-q5_1' | 'base-q5_1'
    audioData?: Float32Array
  }

  try {
    if (message.type === 'prepare') {
      await prepare(message.modelId, progress => workerScope.postMessage({ id: message.id, type: 'progress', progress }))
      workerScope.postMessage({ id: message.id, type: 'result', result: { ready: true } })
      return
    }

    await prepare(message.modelId)
    if (!service || !message.audioData) throw new Error('Voice engine is not ready.')

    const result = await service.transcribe(message.audioData, undefined, {
      language: 'auto',
      threads: 1,
      translate: false,
    })

    const text = result.segments
      .map(segment => segment.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (!text) throw new Error('No speech was recognized. Try speaking clearly for a little longer.')
    workerScope.postMessage({ id: message.id, type: 'result', result: { text } })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown voice engine error.'
    // Drop the WASM instance on any inference failure. A later request will create a
    // fresh worker/engine instead of leaving the UI stuck in a transcribing state.
    service = null
    initializedModel = null
    workerScope.postMessage({ id: message.id, type: 'error', error: detail })
  }
}

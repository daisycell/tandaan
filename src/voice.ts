let whisperEnginePromise: Promise<WhisperEngine> | null = null
let activeTranscriptionPromise: Promise<string> | null = null
let activeEngine: WhisperEngine | null = null

export type VoiceCaptureResult = { blob: Blob; durationMs: number }
export type VoiceRecorder = {
  stop: () => Promise<VoiceCaptureResult>
  cancel: () => void
  finished: Promise<VoiceCaptureResult>
}

type WhisperEngine = {
  transcribe: (audioData: Float32Array) => Promise<string>
  recover: () => Promise<void>
}

type ProgressCallback = (progress: number) => void

function preferredMimeType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return types.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || ''
}

function extensionForMime(mime: string) {
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

export async function startVoiceCapture(onLevel?: (level: number) => void, maxDurationMs = 12_000): Promise<VoiceRecorder> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Microphone recording is not supported by this browser.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true, channelCount: 1 },
  })

  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
  const data = new Uint8Array(analyser.fftSize)
  const mimeType = preferredMimeType()
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, bitsPerSecond: 24_000 } : undefined)
  const chunks: Blob[] = []
  const startedAt = performance.now()
  let animation = 0
  let settled = false
  let speechStarted = false
  let silenceStartedAt = 0
  let timer = 0

  const silenceThreshold = 0.045
  const silenceDurationMs = 750

  let resolveFinished!: (value: VoiceCaptureResult) => void
  let rejectFinished!: (reason?: unknown) => void
  const finished = new Promise<VoiceCaptureResult>((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })

  const cleanup = async () => {
    cancelAnimationFrame(animation)
    clearTimeout(timer)
    source.disconnect()
    analyser.disconnect()
    stream.getTracks().forEach(track => track.stop())
    await ctx.close().catch(() => undefined)
    onLevel?.(0)
  }

  const finalizeStop = () => {
    if (settled) return finished
    settled = true
    clearTimeout(timer)
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
      const result = { blob, durationMs: Math.round(performance.now() - startedAt) }
      void cleanup().then(() => resolveFinished(result))
    }
    recorder.onerror = () => {
      void cleanup().then(() => rejectFinished(new Error('Recording failed.')))
    }
    try {
      recorder.stop()
    } catch {
      void cleanup().then(() => rejectFinished(new Error('Recording could not be stopped.')))
    }
    return finished
  }

  const stop = () => finalizeStop()

  const cancel = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    recorder.onstop = () => { void cleanup() }
    try { recorder.stop() } catch { void cleanup() }
  }

  const updateLevel = () => {
    if (settled) return
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    onLevel?.(Math.min(1, rms * 4))
    if (rms > silenceThreshold) {
      speechStarted = true
      silenceStartedAt = 0
    } else if (speechStarted && !silenceStartedAt) {
      silenceStartedAt = performance.now()
    } else if (speechStarted && silenceStartedAt && performance.now() - silenceStartedAt >= silenceDurationMs) {
      void finalizeStop()
      return
    }
    animation = requestAnimationFrame(updateLevel)
  }

  recorder.ondataavailable = event => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  recorder.start(200)
  updateLevel()
  timer = window.setTimeout(() => { void finalizeStop() }, maxDurationMs)

  return { stop, cancel, finished }
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

function chooseModelId() {
  // Mobile uses the smaller quantized multilingual model to avoid iOS/Safari memory
  // pressure. Desktop can use the more accurate base model.
  return (isMobileDevice() ? 'tiny-q5_1' : 'base-q5_1') as 'tiny-q5_1' | 'base-q5_1'
}

function modelCacheKey() {
  return `tandaan-voice-model-cached-${chooseModelId()}`
}

async function createWhisperEngine(onProgress?: ProgressCallback): Promise<WhisperEngine> {
  const { WhisperWasmService, ModelManager } = await import('@timur00kh/whisper.wasm')
  const service = new WhisperWasmService({ logLevel: 0 })
  const supported = await service.checkWasmSupport()
  if (!supported) throw new Error('This browser does not support the WebAssembly features needed for offline voice.')

  const manager = new ModelManager({ logLevel: 0 })
  const model = await manager.loadModel(chooseModelId(), true, progress => onProgress?.(progress))
  await service.initModel(model)

  const threads = 1

  const transcribeOnce = async (audioData: Float32Array) => {
    const result = await service.transcribe(audioData, undefined, {
      language: 'auto',
      threads,
      translate: false,
    })
    const text = result.segments
      .map(segment => segment.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) throw new Error('No speech was recognized. Try speaking clearly for a little longer.')
    return text
  }

  const recover = async () => {
    await service.restartModel()
  }

  return { transcribe: transcribeOnce, recover }
}

async function loadWhisperEngine(onProgress?: ProgressCallback): Promise<WhisperEngine> {
  if (whisperEnginePromise) return whisperEnginePromise
  whisperEnginePromise = createWhisperEngine(onProgress)
    .then(engine => {
      activeEngine = engine
      try { localStorage.setItem(modelCacheKey(), '1') } catch { /* best effort */ }
      return engine
    })
    .catch(error => {
      whisperEnginePromise = null
      activeEngine = null
      throw error
    })
  return whisperEnginePromise
}

function trimSilence(audioData: Float32Array) {
  if (audioData.length < 16_000) return audioData

  const frameSize = 320
  const threshold = 0.008
  let first = 0
  let last = audioData.length
  let found = false

  for (let start = 0; start < audioData.length; start += frameSize) {
    const end = Math.min(audioData.length, start + frameSize)
    let sum = 0
    for (let i = start; i < end; i += 1) sum += audioData[i] * audioData[i]
    const rms = Math.sqrt(sum / Math.max(1, end - start))
    if (rms >= threshold) {
      first = start
      found = true
      break
    }
  }

  if (!found) return audioData

  for (let end = audioData.length; end > 0; end -= frameSize) {
    const start = Math.max(0, end - frameSize)
    let sum = 0
    for (let i = start; i < end; i += 1) sum += audioData[i] * audioData[i]
    const rms = Math.sqrt(sum / Math.max(1, end - start))
    if (rms >= threshold) {
      last = end
      break
    }
  }

  const pad = Math.round(16_000 * 0.1)
  const from = Math.max(0, first - pad)
  const to = Math.min(audioData.length, last + pad)
  if (to - from < 16_000) return audioData
  // Avoid copying the full buffer on memory-constrained mobile devices.
  return audioData.subarray(from, to)
}

function isLikelyMemoryError(message: string) {
  return /out of memory|memory|allocation|cannot allocate|wasm.*abort|aborted|assert/i.test(message)
}

export async function transcribeVoice(blob: Blob, durationMs: number, onProgress?: ProgressCallback) {
  if (durationMs < 450) throw new Error('The recording is too short.')
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    throw new Error('Offline voice is not supported in this environment.')
  }
  if (!blob.size) throw new Error('The microphone recording was empty. Please try again.')
  if (durationMs > 14_000) throw new Error('Recording is too long. Try a shorter voice command.')

  const { convertFromFile } = await import('@timur00kh/whisper.wasm')
  const mime = blob.type || 'audio/webm'
  const ext = extensionForMime(mime)
  const file = new File([blob], `tandaan-voice.${ext}`, { type: mime })

  let audioData: Float32Array
  try {
    const conversion = await convertFromFile(file, { normalize: true })
    audioData = trimSilence(conversion.audioData)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Audio conversion failed.'
    throw new Error(`Could not prepare the recording for offline transcription: ${detail}`)
  }

  if (activeTranscriptionPromise) {
    throw new Error('A previous voice transcription is still finishing. Please wait a moment and try again.')
  }

  const modelKey = modelCacheKey()
  let cacheAlreadyReady = false
  try { cacheAlreadyReady = localStorage.getItem(modelKey) === '1' } catch { /* best effort */ }

  activeTranscriptionPromise = (async () => {
    try {
      // Only show download progress when this device has not loaded this model before.
      const engine = await loadWhisperEngine(cacheAlreadyReady ? undefined : progress => onProgress?.(progress))
      if (!cacheAlreadyReady) onProgress?.(100)

      try {
        return await engine.transcribe(audioData)
      } catch (error) {
        const firstMessage = error instanceof Error ? error.message : 'Local voice transcription failed.'

        if (/already transcribing/i.test(firstMessage)) {
          try {
            await engine.recover()
            return await engine.transcribe(audioData)
          } catch {
            throw new Error('The previous voice session did not close cleanly. Please wait a second, then try again.')
          }
        }

        if (isLikelyMemoryError(firstMessage)) {
          whisperEnginePromise = null
          activeEngine = null
          throw new Error('Voice ran out of memory on this phone. The mobile voice engine has been reset. Try a short 3–6 second command.')
        }

        throw new Error(`Local voice transcription failed: ${firstMessage}`)
      }
    } finally {
      audioData = new Float32Array(0)
      activeTranscriptionPromise = null
      onProgress?.(100)
    }
  })()

  return activeTranscriptionPromise
}

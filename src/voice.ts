let whisperEnginePromise: Promise<WhisperEngine> | null = null

export type VoiceCaptureResult = { blob: Blob; durationMs: number }
export type VoiceRecorder = { stop: () => Promise<VoiceCaptureResult>; cancel: () => void }

type WhisperEngine = {
  loadProgress: number
  transcribe: (audioData: Float32Array) => Promise<string>
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

/**
 * Capture clean mono microphone audio. Audio stays on-device; transcription is local WASM.
 */
export async function startVoiceCapture(onLevel?: (level: number) => void, maxDurationMs = 20_000): Promise<VoiceRecorder> {
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
  let finished = false
  let speechStarted = false
  let silenceStartedAt = 0
  let timer = 0
  const silenceThreshold = 0.045
  const silenceDurationMs = 650

  const cleanup = async () => {
    cancelAnimationFrame(animation)
    source.disconnect()
    analyser.disconnect()
    stream.getTracks().forEach(track => track.stop())
    await ctx.close().catch(() => undefined)
    onLevel?.(0)
  }

  const stop = () => new Promise<VoiceCaptureResult>((resolve, reject) => {
    if (finished) return reject(new Error('Recording has already ended.'))
    finished = true
    clearTimeout(timer)
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
      void cleanup().then(() => resolve({ blob, durationMs: Math.round(performance.now() - startedAt) }))
    }
    recorder.onerror = () => { void cleanup().then(() => reject(new Error('Recording failed.'))) }
    try {
      recorder.stop()
    } catch {
      void cleanup()
      reject(new Error('Recording could not be stopped.'))
    }
  })

  const cancel = () => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    recorder.onstop = () => { void cleanup() }
    try { recorder.stop() } catch { void cleanup() }
  }

  const updateLevel = () => {
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
    } else if (speechStarted && silenceStartedAt && performance.now() - silenceStartedAt >= silenceDurationMs && !finished) {
      void stop()
      return
    }
    animation = requestAnimationFrame(updateLevel)
  }

  recorder.ondataavailable = event => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  recorder.start(200)
  updateLevel()
  timer = window.setTimeout(() => { void stop() }, maxDurationMs)

  return { stop, cancel }
}

function chooseModelId() {
  // Quantized multilingual base model from whisper.cpp: about 57 MB.
  // It trades some startup/storage for better recognition than the tiny model.
  return 'base-q5_1' as const
}

async function createWhisperEngine(onProgress?: ProgressCallback): Promise<WhisperEngine> {
  const { WhisperWasmService, ModelManager } = await import('@timur00kh/whisper.wasm')
  const service = new WhisperWasmService({ logLevel: 0 })
  const supported = await service.checkWasmSupport()
  if (!supported) throw new Error('This browser does not support the WebAssembly features needed for offline voice.')

  const manager = new ModelManager({ logLevel: 0 })
  const model = await manager.loadModel(chooseModelId(), true, progress => onProgress?.(progress))
  await service.initModel(model)

  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  const threads = crossOriginIsolated && !isIOS ? 4 : 1

  const transcribeWithFreshSession = async (audioData: Float32Array) => {
    const session = service.createSession()
    const segments: string[] = []
    for await (const segment of session.streaming(audioData, {
      language: 'auto',
      threads,
      translate: false,
      timeoutMs: 45_000,
      sleepMsBetweenChunks: 0,
    })) {
      const text = segment.text.trim()
      if (text) segments.push(text)
    }
    const text = segments.join(' ').replace(/\s+/g, ' ').trim()
    if (!text) throw new Error('No speech was recognized. Try speaking a little closer to the phone.')
    return text
  }

  return {
    loadProgress: 100,
    transcribe: async (audioData: Float32Array) => {
      try {
        return await transcribeWithFreshSession(audioData)
      } catch (firstError) {
        // Reinitialize the WASM module once after a runtime abort/termination.
        // The model stays cached in IndexedDB, so recovery does not redownload it.
        try {
          await service.restartModel()
          return await transcribeWithFreshSession(audioData)
        } catch (retryError) {
          const message = retryError instanceof Error ? retryError.message : firstError instanceof Error ? firstError.message : 'WASM transcription failed.'
          throw new Error(message)
        }
      }
    },
  }
}

async function loadWhisperEngine(onProgress?: ProgressCallback): Promise<WhisperEngine> {
  if (whisperEnginePromise) return whisperEnginePromise
  whisperEnginePromise = createWhisperEngine(onProgress).catch(error => {
    whisperEnginePromise = null
    throw error
  })
  return whisperEnginePromise
}

export async function transcribeVoice(blob: Blob, durationMs: number, onProgress?: ProgressCallback) {
  if (durationMs < 350) throw new Error('The recording is too short.')
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    throw new Error('Offline voice is not supported in this environment.')
  }
  if (!blob.size) throw new Error('The microphone recording was empty. Please try again.')

  const { convertFromFile } = await import('@timur00kh/whisper.wasm')
  const mime = blob.type || 'audio/webm'
  const ext = extensionForMime(mime)
  const file = new File([blob], `tandaan-voice.${ext}`, { type: mime })

  let audioData: Float32Array
  try {
    const conversion = await convertFromFile(file, { normalize: true })
    audioData = conversion.audioData
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Audio conversion failed.'
    throw new Error(`Could not prepare the recording for offline transcription: ${detail}`)
  }

  const engine = await loadWhisperEngine(onProgress)
  try {
    return await engine.transcribe(audioData)
  } catch (error) {
    whisperEnginePromise = null
    const detail = error instanceof Error ? error.message : 'Local voice transcription failed.'
    throw new Error(`Local voice transcription failed: ${detail}`)
  }
}

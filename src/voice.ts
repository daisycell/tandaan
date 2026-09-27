let whisperEnginePromise: Promise<WhisperEngine> | null = null
let activeTranscriptionPromise: Promise<string> | null = null

export type VoiceCaptureResult = { blob: Blob; durationMs: number }
export type VoiceRecorder = {
  stop: () => Promise<VoiceCaptureResult>
  cancel: () => void
  finished: Promise<VoiceCaptureResult>
}

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
 * Capture clean mono microphone audio. Auto-stop is reported through `finished`,
 * so the UI cannot race a second manual stop against the same recorder.
 */
export async function startVoiceCapture(onLevel?: (level: number) => void, maxDurationMs = 15_000): Promise<VoiceRecorder> {
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
  const silenceDurationMs = 800

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
      void cleanup()
      rejectFinished(new Error('Recording could not be stopped.'))
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
    } else if (speechStarted && silenceStartedAt && performance.now() - silenceStartedAt >= silenceDurationMs && !settled) {
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
  // Base model is memory-heavy on iOS. One thread avoids extra worker/heap pressure.
  const threads = isIOS ? 1 : (crossOriginIsolated ? 2 : 1)

  const transcribeOnce = async (audioData: Float32Array) => {
    const result = await service.transcribe(
      audioData,
      undefined,
      {
        language: 'auto',
        threads,
        translate: false,
      },
    )
    const text = result.segments
      .map(segment => segment.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) throw new Error('No speech was recognized. Try speaking a little closer to the phone.')
    return text
  }

  return {
    loadProgress: 100,
    transcribe: async (audioData: Float32Array) => {
      if (activeTranscriptionPromise) return activeTranscriptionPromise

      activeTranscriptionPromise = (async () => {
        try {
          return await transcribeOnce(audioData)
        } catch (error) {
          const firstMessage = error instanceof Error ? error.message : 'WASM transcription failed.'
          // Do not immediately reinitialize on memory exhaustion; that can worsen pressure on iOS.
          if (/out of memory|memory|allocation|cannot allocate/i.test(firstMessage)) {
            whisperEnginePromise = null
            throw new Error('Your phone ran out of memory while transcribing. Try a shorter recording, around 5–10 seconds.')
          }

          try {
            await service.restartModel()
            return await transcribeOnce(audioData)
          } catch (retryError) {
            const message = retryError instanceof Error ? retryError.message : firstMessage
            throw new Error(message)
          }
        } finally {
          activeTranscriptionPromise = null
        }
      })()

      return activeTranscriptionPromise
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

function trimSilence(audioData: Float32Array) {
  if (audioData.length < 16_000) return audioData

  const sampleRate = 16_000
  const frameSize = 320 // 20ms
  const threshold = 0.008
  let first = 0
  let last = audioData.length - 1
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

  const pad = Math.round(sampleRate * 0.12)
  const from = Math.max(0, first - pad)
  const to = Math.min(audioData.length, last + pad)
  if (to - from < 16_000) return audioData
  return audioData.slice(from, to)
}

export async function transcribeVoice(blob: Blob, durationMs: number, onProgress?: ProgressCallback) {
  if (durationMs < 350) throw new Error('The recording is too short.')
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    throw new Error('Offline voice is not supported in this environment.')
  }
  if (!blob.size) throw new Error('The microphone recording was empty. Please try again.')
  if (durationMs > 18_000) throw new Error('Recording is too long for on-device voice. Try a shorter recording.')

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

  // Let the UI distinguish model loading from the actual transcription phase.
  onProgress?.(0)
  const engine = await loadWhisperEngine(progress => onProgress?.(progress))
  onProgress?.(100)
  try {
    const result = await engine.transcribe(audioData)
    // Drop our JS-side reference as soon as the result is available.
    audioData = new Float32Array(0)
    return result
  } catch (error) {
    audioData = new Float32Array(0)
    whisperEnginePromise = null
    const detail = error instanceof Error ? error.message : 'Local voice transcription failed.'
    throw new Error(`Local voice transcription failed: ${detail}`)
  }
}

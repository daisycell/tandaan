let whisperEnginePromise: Promise<WhisperEngine> | null = null

export type VoiceCaptureResult = { blob: Blob; durationMs: number }
export type VoiceRecorder = { stop: () => Promise<VoiceCaptureResult>; cancel: () => void }

type WhisperEngine = {
  transcribe: (audioData: Float32Array) => Promise<string>
  loadProgress: number
}

type ProgressCallback = (progress: number) => void

function preferredMimeType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return types.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || ''
}

/**
 * Capture clean mono microphone audio. The audio stays in the browser;
 * transcription is performed locally by whisper.cpp/WASM after recording.
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
  let finished = false
  let speechStarted = false
  let silenceStartedAt = 0
  let timer = 0
  const silenceThreshold = 0.045
  const silenceDurationMs = 850

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
    try { recorder.stop() } catch { void cleanup(); reject(new Error('Recording could not be stopped.')) }
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

  recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data) }
  recorder.start(200)
  updateLevel()
  timer = window.setTimeout(() => { void stop() }, maxDurationMs)
  return { stop, cancel }
}

function chooseModelId() {
  // Base Q5_1 is ~57 MB and is multilingual. It is loaded only on first voice use
  // and then cached by the whisper.wasm ModelManager in IndexedDB.
  return 'base-q5_1' as const
}

async function loadWhisperEngine(onProgress?: ProgressCallback): Promise<WhisperEngine> {
  if (whisperEnginePromise) return whisperEnginePromise

  whisperEnginePromise = (async () => {
    try {
      const { WhisperWasmService, ModelManager, convertFromFile } = await import('@timur00kh/whisper.wasm')
      const service = new WhisperWasmService({ logLevel: 0 })
      const supported = await service.checkWasmSupport()
      if (!supported) throw new Error('This browser does not support the WebAssembly features needed for offline voice.')

      const manager = new ModelManager({ logLevel: 0 })
      const model = await manager.loadModel(chooseModelId(), true, progress => onProgress?.(progress))
      await service.initModel(model)

      const threads = /iPhone|iPad|iPod/i.test(navigator.userAgent)
        ? (crossOriginIsolated ? 3 : 2)
        : (crossOriginIsolated ? 4 : 2)

      return {
        loadProgress: 100,
        transcribe: async (audioData: Float32Array) => {
          const result = await service.transcribe(audioData, undefined, {
            language: 'auto',
            threads,
            translate: false,
          })
          const text = result.segments.map(segment => segment.text.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
          if (!text) throw new Error('No speech was recognized. Try speaking a little closer to the phone.')
          return text
        }
      }
    } catch (error) {
      whisperEnginePromise = null
      throw error
    }
  })()

  return whisperEnginePromise
}

export async function transcribeVoice(blob: Blob, durationMs: number, onProgress?: ProgressCallback) {
  if (durationMs < 350) throw new Error('The recording is too short.')
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    throw new Error('Offline voice is not supported in this environment.')
  }

  const { convertFromFile } = await import('@timur00kh/whisper.wasm')
  const file = new File([blob], 'tandaan-voice.webm', { type: blob.type || 'audio/webm' })
  const { audioData } = await convertFromFile(file, { normalize: true })
  const engine = await loadWhisperEngine(onProgress)
  try {
    return await engine.transcribe(audioData)
  } catch (error) {
    // A WASM execution failure can invalidate the module; force a fresh engine next time.
    whisperEnginePromise = null
    throw error instanceof Error ? new Error(`Local voice transcription failed: ${error.message}`) : new Error('Local voice transcription failed.')
  }
}

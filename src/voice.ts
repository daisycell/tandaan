let activeTranscriptionPromise: Promise<string> | null = null
let worker: Worker | null = null
let requestId = 0

type ModelId = 'tiny-q5_1' | 'base-q5_1'
type VoiceWorkerMessage =
  | { id: number; type: 'progress'; progress: number }
  | { id: number; type: 'result'; result: { ready?: boolean; text?: string } }
  | { id: number; type: 'error'; error: string }

type PendingRequest = {
  resolve: (value: VoiceWorkerMessage) => void
  reject: (reason?: unknown) => void
  timer?: number
  onProgress?: (progress: number) => void
}

const pending = new Map<number, PendingRequest>()

export type VoiceCaptureResult = { blob: Blob; durationMs: number }
export type VoiceRecorder = {
  stop: () => Promise<VoiceCaptureResult>
  cancel: () => void
  finished: Promise<VoiceCaptureResult>
}
export type VoicePhaseCallback = (phase: 'starting' | 'local' | 'online-fallback') => void

type PreparedModel = ModelId

function preferredMimeType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return types.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || ''
}

function extensionForMime(mime: string) {
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

function chooseModelId(): PreparedModel {
  return isMobileDevice() ? 'tiny-q5_1' : 'base-q5_1'
}

function modelCacheKey(modelId = chooseModelId()) {
  return `tandaan-voice-model-cached-${modelId}`
}

function createWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./voiceWorker.ts', import.meta.url), { type: 'module' })

  worker.onmessage = event => {
    const message = event.data as VoiceWorkerMessage
    const request = pending.get(message.id)
    if (!request) return
    if (message.type === 'progress') {
      request.onProgress?.(message.progress)
      return
    }
    if (request.timer) window.clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.type === 'error') request.reject(new Error(message.error))
    else request.resolve(message)
  }

  worker.onerror = event => {
    const error = new Error(event.message || 'The local voice worker stopped unexpectedly.')
    for (const [id, request] of pending) {
      if (request.timer) window.clearTimeout(request.timer)
      request.reject(error)
      pending.delete(id)
    }
    worker?.terminate()
    worker = null
  }

  return worker
}

function resetWorker() {
  worker?.terminate()
  worker = null
  for (const [id, request] of pending) {
    if (request.timer) window.clearTimeout(request.timer)
    request.reject(new Error('The local voice engine was restarted.'))
    pending.delete(id)
  }
}

function requestWorker(type: 'prepare' | 'transcribe', modelId: ModelId, audioData?: Float32Array, onProgress?: (progress: number) => void, timeoutMs?: number) {
  const id = ++requestId
  const requestPromise = new Promise<VoiceWorkerMessage>((resolve, reject) => {
    const request: PendingRequest = { resolve, reject, onProgress }
    if (timeoutMs) {
      request.timer = window.setTimeout(() => {
        pending.delete(id)
        resetWorker()
        reject(new Error('Local voice transcription timed out.'))
      }, timeoutMs)
    }
    pending.set(id, request)
    try {
      createWorker().postMessage({ id, type, modelId, audioData }, audioData ? [audioData.buffer] : [])
    } catch (error) {
      pending.delete(id)
      if (request.timer) window.clearTimeout(request.timer)
      reject(error)
    }
  })
  return requestPromise
}

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

  const pad = Math.round(16_000 * 0.06)
  const from = Math.max(0, first - pad)
  const to = Math.min(audioData.length, last + pad)
  if (to - from < 8_000) return audioData
  return audioData.slice(from, to)
}

async function transcribeOnline(blob: Blob) {
  const { supabase } = await import('./supabase')
  if (!supabase) throw new Error('Supabase is not configured for online voice fallback.')
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('No online Tandaan session is available for voice fallback.')

  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': blob.type || 'application/octet-stream',
      'X-Voice-Filename': `tandaan-voice.${extensionForMime(blob.type || 'audio/webm')}`,
    },
    body: blob,
  })

  const body = await response.json().catch(() => ({})) as { text?: string; error?: string }
  if (!response.ok) throw new Error(body.error || `Online transcription failed (${response.status}).`)
  if (!body.text?.trim()) throw new Error('The online transcription returned no speech.')
  return body.text.trim()
}

export async function prepareVoice(onProgress?: ProgressCallback) {
  const modelId = chooseModelId()
  const cachedKey = modelCacheKey(modelId)
  let cached = false
  try { cached = localStorage.getItem(cachedKey) === '1' } catch { /* best effort */ }

  const message = await requestWorker('prepare', modelId, undefined, progress => {
    if (!cached) onProgress?.(progress)
  })

  if (message.type !== 'result') throw new Error('Voice engine did not finish initializing.')
  try { localStorage.setItem(cachedKey, '1') } catch { /* best effort */ }
}

type ProgressCallback = (progress: number) => void

export async function transcribeVoice(blob: Blob, durationMs: number, onProgress?: ProgressCallback, onPhase?: VoicePhaseCallback) {
  if (durationMs < 450) throw new Error('The recording is too short.')
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') throw new Error('Offline voice is not supported in this environment.')
  if (!blob.size) throw new Error('The microphone recording was empty. Please try again.')
  if (durationMs > 16_000) throw new Error('Recording is too long. Try a shorter voice command.')
  if (activeTranscriptionPromise) throw new Error('A previous voice transcription is still finishing. Please wait a moment and try again.')

  activeTranscriptionPromise = (async () => {
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

    const modelId = chooseModelId()
    try {
      onPhase?.('local')
      const result = await requestWorker('transcribe', modelId, audioData, undefined, 20_000)
      if (result.type !== 'result' || !result.result.text) throw new Error('The local voice engine returned no transcript.')
      return result.result.text
    } catch (localError) {
      resetWorker()
      if (navigator.onLine) {
        onPhase?.('online-fallback')
        try {
          return await transcribeOnline(blob)
        } catch (onlineError) {
          const localMessage = localError instanceof Error ? localError.message : 'Local transcription failed.'
          const onlineMessage = onlineError instanceof Error ? onlineError.message : 'Online transcription failed.'
          throw new Error(`${localMessage} Online backup also failed: ${onlineMessage}`)
        }
      }
      const detail = localError instanceof Error ? localError.message : 'Local voice transcription failed.'
      throw new Error(`${detail} Voice remains available offline, but this recording could not be processed.`)
    } finally {
      audioData = new Float32Array(0)
    }
  })().finally(() => {
    activeTranscriptionPromise = null
  })

  return activeTranscriptionPromise
}

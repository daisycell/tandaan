let worker: Worker | null = null
let requestId = 0
let activeTranscription = false
let readyModel: ModelId | null = null

const pending = new Map<number, {
  resolve: (value: WorkerResponse) => void
  reject: (reason?: unknown) => void
  timer?: number
  onProgress?: (progress: number) => void
}>()

type WorkerResponse = {
  id: number
  type: 'progress' | 'ready' | 'result' | 'error'
  progress?: number
  cached?: boolean
  text?: string
  error?: string
  fatal?: boolean
}

type ModelId = 'Xenova/whisper-tiny' | 'Xenova/whisper-base'

export type VoiceCaptureResult = { blob: Blob; durationMs: number }
export type VoiceRecorder = {
  stop: () => Promise<VoiceCaptureResult>
  cancel: () => void
  finished: Promise<VoiceCaptureResult>
}
export type VoicePhase = 'checking-model' | 'loading-model' | 'recording' | 'transcribing' | 'ready'
export type VoicePhaseCallback = (phase: VoicePhase) => void
export type ProgressCallback = (progress: number) => void

class VoiceWorkerError extends Error {
  fatal: boolean
  constructor(message: string, fatal = false) {
    super(message)
    this.name = 'VoiceWorkerError'
    this.fatal = fatal
  }
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

function chooseModelId(): ModelId {
  return isMobileDevice() ? 'Xenova/whisper-tiny' : 'Xenova/whisper-base'
}

function createWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./voiceWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = event => {
    const message = event.data as WorkerResponse
    const request = pending.get(message.id)
    if (!request) return
    if (message.type === 'progress') {
      request.onProgress?.(message.progress ?? 0)
      return
    }
    if (request.timer) window.clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.type === 'error') request.reject(new VoiceWorkerError(message.error || 'Voice engine error.', Boolean(message.fatal)))
    else request.resolve(message)
  }
  worker.onerror = event => {
    const error = new Error(event.message || 'Voice engine stopped unexpectedly.')
    for (const [id, request] of pending) {
      if (request.timer) window.clearTimeout(request.timer)
      request.reject(error)
      pending.delete(id)
    }
    worker?.terminate()
    worker = null
    readyModel = null
  }
  return worker
}

function resetWorker() {
  worker?.terminate()
  worker = null
  readyModel = null
  for (const [id, request] of pending) {
    if (request.timer) window.clearTimeout(request.timer)
    request.reject(new Error('Voice engine reset.'))
    pending.delete(id)
  }
}

function requestWorker(
  type: 'prepare' | 'transcribe',
  modelId: ModelId,
  payload?: Float32Array,
  opts?: { onProgress?: (progress: number) => void; timeoutMs?: number; online?: boolean },
) {
  const id = ++requestId
  return new Promise<WorkerResponse>((resolve, reject) => {
    const request = { resolve, reject, onProgress: opts?.onProgress, timer: undefined as number | undefined }
    if (opts?.timeoutMs) {
      request.timer = window.setTimeout(() => {
        pending.delete(id)
        resetWorker()
        reject(new Error('Local voice transcription timed out.'))
      }, opts.timeoutMs)
    }
    pending.set(id, request)
    try {
      const message = type === 'prepare'
        ? { id, type, modelId, online: opts?.online !== false }
        : { id, type, modelId, audio: payload }
      createWorker().postMessage(message, payload ? [payload.buffer] : [])
    } catch (error) {
      pending.delete(id)
      if (request.timer) window.clearTimeout(request.timer)
      reject(error)
    }
  })
}

function preferredMimeType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return types.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || ''
}

export async function startVoiceCapture(onLevel?: (level: number) => void, maxDurationMs = 8_000): Promise<VoiceRecorder> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Microphone recording is not supported on this device.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true, channelCount: 1 },
  })
  const mimeType = preferredMimeType()
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, bitsPerSecond: 24_000 } : undefined)
  const chunks: Blob[] = []
  const startedAt = performance.now()
  let settled = false
  let timer = 0
  let levelTimer = 0
  let resolveFinished!: (value: VoiceCaptureResult) => void
  let rejectFinished!: (reason?: unknown) => void
  const finished = new Promise<VoiceCaptureResult>((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })

  // Capture itself intentionally uses MediaRecorder only. We don't create an AudioContext
  // during recording, reducing standalone-PWA audio lifecycle problems on iOS.
  const cleanup = () => {
    window.clearTimeout(timer)
    window.clearInterval(levelTimer)
    stream.getTracks().forEach(track => track.stop())
    onLevel?.(0)
  }

  const finish = () => {
    if (settled) return finished
    settled = true
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
      cleanup()
      resolveFinished({ blob, durationMs: Math.round(performance.now() - startedAt) })
    }
    recorder.onerror = () => {
      cleanup()
      rejectFinished(new Error('Microphone recording failed.'))
    }
    try {
      recorder.stop()
    } catch {
      cleanup()
      rejectFinished(new Error('Microphone recording could not be stopped.'))
    }
    return finished
  }

  const cancel = (message = 'Recording was interrupted.') => {
    if (settled) return
    settled = true
    window.clearTimeout(timer)
    recorder.onstop = cleanup
    try { recorder.stop() } catch { cleanup() }
    rejectFinished(new Error(message))
  }

  const visibilityHandler = () => {
    if (document.visibilityState !== 'visible') cancel('Recording was interrupted because Tandaan left the foreground.')
  }
  const pageHideHandler = () => cancel('Recording was interrupted because Tandaan was backgrounded.')
  document.addEventListener('visibilitychange', visibilityHandler)
  window.addEventListener('pagehide', pageHideHandler)

  recorder.ondataavailable = event => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  recorder.start(250)
  timer = window.setTimeout(() => { void finish() }, maxDurationMs)
  // Keep the visual meter alive without touching the recorded audio path.
  levelTimer = window.setInterval(() => onLevel?.(0.18), 120)

  finished.finally(() => {
    document.removeEventListener('visibilitychange', visibilityHandler)
    window.removeEventListener('pagehide', pageHideHandler)
  }).catch(() => undefined)

  return { stop: finish, cancel: () => cancel(), finished }
}

async function decodeTo16kMono(blob: Blob) {
  if (typeof AudioContext === 'undefined') throw new Error('This browser cannot decode recorded audio for local transcription.')
  const context = new AudioContext()
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer())
    const mono = new Float32Array(buffer.length)
    const channels = buffer.numberOfChannels
    for (let ch = 0; ch < channels; ch += 1) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / channels
    }
    const targetRate = 16_000
    const targetLength = Math.max(1, Math.round(mono.length * targetRate / buffer.sampleRate))
    const out = new Float32Array(targetLength)
    const ratio = buffer.sampleRate / targetRate
    for (let i = 0; i < targetLength; i += 1) {
      const sourceIndex = i * ratio
      const left = Math.floor(sourceIndex)
      const right = Math.min(mono.length - 1, left + 1)
      const mix = sourceIndex - left
      out[i] = mono[Math.min(mono.length - 1, left)] * (1 - mix) + mono[right] * mix
    }
    return trimSilence(out)
  } finally {
    await context.close().catch(() => undefined)
  }
}

function trimSilence(audio: Float32Array) {
  if (audio.length < 2_000) return audio
  const frame = 320
  const threshold = 0.01
  let first = 0
  let last = audio.length
  let found = false
  for (let i = 0; i < audio.length; i += frame) {
    const end = Math.min(audio.length, i + frame)
    let sum = 0
    for (let j = i; j < end; j += 1) sum += audio[j] * audio[j]
    if (Math.sqrt(sum / Math.max(1, end - i)) >= threshold) { first = i; found = true; break }
  }
  if (!found) return audio
  for (let end = audio.length; end > 0; end -= frame) {
    const start = Math.max(0, end - frame)
    let sum = 0
    for (let j = start; j < end; j += 1) sum += audio[j] * audio[j]
    if (Math.sqrt(sum / Math.max(1, end - start)) >= threshold) { last = end; break }
  }
  const pad = 1_600
  return audio.slice(Math.max(0, first - pad), Math.min(audio.length, last + pad))
}

export async function prepareVoice(onProgress?: ProgressCallback) {
  const modelId = chooseModelId()
  if (readyModel === modelId && worker) return { modelId, cached: true }
  const online = navigator.onLine !== false
  const result = await requestWorker('prepare', modelId, undefined, {
    online,
    timeoutMs: online ? 120_000 : 30_000,
    onProgress,
  })
  if (result.type !== 'ready') throw new Error('Voice model did not finish loading.')
  readyModel = modelId
  return { modelId, cached: Boolean(result.cached) }
}

export async function transcribeVoice(blob: Blob, durationMs: number) {
  if (activeTranscription) throw new Error('Voice is already transcribing. Please wait for it to finish.')
  if (durationMs < 450) throw new Error('The recording is too short. Try speaking for 3–6 seconds.')
  if (durationMs > 8_500) throw new Error('Recording was too long. Try a short 3–6 second command.')
  if (!blob.size) throw new Error('The microphone recording was empty.')

  activeTranscription = true
  try {
    const audio = await decodeTo16kMono(blob)
    const modelId = chooseModelId()
    const result = await requestWorker('transcribe', modelId, audio, { timeoutMs: 18_000 })
    if (result.type !== 'result' || !result.text) throw new Error(result.error || 'Local voice transcription returned no text.')
    return result.text
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local voice transcription failed.'
    if (error instanceof VoiceWorkerError && error.fatal) {
      resetWorker()
    }
    throw new Error(message)
  } finally {
    activeTranscription = false
  }
}

export function cancelVoiceEngine() {
  resetWorker()
  activeTranscription = false
}

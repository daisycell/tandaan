import { supabase } from './supabase'
import { getUserId } from './sync'

export type VoiceCaptureResult = {
  blob: Blob
  durationMs: number
}

export type VoiceRecorder = {
  stop: () => Promise<VoiceCaptureResult>
  cancel: () => void
}

function preferredMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return types.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || ''
}

export async function startVoiceCapture(onLevel?: (level: number) => void, maxDurationMs = 30_000): Promise<VoiceRecorder> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Microphone recording is not supported by this browser.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      channelCount: 1
    }
  })

  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
  const data = new Uint8Array(analyser.fftSize)
  const mimeType = preferredMimeType()
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, bitsPerSecond: 32_000 } : undefined)
  const chunks: Blob[] = []
  const startedAt = performance.now()
  let animation = 0
  let finished = false
  let speechStarted = false
  let silenceStartedAt = 0
  const silenceThreshold = 0.045
  const silenceDurationMs = 1_600

  let stop: () => Promise<VoiceCaptureResult>

  const updateLevel = () => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    const level = Math.min(1, rms * 4)
    onLevel?.(level)

    if (rms > silenceThreshold) {
      speechStarted = true
      silenceStartedAt = 0
    } else if (speechStarted) {
      if (!silenceStartedAt) silenceStartedAt = performance.now()
      else if (performance.now() - silenceStartedAt >= silenceDurationMs && !finished) void stop()
    }
    animation = requestAnimationFrame(updateLevel)
  }

  const cleanup = async () => {
    cancelAnimationFrame(animation)
    source.disconnect()
    analyser.disconnect()
    for (const track of stream.getTracks()) track.stop()
    await ctx.close().catch(() => undefined)
    onLevel?.(0)
  }

  stop = () => new Promise<VoiceCaptureResult>((resolve, reject) => {
    if (finished) return reject(new Error('Recording has already ended.'))
    finished = true

    recorder.onstop = () => {
      clearTimeout(timer)
      cleanup()
        .then(() => {
          resolve({
            blob: new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }),
            durationMs: Math.round(performance.now() - startedAt)
          })
        })
        .catch(() => {
          resolve({
            blob: new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }),
            durationMs: Math.round(performance.now() - startedAt)
          })
        })
    }

    recorder.onerror = () => {
      clearTimeout(timer)
      cleanup().finally(() => reject(new Error('Recording failed.')))
    }

    try {
      recorder.stop()
    } catch {
      cleanup().finally(() => reject(new Error('Recording could not be stopped.')))
    }
  })

  const cancel = () => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    recorder.onstop = () => { void cleanup() }
    try { recorder.stop() } catch { void cleanup() }
  }

  recorder.ondataavailable = event => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  recorder.start(250)
  updateLevel()

  const timer = window.setTimeout(() => { void stop() }, maxDurationMs)

  return { stop, cancel }
}

export async function transcribeVoice(blob: Blob, durationMs: number) {
  if (blob.size > 25 * 1024 * 1024) throw new Error('The recording is too large. Please keep voice entries short.')
  if (durationMs < 350) throw new Error('The recording is too short.')

  const mimeType = blob.type || 'audio/webm'
  if (!supabase) throw new Error('Tandaan voice is not configured.')

  let sessionResult = await supabase.auth.getSession()
  let token = sessionResult.data.session?.access_token
  if (!token) {
    try {
      await getUserId()
      sessionResult = await supabase.auth.getSession()
      token = sessionResult.data.session?.access_token
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reconnect Tandaan.'
      throw new Error(`Voice needs a Tandaan session. ${message}`)
    }
  }
  if (!token) throw new Error('Voice needs a Tandaan session. Please open Tandaan online once and try again.')

  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 45_000)
  try {
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeType
      },
      cache: 'no-store',
      body: blob,
      signal: controller.signal
    })

    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : { error: (await response.text()).slice(0, 260) }

    if (!response.ok) {
      const detail = typeof payload?.error === 'string' && payload.error.trim() ? payload.error.trim() : `Voice service returned HTTP ${response.status}.`
      throw new Error(detail)
    }
    if (!payload?.text) throw new Error('No speech was recognized. Try speaking a little closer to the phone.')
    return String(payload.text).trim()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Voice transcription is taking too long. Try a shorter phrase, then try again.')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

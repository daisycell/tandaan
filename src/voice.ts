import { supabase } from './supabase'
import { getUserId } from './sync'

export type VoiceCaptureResult = { blob: Blob; durationMs: number }
export type VoiceRecorder = { stop: () => Promise<VoiceCaptureResult>; cancel: () => void }

function preferredMimeType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return types.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || ''
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
    for (let i = 0; i < data.length; i += 1) { const v = (data[i] - 128) / 128; sum += v * v }
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

export async function transcribeVoice(blob: Blob, durationMs: number) {
  if (blob.size > 4 * 1024 * 1024) throw new Error('The recording is too large. Please keep voice entries short.')
  if (durationMs < 350) throw new Error('The recording is too short.')
  if (!supabase) throw new Error('Tandaan voice is not configured.')

  let session = (await supabase.auth.getSession()).data.session
  if (!session) {
    await getUserId()
    session = (await supabase.auth.getSession()).data.session
  }
  if (!session?.access_token) throw new Error('Voice needs a Tandaan session. Please open Tandaan online once and try again.')

  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 18_000)
  try {
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': blob.type || 'audio/webm' },
      cache: 'no-store',
      body: blob,
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Voice service returned HTTP ${response.status}.`)
    if (!payload?.text) throw new Error('No speech was recognized. Try speaking a little closer to the phone.')
    return String(payload.text).trim()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Voice transcription took too long. Try a shorter phrase, then try again.')
    if (error instanceof TypeError) throw new Error('Could not reach the voice service. Check your internet connection and try again.')
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

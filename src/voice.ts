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
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return types.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || ''
}

async function to16kMonoWav(blob: Blob): Promise<Blob> {
  try {
    const context = new AudioContext()
    const buffer = await context.decodeAudioData(await blob.arrayBuffer())
    const sampleRate = 16_000
    const length = Math.max(1, Math.floor(buffer.duration * sampleRate))
    const mono = new Float32Array(length)
    const channels = buffer.numberOfChannels

    for (let i = 0; i < length; i += 1) {
      const sourcePosition = Math.min(buffer.length - 1, Math.floor(i * buffer.sampleRate / sampleRate))
      let sum = 0
      for (let channel = 0; channel < channels; channel += 1) {
        sum += buffer.getChannelData(channel)[sourcePosition] || 0
      }
      mono[i] = Math.max(-1, Math.min(1, sum / channels))
    }

    const wav = encodeWav16(mono, sampleRate)
    await context.close().catch(() => undefined)
    return wav
  } catch {
    return blob
  }
}

function encodeWav16(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2
  const dataLength = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataLength, true)

  let offset = 44
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export async function startVoiceCapture(onLevel?: (level: number) => void, maxDurationMs = 20_000): Promise<VoiceRecorder> {
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
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, bitsPerSecond: 24_000 } : undefined)
  const chunks: Blob[] = []
  const startedAt = performance.now()
  let animation = 0
  let finished = false
  let speechStarted = false
  let silenceStartedAt = 0
  const silenceThreshold = 0.045
  const silenceDurationMs = 1_200

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
    recorder.onstop = async () => {
      clearTimeout(timer)
      await cleanup()
      resolve({
        blob: new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }),
        durationMs: Math.round(performance.now() - startedAt)
      })
    }
    recorder.onerror = async () => {
      clearTimeout(timer)
      await cleanup()
      reject(new Error('Recording failed.'))
    }
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

  recorder.ondataavailable = event => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  recorder.start(200)
  updateLevel()

  const timer = window.setTimeout(() => { void stop() }, maxDurationMs)

  return { stop, cancel }
}

export async function transcribeVoice(blob: Blob, durationMs: number) {
  if (blob.size > 4 * 1024 * 1024) throw new Error('The recording is too large. Please keep voice entries short.')
  if (durationMs < 350) throw new Error('The recording is too short.')
  if (!supabase) throw new Error('Tandaan voice is not configured.')

  const sessionResult = await supabase.auth.getSession()
  const token = sessionResult.data.session?.access_token
  if (!token) {
    try {
      await getUserId()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reconnect Tandaan.'
      throw new Error(`Voice needs a Tandaan session. ${message}`)
    }
  }

  const refreshed = await supabase.auth.getSession()
  const accessToken = refreshed.data.session?.access_token
  if (!accessToken) throw new Error('Voice needs a Tandaan session. Please open Tandaan online once and try again.')

  const prepared = await to16kMonoWav(blob)
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 32_000)
  try {
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': prepared.type || 'audio/wav'
      },
      cache: 'no-store',
      body: prepared,
      signal: controller.signal
    })

    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : { error: (await response.text()).slice(0, 300) }

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

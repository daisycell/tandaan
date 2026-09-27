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

export async function startVoiceCapture(onLevel?: (level: number) => void, maxDurationMs = 90_000): Promise<VoiceRecorder> {
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
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  const startedAt = performance.now()
  let animation = 0
  let finished = false

  const updateLevel = () => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    onLevel?.(Math.min(1, rms * 3.5))
    animation = requestAnimationFrame(updateLevel)
  }
  updateLevel()

  const cleanup = async () => {
    cancelAnimationFrame(animation)
    source.disconnect()
    analyser.disconnect()
    for (const track of stream.getTracks()) track.stop()
    await ctx.close().catch(() => undefined)
    onLevel?.(0)
  }

  const stop = () => new Promise<VoiceCaptureResult>((resolve, reject) => {
    if (finished) return reject(new Error('Recording has already ended.'))
    finished = true
    recorder.onstop = async () => {
      clearTimeout(timer)
      await cleanup()
      resolve({
        blob: new Blob(chunks, { type: recorder.mimeType || blobTypeFallback() }),
        durationMs: Math.round(performance.now() - startedAt)
      })
    }
    recorder.onerror = async () => {
      clearTimeout(timer)
      await cleanup()
      reject(new Error('Recording failed.'))
    }
    recorder.stop()
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

  const timer = window.setTimeout(() => { void stop() }, maxDurationMs)

  return { stop, cancel }
}

function blobTypeFallback() {
  return 'audio/webm'
}

export async function transcribeVoice(blob: Blob, durationMs: number) {
  if (blob.size > 25 * 1024 * 1024) throw new Error('The recording is too large. Please keep voice entries short.')
  if (durationMs < 350) throw new Error('The recording is too short.')

  const mimeType = blob.type || 'audio/webm'

  const supabaseModule = await import('./supabase')
  const syncModule = await import('./sync')
  if (!supabaseModule.supabase) throw new Error('Tandaan voice is not configured.')

  let sessionResult = await supabaseModule.supabase.auth.getSession()
  let token = sessionResult.data.session?.access_token
  if (!token) {
    try {
      await syncModule.getUserId()
      sessionResult = await supabaseModule.supabase.auth.getSession()
      token = sessionResult.data.session?.access_token
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reconnect Tandaan.'
      throw new Error(`Voice needs a Tandaan session. ${message}`)
    }
  }
  if (!token) throw new Error('Voice needs a Tandaan session. Please open Tandaan online once and try again.')

  let response: Response
  try {
    response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeType
      },
      cache: 'no-store',
      body: blob
    })
  } catch {
    throw new Error('Could not reach Tandaan voice service. Check your internet connection and try again.')
  }

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : { error: (await response.text()).slice(0, 220) }

  if (!response.ok) {
    const detail = typeof payload?.error === 'string' && payload.error.trim() ? payload.error.trim() : `Voice service returned HTTP ${response.status}.`
    throw new Error(detail)
  }
  if (!payload?.text) throw new Error('No speech was recognized. Try speaking a little closer to the phone.')
  return String(payload.text).trim()
}

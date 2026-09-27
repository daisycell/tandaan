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

  const form = new FormData()
  const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'
  form.append('file', new File([blob], `tandaan-voice.${extension}`, { type: blob.type || 'audio/webm' }))
  form.append('model', 'whisper-large-v3-turbo')

  const supabaseModule = await import('./supabase')
  const sessionResult = supabaseModule.supabase ? await supabaseModule.supabase.auth.getSession() : null
  const token = sessionResult?.data.session?.access_token
  if (!token) throw new Error('Please reconnect to Tandaan before using voice input.')

  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Transcription failed.')
  if (!payload?.text) throw new Error('No speech was recognized.')
  return String(payload.text).trim()
}

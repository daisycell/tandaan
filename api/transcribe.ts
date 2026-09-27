import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 30

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
function env(name: string) { return process.env[name]?.trim() || '' }
function extensionForMime(mime: string) {
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('flac')) return 'flac'
  return 'webm'
}
function errorMessage(status: number, detail: string) {
  if (status === 401) return 'Voice service authentication failed. Check GROQ_API_KEY.'
  if (status === 403) return 'Voice service access was denied. Check the Groq API key and account.'
  if (status === 413) return 'The voice recording is too large. Please keep it short.'
  if (status === 429) return 'Voice service is busy right now. Please try again in a moment.'
  if (status >= 500) return 'The voice service is temporarily unavailable. Please try again.'
  return detail || `Voice service returned HTTP ${status}.`
}

export default async function handler(req: Request) {
  const startedAt = Date.now()
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
    const groqKey = env('GROQ_API_KEY')
    const supabaseUrl = env('SUPABASE_URL') || env('VITE_SUPABASE_URL')
    const supabaseKey = env('SUPABASE_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY') || env('VITE_SUPABASE_PUBLISHABLE_KEY')
    const authorization = req.headers.get('authorization')
    if (!groqKey) return json({ error: 'Voice transcription is not configured. GROQ_API_KEY is missing.' }, 503)
    if (!supabaseUrl || !supabaseKey || !authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required.' }, 401)

    const authClient = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const token = authorization.slice(7).trim()
    const { data: claimsData, error: claimsError } = await authClient.auth.getClaims(token)
    if (claimsError || !claimsData?.claims?.sub) return json({ error: 'Invalid Tandaan session.' }, 401)

    const raw = Buffer.from(await req.arrayBuffer())
    if (!raw.length) return json({ error: 'Audio file is missing.' }, 400)
    if (raw.length > 4 * 1024 * 1024) return json({ error: 'Audio file is too large. Please keep recordings short.' }, 413)

    const incomingType = (req.headers.get('content-type') || 'audio/webm').split(';')[0].toLowerCase()
    const mime = incomingType.startsWith('audio/') ? incomingType : 'audio/webm'
    const form = new FormData()
    form.append('file', new File([raw], `tandaan-voice.${extensionForMime(mime)}`, { type: mime }))
    form.append('model', 'whisper-large-v3-turbo')
    form.append('response_format', 'text')
    form.append('temperature', '0')
    form.append('prompt', 'Philippine household shopping words: bugas, itlog, habon, shampoo, toothpaste, kalamay, delata, kilo, tray, lata, pulo, isa, duha, tatlo, apat, lima, palit, mabakal, nabakal.')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    try {
      const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${groqKey}` }, body: form, signal: controller.signal })
      const body = await groqResponse.text()
      if (!groqResponse.ok) {
        let detail = body.slice(0, 400)
        try {
          const parsed = JSON.parse(body) as { error?: { message?: string } | string }
          if (typeof parsed.error === 'string') detail = parsed.error
          else if (parsed.error?.message) detail = parsed.error.message
        } catch { /* keep text */ }
        return json({ error: errorMessage(groqResponse.status, detail) }, groqResponse.status)
      }
      const text = body.trim()
      if (!text) return json({ error: 'No speech was recognized. Try speaking a little closer to the phone.' }, 422)
      console.info('Tandaan transcription completed', { durationMs: Date.now() - startedAt, audioBytes: raw.length, mime })
      return json({ text })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return json({ error: 'The transcription service took too long to respond.' }, 504)
      throw error
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    console.error('Tandaan /api/transcribe error', { durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) })
    return json({ error: 'The voice server encountered an unexpected error. Please try again.' }, 500)
  }
}

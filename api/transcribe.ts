import { createClient } from '@supabase/supabase-js'

export const runtime = 'edge'
export const maxDuration = 60

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  })
}

function env(name: string) {
  return process.env[name]?.trim() || ''
}

function extensionForMime(mime: string) {
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  return 'webm'
}

export default async function handler(req: Request) {
  const startedAt = Date.now()
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

    const groqKey = env('GROQ_API_KEY')
    const supabaseUrl = env('SUPABASE_URL') || env('VITE_SUPABASE_URL')
    const supabaseKey = env('SUPABASE_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY') || env('VITE_SUPABASE_PUBLISHABLE_KEY')
    const authorization = req.headers.get('authorization')

    if (!supabaseUrl || !supabaseKey || !authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required.' }, 401)
    if (!groqKey) return json({ error: 'Voice transcription is not configured. GROQ_API_KEY is missing.' }, 503)

    const token = authorization.slice('Bearer '.length).trim()
    const authClient = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: claimsData, error: claimsError } = await authClient.auth.getClaims(token)
    if (claimsError || !claimsData?.claims?.sub) return json({ error: 'Invalid Tandaan session.' }, 401)

    const raw = await req.arrayBuffer()
    if (raw.byteLength === 0) return json({ error: 'Audio file is missing.' }, 400)
    if (raw.byteLength > 25 * 1024 * 1024) return json({ error: 'Audio file is too large. Keep recordings under 25 MB.' }, 413)

    const requestContentType = (req.headers.get('content-type') || 'audio/webm').split(';')[0].toLowerCase()
    const mime = requestContentType.startsWith('audio/') ? requestContentType : 'audio/webm'
    const filename = `tandaan-voice.${extensionForMime(mime)}`

    const form = new FormData()
    form.append('file', new Blob([raw], { type: mime }), filename)
    form.append('model', 'whisper-large-v3-turbo')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    form.append('prompt', 'Philippine household and shopping vocabulary: bugas, itlog, habon, shampoo, toothpaste, kalamay delata, kilo, tray, lata, pulo, duha, tatlo, apat, lima, pesos, palit, mabakal, nabakal, buy, bought, tomorrow, today.')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    let groqResponse: Response
    try {
      groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}` },
        body: form,
        signal: controller.signal,
        cache: 'no-store'
      })
    } finally {
      clearTimeout(timeout)
    }

    const payload = await groqResponse.json().catch(() => ({})) as { text?: string; error?: { message?: string } | string }
    if (!groqResponse.ok) {
      const providerMessage = typeof payload.error === 'string' ? payload.error : payload.error?.message
      if (groqResponse.status === 429) return json({ error: 'Voice service is busy right now. Please try again in a moment.' }, 429)
      if (groqResponse.status === 401) return json({ error: 'Voice service authentication failed. Check the Groq API key in Vercel.' }, 502)
      return json({ error: providerMessage || `Voice provider returned HTTP ${groqResponse.status}.` }, 502)
    }

    const text = String(payload.text || '').trim()
    if (!text) return json({ error: 'No speech was recognized. Try speaking a little closer to the phone.' }, 422)

    console.info('Tandaan transcription completed', { durationMs: Date.now() - startedAt, audioBytes: raw.byteLength })
    return json({ text })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Tandaan /api/transcribe error', { durationMs: Date.now() - startedAt, error: message })
    if (/aborted|timeout/i.test(message)) return json({ error: 'Voice transcription took too long. Try a shorter phrase.' }, 504)
    return json({ error: 'Voice transcription is temporarily unavailable. Please try again.' }, 500)
  }
}

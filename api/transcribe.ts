import { createClient } from '@supabase/supabase-js'
import Groq, { toFile } from 'groq-sdk'

export const runtime = 'nodejs'
export const maxDuration = 120

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

export default async function handler(req: Request) {
  const startedAt = Date.now()
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

    const groqKey = env('GROQ_API_KEY')
    const supabaseUrl = env('SUPABASE_URL') || env('VITE_SUPABASE_URL')
    const supabaseKey = env('SUPABASE_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY') || env('VITE_SUPABASE_PUBLISHABLE_KEY')
    const authorization = req.headers.get('authorization')

    if (!supabaseUrl || !supabaseKey || !authorization?.startsWith('Bearer ')) {
      return json({ error: 'Authentication required.' }, 401)
    }
    if (!groqKey) {
      return json({ error: 'Voice transcription is not configured. GROQ_API_KEY is missing.' }, 503)
    }

    const token = authorization.slice('Bearer '.length).trim()
    const authClient = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
    const { data: claimsData, error: claimsError } = await authClient.auth.getClaims(token)
    if (claimsError || !claimsData?.claims?.sub) return json({ error: 'Invalid Tandaan session.' }, 401)

    const raw = new Uint8Array(await req.arrayBuffer())
    if (raw.byteLength === 0) return json({ error: 'Audio file is missing.' }, 400)
    if (raw.byteLength > 25 * 1024 * 1024) {
      return json({ error: 'Audio file is too large. Keep recordings under 25 MB.' }, 413)
    }

    const requestContentType = (req.headers.get('content-type') || 'audio/webm').split(';')[0].toLowerCase()
    const mime = requestContentType.startsWith('audio/') ? requestContentType : 'audio/webm'
    const extension = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm'

    // Use the official Groq SDK so multipart encoding, timeouts, and retries
    // are handled by the provider-supported client instead of hand-building it.
    const groq = new Groq({
      apiKey: groqKey,
      timeout: 20_000,
      maxRetries: 0
    })

    const file = await toFile(Buffer.from(raw), `tandaan-voice.${extension}`, { type: mime })
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3-turbo',
      response_format: 'json',
      temperature: 0,
      prompt: 'Philippine household and shopping vocabulary: bugas, itlog, habon, shampoo, toothpaste, kalamay delata, kilo, tray, lata, pulo, duha, tatlo, apat, lima, pesos, palit, mabakal, nabakal, buy, bought, tomorrow, today.'
    })

    const text = transcription.text?.trim() || ''
    if (!text) return json({ error: 'No speech was recognized. Try speaking a little closer to the phone.' }, 422)

    console.info('Tandaan transcription completed', {
      durationMs: Date.now() - startedAt,
      audioBytes: raw.byteLength
    })

    return json({ text })
  } catch (error) {
    const durationMs = Date.now() - startedAt
    console.error('Tandaan /api/transcribe error', {
      durationMs,
      error: error instanceof Error ? error.message : String(error)
    })

    let message = error instanceof Error ? error.message : 'Unexpected voice service error.'
    const status = (error as { status?: number })?.status
    if (status === 429) message = 'Voice service is busy right now. Please try again in a moment.'
    if (status === 401) message = 'Voice service authentication failed. Check the Groq API key in Vercel.'
    if (/timeout/i.test(message)) message = 'Voice transcription took too long. Please try a shorter recording.'

    return json({ error: message }, 500)
  }
}

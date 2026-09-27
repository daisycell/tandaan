import { createClient } from '@supabase/supabase-js'
import Groq, { toFile } from 'groq-sdk'

export const runtime = 'nodejs'
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
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('flac')) return 'flac'
  return 'webm'
}

function messageForError(error: unknown) {
  if (error instanceof Groq.APIError) {
    if (error.status === 401) return 'Voice service authentication failed. Please check the Groq API key in Vercel.'
    if (error.status === 403) return 'Voice service access was denied. Please check the Groq account and API key.'
    if (error.status === 413) return 'The voice recording is too large. Please keep it short.'
    if (error.status === 429) return 'Voice service is busy right now. Please try again in a moment.'
    if (error.status && error.status >= 500) return 'The voice service is temporarily unavailable. Please try again.'
    return error.message || 'Voice transcription failed.'
  }
  if (error instanceof Error && /timeout|timed out|aborted/i.test(error.message)) {
    return 'Voice transcription took too long. Try a shorter phrase.'
  }
  return 'Voice transcription is temporarily unavailable. Please try again.'
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
    if (!groqKey) return json({ error: 'Voice transcription is not configured. GROQ_API_KEY is missing.' }, 503)

    const token = authorization.slice('Bearer '.length).trim()
    const authClient = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
    const { data: claimsData, error: claimsError } = await authClient.auth.getClaims(token)
    if (claimsError || !claimsData?.claims?.sub) return json({ error: 'Invalid Tandaan session.' }, 401)

    const raw = Buffer.from(await req.arrayBuffer())
    if (raw.byteLength === 0) return json({ error: 'Audio file is missing.' }, 400)
    if (raw.byteLength > 4 * 1024 * 1024) {
      return json({ error: 'Audio file is too large. Please keep recordings short.' }, 413)
    }

    const requestContentType = (req.headers.get('content-type') || 'audio/webm').split(';')[0].toLowerCase()
    const mime = requestContentType.startsWith('audio/') ? requestContentType : 'audio/webm'
    const filename = `tandaan-voice.${extensionForMime(mime)}`

    const groq = new Groq({
      apiKey: groqKey,
      timeout: 25_000,
      maxRetries: 0
    })

    const file = await toFile(raw, filename, { type: mime })
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3-turbo',
      response_format: 'json',
      temperature: 0,
      // Keep this short: Groq notes prompts should match the audio language.
      prompt: 'Philippine household shopping words: bugas, itlog, habon, shampoo, toothpaste, kalamay, delata, kilo, tray, lata, pulo, duha, tatlo, apat, lima, palit, mabakal, nabakal.'
    })

    const text = String(transcription?.text || '').trim()
    if (!text) return json({ error: 'No speech was recognized. Try speaking a little closer to the phone.' }, 422)

    console.info('Tandaan transcription completed', {
      durationMs: Date.now() - startedAt,
      audioBytes: raw.byteLength,
      contentType: mime
    })
    return json({ text })
  } catch (error) {
    const message = messageForError(error)
    console.error('Tandaan /api/transcribe error', {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    return json({ error: message }, /timeout|timed out/i.test(message) ? 504 : 500)
  }
}

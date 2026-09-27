import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 30
export const regions = ['sin1']

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'

export default async function handler(req: Request) {
  if (req.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 })

  try {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!token) return Response.json({ error: 'Missing Tandaan session.' }, { status: 401 })

    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const verificationKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
    const groqKey = process.env.GROQ_API_KEY
    if (!supabaseUrl || !verificationKey || !groqKey) return Response.json({ error: 'Online voice fallback is not configured.' }, { status: 503 })

    const admin = createClient(supabaseUrl, verificationKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: userData, error: userError } = await admin.auth.getUser(token)
    if (userError || !userData.user) return Response.json({ error: 'Tandaan session is invalid.' }, { status: 401 })

    const contentType = req.headers.get('content-type') || 'audio/webm'
    const buffer = await req.arrayBuffer()
    if (!buffer.byteLength) return Response.json({ error: 'The microphone recording was empty.' }, { status: 400 })
    if (buffer.byteLength > 4 * 1024 * 1024) return Response.json({ error: 'The voice recording is too large.' }, { status: 413 })

    const filename = req.headers.get('x-voice-filename') || 'tandaan-voice.webm'
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: contentType }), filename)
    form.append('model', 'whisper-large-v3-turbo')
    form.append('response_format', 'text')
    form.append('temperature', '0')
    form.append('prompt', 'Philippine household speech. Common words include bugas, itlog, shampoo, habon, toothpaste, kalamay, delata, chicken, rice, oil, kilo, tray, pieces, pesos, 200, 400.')

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: form,
    })

    const text = await response.text()
    if (!response.ok) return Response.json({ error: `Groq transcription failed (${response.status}).` }, { status: 502 })
    if (!text.trim()) return Response.json({ error: 'No speech was recognized.' }, { status: 422 })

    return Response.json({ text: text.trim(), userId: userData.user.id })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unexpected online transcription error.'
    return Response.json({ error: detail }, { status: 500 })
  }
}

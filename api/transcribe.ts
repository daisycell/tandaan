export const runtime = 'nodejs'
export const maxDuration = 60

import { createClient } from '@supabase/supabase-js'

export default async function handler(req: Request) {
  if (req.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 })

  const key = process.env.GROQ_API_KEY
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  // Validate the caller with a server-side key when available. Fall back to the
  // browser publishable key so the endpoint also works during staged setup.
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const authorization = req.headers.get('authorization')
  if (!supabaseUrl || !supabaseKey || !authorization?.startsWith('Bearer ')) return Response.json({ error: 'Authentication required.' }, { status: 401 })
  const token = authorization.slice('Bearer '.length)
  const authClient = createClient(supabaseUrl, supabaseKey)
  const { data: userData, error: userError } = await authClient.auth.getUser(token)
  if (userError || !userData.user) return Response.json({ error: 'Invalid Tandaan session.' }, { status: 401 })
  if (!key) return Response.json({ error: 'Voice transcription is not configured yet. Add GROQ_API_KEY to Vercel.' }, { status: 503 })

  const incoming = await req.formData()
  const file = incoming.get('file')
  if (!file || typeof file !== 'object' || typeof (file as Blob).arrayBuffer !== 'function') {
    return Response.json({ error: 'Audio file is missing.' }, { status: 400 })
  }
  if (file.size > 25 * 1024 * 1024) return Response.json({ error: 'Audio file is too large. Keep recordings under 25 MB.' }, { status: 413 })

  const outbound = new FormData()
  const incomingFile = file as File
  outbound.append('file', incomingFile, incomingFile.name || 'tandaan-voice.webm')
  outbound.append('model', String(incoming.get('model') || 'whisper-large-v3-turbo'))
  outbound.append('response_format', 'json')
  outbound.append('temperature', '0')
  outbound.append('prompt', 'Tandaan context. Philippine languages and code-switching may include Hiligaynon/Ilonggo, Cebuano/Bisaya, Tagalog/Filipino, and English. Common words: bugas, itlog, mabakal, bakal, palit, nabakal, nakapalit, sang, kag, ka, kilo, kilos, tray, lata, pieces, pesos, baylo, kuryente.')

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: outbound
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || 'Groq transcription failed.'
    return Response.json({ error: String(message) }, { status: response.status })
  }

  return Response.json({ text: payload?.text || '' })
}

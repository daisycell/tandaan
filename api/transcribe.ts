export const runtime = 'nodejs'
export const maxDuration = 60

import { createClient } from '@supabase/supabase-js'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

export default async function handler(req: Request) {
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

    const groqKey = process.env.GROQ_API_KEY
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    const authorization = req.headers.get('authorization')

    if (!supabaseUrl || !supabaseKey || !authorization?.startsWith('Bearer ')) {
      return json({ error: 'Authentication required.' }, 401)
    }
    if (!groqKey) {
      return json({ error: 'Voice transcription is not configured yet. Add GROQ_API_KEY to Vercel.' }, 503)
    }

    const token = authorization.slice('Bearer '.length).trim()
    const authClient = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
    const { data: userData, error: userError } = await authClient.auth.getUser(token)
    if (userError || !userData.user) return json({ error: 'Invalid Tandaan session.' }, 401)

    const raw = new Uint8Array(await req.arrayBuffer())
    if (raw.byteLength === 0) return json({ error: 'Audio file is missing.' }, 400)
    if (raw.byteLength > 25 * 1024 * 1024) {
      return json({ error: 'Audio file is too large. Keep recordings under 25 MB.' }, 413)
    }

    const requestContentType = (req.headers.get('content-type') || 'audio/webm').split(';')[0].toLowerCase()
    const mime = requestContentType.startsWith('audio/') ? requestContentType : 'audio/webm'
    const extension = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'

    const outbound = new FormData()
    outbound.append('file', new File([raw], `tandaan-voice.${extension}`, { type: mime }))
    outbound.append('model', 'whisper-large-v3-turbo')
    outbound.append('response_format', 'json')
    outbound.append('temperature', '0')
    outbound.append('prompt', 'Tandaan context. Philippine languages and code-switching may include Hiligaynon/Ilonggo, Cebuano/Bisaya, Tagalog/Filipino, and English. Common words: bugas, itlog, mabakal, bakal, palit, nabakal, nakapalit, sang, kag, ka, kilo, kilos, tray, lata, pieces, pesos, baylo, kuryente.')

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: outbound
    })

    const content = await response.text()
    let payload: any = {}
    try {
      payload = JSON.parse(content)
    } catch {
      payload = { error: content.slice(0, 500) }
    }

    if (!response.ok) {
      const message = payload?.error?.message || payload?.error || 'Groq transcription failed.'
      return json({ error: String(message) }, response.status)
    }

    const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
    if (!text) return json({ error: 'No speech was recognized. Try speaking a little closer to the phone.' }, 422)

    return json({ text })
  } catch (error) {
    console.error('Tandaan /api/transcribe error:', error)
    const message = error instanceof Error ? error.message : 'Unexpected voice service error.'
    return json({ error: message }, 500)
  }
}

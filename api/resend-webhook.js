// Vercel Serverless Function: POST /api/resend-webhook
//
// Receives Resend event webhooks and turns them into rows in `email_events`,
// which the notes wall renders as a live per-recipient activity feed.
//
// Linking events back to a note: every share-via-email send stores a `sent` row
// keyed by the Resend email id (see api/share-note.js). Resend delivers that
// same id on each webhook as `data.email_id`, so we resolve the note by looking
// up that `sent` row. As a fallback we also read the `note_id` tag that
// share-note.js attaches to the outbound email (echoed as `data.tags.note_id`).
//
// Only the four lifecycle events the UI cares about are recorded; any other
// event type is acknowledged with 200 so Resend does not retry it.
//
// SECURITY: this reuses the anon key and the open insert policy on
// `email_events` (the whole wall is public). A hardened deployment would verify
// the Svix signature headers (svix-id/svix-timestamp/svix-signature) with the
// webhook signing secret and write with the service_role key.

import { createClient } from '@supabase/supabase-js'

const RECORDED_EVENTS = new Set([
  'email.delivered',
  'email.opened',
  'email.clicked',
  'email.bounced',
])

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string' && req.body.length) {
    try {
      return JSON.parse(req.body)
    } catch {
      return null
    }
  }
  // Fallback: manually consume the stream (some runtimes don't pre-parse).
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: 'Server is not configured (missing Supabase env vars).' })
  }

  const payload = await readJsonBody(req)
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON body.' })
  }

  const eventType = typeof payload.type === 'string' ? payload.type : ''
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {}

  // Acknowledge unrecognised events without recording them (prevents retries).
  if (!RECORDED_EVENTS.has(eventType)) {
    return res.status(200).json({ ignored: eventType || null })
  }

  const messageId = typeof data.email_id === 'string' ? data.email_id : null
  const recipient = Array.isArray(data.to) ? data.to[0] : data.to
  if (!messageId || !recipient) {
    return res.status(400).json({ error: 'Webhook payload is missing email_id or recipient.' })
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey)

  // Resolve the note: prefer the `sent` row keyed by this email id, and fall
  // back to the `note_id` tag Resend echoes on the payload.
  let noteId = null
  const { data: sentRow, error: lookupError } = await supabase
    .from('email_events')
    .select('note_id')
    .eq('message_id', messageId)
    .not('note_id', 'is', null)
    .limit(1)
    .maybeSingle()

  if (lookupError) {
    return res.status(502).json({ error: `Could not look up note: ${lookupError.message}` })
  }
  if (sentRow?.note_id) noteId = sentRow.note_id
  else if (data.tags && typeof data.tags.note_id === 'string') noteId = data.tags.note_id

  // Record one row for this event. A null note_id is still stored so nothing is
  // silently dropped (it just will not attach to a note's feed).
  const { error: insertError } = await supabase.from('email_events').insert({
    message_id: messageId,
    note_id: noteId,
    recipient,
    event_type: eventType,
  })

  if (insertError) {
    return res.status(502).json({ error: `Could not record event: ${insertError.message}` })
  }

  return res.status(200).json({ ok: true, note_id: noteId, event_type: eventType })
}

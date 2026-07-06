// Vercel Serverless Function: POST /api/share-note
//
// Shares a single note by email via Resend. This runs SERVER-SIDE only — the
// RESEND_API_KEY lives in the Vercel/Local environment and is never exposed to
// the browser bundle (Vite only inlines VITE_/SUPABASE_ prefixed vars).
//
// Request body (JSON): { "to": "recipient@example.com", "noteId": "<uuid>" }
//
// The note content is fetched from Supabase by id here rather than trusted from
// the client, so this endpoint can only ever email a note that actually exists.

import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'

const APP_NAME = 'hello from Pioneer Species'

// Basic, permissive email shape check. The real validation is Resend's.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Derive the live notes page URL from the incoming request so the "back to
// notes" link always points at whatever domain served the app (preview or prod).
function appUrlFrom(req) {
  const explicit = process.env.NOTES_APP_URL
  if (explicit) return explicit.replace(/\/$/, '')
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return host ? `${proto}://${host}` : 'https://hello-pioneer-alpha.vercel.app'
}

function renderEmail({ content, createdAt, appUrl }) {
  const body = escapeHtml(content).replace(/\n/g, '<br />')
  const when = createdAt
    ? new Date(createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : ''

  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1a1e26;border:1px solid #2a2f3a;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:linear-gradient(135deg,#4f8cff,#8a5cff);padding:28px 32px;">
                <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.85);font-weight:600;">Shared note</div>
                <div style="font-size:22px;font-weight:700;color:#ffffff;margin-top:4px;">${escapeHtml(APP_NAME)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 8px;color:#9aa0aa;font-size:13px;">Someone shared this note with you:</p>
                <div style="background:#0f1115;border:1px solid #2a2f3a;border-radius:10px;padding:18px 20px;color:#e8eaed;font-size:16px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;">${body || '<em style="color:#9aa0aa;">(this note is empty)</em>'}</div>
                ${when ? `<p style="margin:14px 0 0;color:#6b7280;font-size:12px;">Posted ${escapeHtml(when)}</p>` : ''}
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                  <tr>
                    <td style="border-radius:10px;background:#4f8cff;">
                      <a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-weight:600;font-size:15px;text-decoration:none;">Open the notes wall →</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid #2a2f3a;">
                <a href="${escapeHtml(appUrl)}" style="color:#4f8cff;font-size:13px;text-decoration:none;">${escapeHtml(appUrl)}</a>
              </td>
            </tr>
          </table>
          <p style="max-width:560px;margin:16px auto 0;color:#6b7280;font-size:11px;text-align:center;">You received this because someone used the “Share via email” button on ${escapeHtml(APP_NAME)}.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

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

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Email is not configured (missing RESEND_API_KEY).' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: 'Server is not configured (missing Supabase env vars).' })
  }

  const payload = await readJsonBody(req)
  if (!payload) return res.status(400).json({ error: 'Invalid JSON body.' })

  const to = typeof payload.to === 'string' ? payload.to.trim() : ''
  const noteId = typeof payload.noteId === 'string' ? payload.noteId.trim() : ''

  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'A valid recipient email is required.' })
  if (!noteId) return res.status(400).json({ error: 'A noteId is required.' })

  // Fetch the note server-side so we only ever email real, existing content.
  const supabase = createClient(supabaseUrl, supabaseAnonKey)
  const { data: note, error: dbError } = await supabase
    .from('notes')
    .select('id, content, created_at')
    .eq('id', noteId)
    .maybeSingle()

  if (dbError) return res.status(502).json({ error: `Could not load the note: ${dbError.message}` })
  if (!note) return res.status(404).json({ error: 'That note no longer exists.' })

  const appUrl = appUrlFrom(req)
  const from = process.env.RESEND_FROM || `${APP_NAME} <onboarding@resend.dev>`

  const resend = new Resend(apiKey)
  const { data, error } = await resend.emails.send({
    from,
    to: [to],
    subject: `A note shared from ${APP_NAME}`,
    html: renderEmail({ content: note.content, createdAt: note.created_at, appUrl }),
  })

  if (error) {
    // Surface Resend's message (e.g. the test-mode "own address only" 403).
    const status = typeof error.statusCode === 'number' ? error.statusCode : 502
    return res.status(status).json({ error: error.message || 'Failed to send email.' })
  }

  return res.status(200).json({ id: data?.id ?? null })
}

import { createClient } from '@supabase/supabase-js'
import './style.css'

// Read configuration from environment variables. These are inlined at build
// time by Vite (see vite.config.js `envPrefix`). Locally they come from .env;
// on Vercel they come from the project's environment variables.
const supabaseUrl = import.meta.env.SUPABASE_URL
const supabaseAnonKey = import.meta.env.SUPABASE_ANON_KEY

const notesList = document.querySelector('#notes')
const form = document.querySelector('#note-form')
const input = document.querySelector('#note-input')
const submitBtn = document.querySelector('#submit-btn')
const statusEl = document.querySelector('#status')

function setStatus(message, kind = 'info') {
  statusEl.textContent = message
  statusEl.dataset.kind = kind
}

// Fail loudly and clearly if the environment is not configured, rather than
// letting the Supabase client throw an opaque error.
if (!supabaseUrl || !supabaseAnonKey) {
  notesList.innerHTML =
    '<li class="empty">Configuration missing: set SUPABASE_URL and SUPABASE_ANON_KEY ' +
    'in .env (local) and in the Vercel project (production), then rebuild.</li>'
  form.querySelectorAll('textarea, button').forEach((el) => (el.disabled = true))
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY.')
}

const supabase = createClient(supabaseUrl, supabaseAnonKey)

// The notes currently on the wall, and their email activity keyed by note id.
// Both are kept in memory so realtime inserts can re-render without a refetch.
let notesCache = []
let eventsByNote = new Map()

function formatTimestamp(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

// Escape arbitrary strings for safe interpolation into innerHTML.
function escapeHtml(value) {
  const el = document.createElement('div')
  el.textContent = value ?? ''
  return el.innerHTML
}

// Friendly, short labels for the raw event_type values stored in email_events.
const STATUS_LABELS = {
  sent: 'Sent',
  'email.delivered': 'Delivered',
  'email.opened': 'Opened',
  'email.clicked': 'Clicked',
  'email.bounced': 'Bounced',
}

// Group statuses into a handful of visual kinds for the status badge colour.
function statusKind(type) {
  if (type === 'email.bounced') return 'bounced'
  if (type === 'email.opened' || type === 'email.clicked') return 'engaged'
  if (type === 'email.delivered') return 'delivered'
  return 'sent'
}

// Compact relative time, e.g. "just now", "3m ago", "2h ago", "5d ago".
function formatRelative(value) {
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

// Build the small activity feed for one note: every recipient and the latest
// status seen for them, newest recipient first.
function renderActivity(noteId) {
  const events = eventsByNote.get(noteId)
  if (!events || events.length === 0) return ''

  const latestByRecipient = new Map()
  for (const event of events) {
    const current = latestByRecipient.get(event.recipient)
    if (!current || new Date(event.created_at) >= new Date(current.created_at)) {
      latestByRecipient.set(event.recipient, event)
    }
  }

  const items = [...latestByRecipient.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(
      (event) => `<li class="activity-item">
          <span class="activity-recipient">${escapeHtml(event.recipient)}</span>
          <span class="activity-status" data-kind="${statusKind(event.event_type)}">${escapeHtml(
        STATUS_LABELS[event.event_type] ?? event.event_type
      )}</span>
          <time class="activity-time" datetime="${escapeHtml(event.created_at)}">${escapeHtml(
        formatRelative(event.created_at)
      )}</time>
        </li>`
    )
    .join('')

  return `<ul class="activity" aria-label="Email activity">${items}</ul>`
}

function renderNotes(notes) {
  if (!notes || notes.length === 0) {
    notesList.innerHTML = '<li class="empty">No notes yet. Be the first to post one.</li>'
    return
  }
  notesList.innerHTML = notes
    .map((note) => {
      const time = formatTimestamp(note.created_at)
      // textContent-style escaping via a detached element keeps user content safe.
      const body = document.createElement('div')
      body.textContent = note.content ?? ''
      return `<li class="note" data-id="${note.id}">
        <p>${body.innerHTML}</p>
        <div class="note-footer">
          <time>${time}</time>
          <button type="button" class="share-btn" data-id="${note.id}">Share via email</button>
        </div>
        ${renderActivity(note.id)}
      </li>`
    })
    .join('')
}

// Share a note by email. The RESEND_API_KEY never touches the browser — this
// posts to the server-side function at /api/share-note, which does the sending.
async function shareNote(noteId, button) {
  const to = window.prompt('Send this note to which email address?')
  if (to === null) return // user cancelled
  const recipient = to.trim()
  if (!recipient) {
    setStatus('No email address entered.', 'error')
    return
  }

  button.disabled = true
  const original = button.textContent
  button.textContent = 'Sending…'
  setStatus(`Sending note to ${recipient}…`)
  try {
    const response = await fetch('/api/share-note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: recipient, noteId }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(result.error || `Request failed (${response.status})`)
    }
    setStatus(`Note sent to ${recipient}.`, 'success')
  } catch (error) {
    setStatus(`Could not send: ${error.message}`, 'error')
  } finally {
    button.disabled = false
    button.textContent = original
  }
}

// Event delegation: one listener handles the Share button on every note.
notesList.addEventListener('click', (event) => {
  const button = event.target.closest('.share-btn')
  if (!button) return
  shareNote(button.dataset.id, button)
})

// Load the email activity for the given notes into `eventsByNote`.
async function loadEvents(noteIds) {
  eventsByNote = new Map()
  if (noteIds.length === 0) return

  const { data, error } = await supabase
    .from('email_events')
    .select('note_id, recipient, event_type, created_at')
    .in('note_id', noteIds)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Could not load email activity:', error.message)
    return
  }
  for (const event of data) {
    if (!event.note_id) continue
    const list = eventsByNote.get(event.note_id) ?? []
    list.push(event)
    eventsByNote.set(event.note_id, list)
  }
}

async function loadNotes() {
  const { data, error } = await supabase
    .from('notes')
    .select('id, content, created_at')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    notesList.innerHTML = `<li class="empty">Could not load notes: ${error.message}</li>`
    return
  }
  notesCache = data ?? []
  await loadEvents(notesCache.map((note) => note.id))
  renderNotes(notesCache)
}

// Live updates: append incoming events and re-render the wall. Resend webhooks
// insert rows server-side, so this reflects delivered/opened/clicked/bounced
// without a page refresh. Events for notes not currently shown are ignored.
function handleIncomingEvent(row) {
  if (!row || !row.note_id) return
  if (!notesCache.some((note) => note.id === row.note_id)) return
  const list = eventsByNote.get(row.note_id) ?? []
  list.push(row)
  eventsByNote.set(row.note_id, list)
  renderNotes(notesCache)
}

supabase
  .channel('email-events')
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'email_events' },
    (payload) => handleIncomingEvent(payload.new)
  )
  .subscribe()

// Keep the relative timestamps ("3m ago") fresh while the page stays open.
setInterval(() => {
  if (notesCache.length) renderNotes(notesCache)
}, 60000)

async function postNote(content) {
  const { error } = await supabase.from('notes').insert({ content })
  if (error) throw error
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const content = input.value.trim()
  if (!content) {
    setStatus('Please write something first.', 'error')
    return
  }

  submitBtn.disabled = true
  setStatus('Posting…')
  try {
    await postNote(content)
    input.value = ''
    setStatus('Posted.', 'success')
    await loadNotes()
  } catch (error) {
    setStatus(`Could not post note: ${error.message}`, 'error')
  } finally {
    submitBtn.disabled = false
  }
})

loadNotes()

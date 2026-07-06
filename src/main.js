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

function formatTimestamp(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
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
  renderNotes(data)
}

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

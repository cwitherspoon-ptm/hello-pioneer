import { defineConfig } from 'vite'

// Expose SUPABASE_-prefixed variables to client code via import.meta.env,
// in addition to Vite's default VITE_ prefix. This lets the app read the exact
// variable names SUPABASE_URL and SUPABASE_ANON_KEY from the local .env file
// (development) and from the Vercel build environment (production).
//
// The Supabase anon key is a public, RLS-protected key and is meant to ship to
// the browser; do not put the service_role key here.
export default defineConfig({
  envPrefix: ['VITE_', 'SUPABASE_'],
})

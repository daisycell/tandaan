# Tandaan 2.0

Offline-first PWA for tasks, shopping, purchases, voice input, and reminders.

## Current stack
- React + TypeScript + Vite
- PWA via `a small hand-authored PWA service worker` with a custom service worker
- Dexie / IndexedDB for local-first data
- Supabase Auth + PostgreSQL + RLS
- Vercel Node functions for speech transcription and reminder delivery
- Groq Whisper Large V3 Turbo for multilingual online transcription
- Web Push for Home Screen notifications on supported iOS versions

## Local setup
1. Copy `.env.example` to `.env.local` and fill the Supabase values.
2. `npm install`
3. `npm run dev`
4. `npm run build`

## Voice
The microphone records locally with noise suppression, echo cancellation and automatic gain control. When online it uploads the short recording to `/api/transcribe`, which calls Groq Whisper Large V3 Turbo without a forced language so the recognizer can transcribe multilingual input. Groq documents Whisper Large V3 Turbo as multilingual and accepts webm/mp4/m4a/wav audio; the hosted API has Free Plan limits that apply to usage.

Tandaan does not show a “Prepare offline voice” step. Voice transcription in v16 is online by design so the user does not have to download and wait for a large model. Offline CRUD remains available. A later release can add a truly local transcription engine as an optional offline enhancement.

## Web Push reminders
Home Screen web apps on supported iOS versions can receive Web Push. The user must explicitly allow notifications from a direct interaction. Tandaan requests permission when a task with a due date is saved, or from the bell button in the header.

The default reminder is 1 day before the due date. If a task has a time, the reminder is the same local clock time on the previous day. For date-only tasks, Tandaan uses 9:00 AM local time on the previous day. The notification is an iPhone/web-app notification, not a guaranteed Clock-style alarm; iOS controls its sound and Focus behavior.

### VAPID keys
Run `npm run generate:vapid` after `npm install` and keep the private key secret. Put the public key in `VITE_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PUBLIC_KEY`; put the private key only in `WEB_PUSH_VAPID_PRIVATE_KEY`. Use a `mailto:` address for `WEB_PUSH_SUBJECT`.

### Server variables
Set these in Vercel: `GROQ_API_KEY`, `SUPABASE_URL` (or reuse `VITE_SUPABASE_URL`), `SUPABASE_SECRET_KEY` (preferred with the newer `sb_secret_...` key; `SUPABASE_SERVICE_ROLE_KEY` is also accepted), `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`, and `REMINDER_CRON_SECRET`. Never put a Supabase secret key in a `VITE_` variable.

The client also needs `VITE_VAPID_PUBLIC_KEY` plus the existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.

### Supabase reminder scheduler
After deploying, use `supabase/reminders-cron.sql` and replace its two placeholders with the production Vercel reminder endpoint and the same `REMINDER_CRON_SECRET`. Supabase Cron can make recurring HTTP requests and this project schedules the reminder endpoint every minute.

## Quick reminder setup

1. Create VAPID keys: `npm run generate:vapid`.
2. Add the Vercel variables from `.env.example`.
3. Run `supabase/migrations/20260927000200_reminders_and_push.sql` in Supabase SQL Editor (or run the equivalent included in `schema.sql`).
4. After the production deployment exists, run `supabase/reminders-cron.sql` once with your production Vercel URL and the same cron secret.
5. Install Tandaan to the iPhone Home Screen and create a task with a due date. Allow notifications when prompted.


## v16.1 build fixes
This package includes TypeScript fixes for Vite PWA registration, duplicate parser keys, and the injected Workbox manifest typing.


## PWA note
This build intentionally uses `public/sw.js` instead of `vite-plugin-pwa`/Workbox injection. The service worker provides the offline shell and Web Push handlers without a build-time manifest injection step.

## v18 notes
- Voice no longer fails immediately when an anonymous session is missing; it attempts to establish one when online.
- Task due-date prompts now let Today/Tomorrow flow directly into an optional time picker, with date-only still supported.
- The PWA build now precaches the exact Vite output assets so a Home Screen install can reopen offline reliably after the first online load.


## v21 voice endpoint fix
The transcription endpoint now accepts raw audio bytes instead of relying on multipart form parsing inside the Vercel Node function, validates the Supabase bearer token server-side, and returns JSON diagnostics for server failures.

# Tandaan 2.0

Offline-first personal tasks, shopping, purchases and reminders.

## Stack

- React + TypeScript + Vite
- Vite PWA
- Dexie / IndexedDB for local data
- Supabase for Auth + PostgreSQL + future sync/reminders
- Vercel for deployment

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add your Supabase project URL and publishable key.
3. Run `npm install`.
4. Run `npm run dev`.

## Supabase

Run `supabase/schema.sql` in the Supabase SQL Editor.
Enable Anonymous Sign-Ins in Authentication providers.

## Important

Never put a Supabase secret/service-role key in the frontend. Use only the publishable key in `VITE_SUPABASE_PUBLISHABLE_KEY`.

# Tandaan 2.0

Offline-first personal tasks, with Supabase sync when configured.

## Stack
- React + TypeScript + Vite
- vite-plugin-pwa
- Dexie / IndexedDB for local-first storage
- Supabase Auth + Postgres for cloud sync

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add your Supabase project URL and publishable key.
3. In Supabase, enable Anonymous Sign-Ins.
4. Run `supabase/schema.sql` once in the Supabase SQL Editor.
5. Install dependencies:

```bash
npm install
```

6. Start development:

```bash
npm run dev
```

7. Verify production build:

```bash
npm run build
```

## Environment variables

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Never put a Supabase secret/service-role key in the frontend.

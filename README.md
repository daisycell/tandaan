# Tandaan 2.0

Tandaan is an offline-first, mobile-friendly personal list and purchase tracker built with React, TypeScript, Vite, Dexie, and Supabase.

## v36 updates

- Local Whisper base-q5_1 voice transcription with automatic language detection.
- One-shot Whisper transcription instead of streaming to reduce browser memory pressure.
- iOS voice capture uses one WASM thread and a shorter 15-second recording cap for stability.
- Auto-stop recording now has a single completion promise, preventing duplicate-stop race errors.
- Clear distinction between model loading and transcription status.
- Compact rotating animal stickers inside the summary-card corner accents.
- Only Cat, Golden Retriever, and Capybara themes.
- Mobile spacing, icon centering, buttons, cards, and modal layout refined.

## Themes

Theme sticker packs are bundled automatically:

- Cat: `/public/stickers/cat/`
- Golden Retriever: `/public/stickers/dog/`
- Capybara: `/public/stickers/capybara/`

Users choose the animal theme; they do not manually pick stickers.

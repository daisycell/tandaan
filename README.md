# Tandaan 2.0

Tandaan is an offline-first personal memory web app built with React, TypeScript, Vite, PWA, Dexie, and Supabase.

## Voice

Voice transcription runs locally in the browser using `@timur00kh/whisper.wasm`, a browser-first TypeScript wrapper around whisper.cpp. The multilingual model is loaded only on first voice use and cached in IndexedDB, so normal app startup does not wait for the speech model. Language is automatic; no language selector is shown. The current model is `base-q5_1` (~57 MB) for a balance of multilingual accuracy and on-device size.

The microphone recording uses browser noise suppression, echo cancellation, and automatic gain control. After the model is cached, voice transcription works without sending the recording to a server.

## Offline PWA

Only the app shell and entry assets are precached during service-worker installation. Sticker images and lazy voice chunks are fetched on demand and runtime-cached so the initial app open stays fast.

# Tandaan 2.0

Tandaan is an offline-first personal memory web app built with React, TypeScript, Vite, PWA, Dexie, and Supabase.

## Voice

Voice transcription runs locally in the browser using `@timur00kh/whisper.wasm`, a browser-first TypeScript wrapper around whisper.cpp. The app uses the multilingual quantized `tiny-q5_1` model (~31 MB) to reduce first-use download time and on-device initialization time. The model is loaded only when the user first uses voice and cached in IndexedDB. No language selector is shown.

The microphone recording uses browser noise suppression, echo cancellation, and automatic gain control. After the model is cached, voice transcription works without sending the recording to a server and can be used offline. The first voice use still needs to download the model when it is not cached; the progress shown during that step is model loading, not cloud transcription.

## Smart input

Tandaan separates clear Task, Shopping, and Purchase commands. When a compact numeric entry could validly mean either Shopping quantity or Purchase price (for example `egg 3`), Tandaan asks the user which meaning they intended instead of silently guessing. Clear purchase structures such as `egg 1 tray 400` are routed directly to Purchases, while explicit commands like `buy eggs` are routed to Shopping.

## Themes

Only three animal themes are included: Cat, Golden Retriever, and Capybara. Each theme uses its bundled sticker pack automatically. The dashboard rotates through unused stickers from the selected theme pack and places them subtly in the summary-card corner accents. Switching away and back continues through the remaining stickers before reusing earlier ones.

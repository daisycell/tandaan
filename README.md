# Tandaan 2.0 — Voice + Personal Themes

React + TypeScript + Vite PWA for an offline-first everyday memory app.

## Voice architecture

- MediaRecorder for microphone capture in the Home Screen PWA.
- Transformers.js in a Web Worker for local ASR.
- `Xenova/whisper-tiny` on mobile; `Xenova/whisper-base` on desktop.
- Quantized `q8` WASM inference.
- Automatic language detection (no language picker).
- Browser model/WASM caching through Transformers.js.
- Model loading is lazy: it begins only when the user taps Speak.
- Cached model is reused on later recordings; it is not re-downloaded every time.
- If the cached model is corrupt or incomplete, it is invalidated and reloaded when online.
- A failed inference terminates the worker; the next attempt creates a fresh worker.
- Backgrounding/closing the Home Screen PWA during recording interrupts and resets the recording cleanly.

## Smart input

Quick Add routes entries into Task, Shopping, or Purchase. Ambiguous shortcut lists such as `egg 3` or `chicken 1kg egg 10 oil 10` ask the user to choose rather than silently guessing. The ambiguous list editor uses structured per-item controls. `+ Add item` creates a blank required name with quantity `1` and unit `pcs`.

## Personal themes

Exactly three animal themes are included:

- Cat — Cozy purple
- Golden Retriever — Warm and cheerful
- Capybara — Calm and earthy

The selected theme automatically uses its sticker pack. Users can optionally set a background photo per theme. The stat-card stickers rotate through the selected animal's pack without a sticker picker.

## Local-first behavior

Tasks, shopping, purchases, theme choices, and other app data are stored locally first. Supabase sync happens in the background when online.

## Development

```bash
npm install
npm run dev
npm run build
```


## v45 voice behavior

The first Speak tap only prepares the cached local voice model. Once the model is ready, the user taps Speak again to record. Mobile uses the quantized whisper-tiny model and prefers WebGPU when available, falling back to single-threaded WASM. Voice recordings are intentionally short (about 6.5 seconds).


Voice stability update: mobile local voice uses the 2.15.1 Transformers.js stack and multilingual Xenova/whisper-tiny quantized model; the first Speak action loads the cached model and proceeds directly into recording.

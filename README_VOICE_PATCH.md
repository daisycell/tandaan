Tandaan voice-only stability patch.

Changed project files:
- src/voice.ts
- src/voiceWorker.ts
- src/App.tsx (voice start/error flow only)

No theme, stat-card, or theme-picker files were changed.

Main changes:
- Mobile local Whisper is WebGPU-only; no WASM fallback on iPhone, avoiding the heavy WASM path that was triggering white flashes/out-of-memory.
- Single in-flight model load via loadingModel guard.
- First Speak tap continues into recording after model initialization; no second tap required.
- Worker is recreated after fatal inference/runtime errors.
- Offline model use relies on the Transformers browser cache; no remote model fetch when offline.
- Short 3–6 second commands are still the target; max recording remains 6.5 seconds.

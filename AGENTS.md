# LifeBot — AGENTS.md

Read this before making changes. It's the orientation doc for anyone (human or agent) picking the project up cold.

## What it is

A passive, real-time session monitor — listens to ambient conversation in the room, surfaces brief contextual cues from a cloud LLM. Originally scoped in `PLAN.md` (under the working name "Conversate"). Currently a browser-only PWA; the previous React Native incarnation lives at `~/projects/lifebot-rn` and on the `rn-final` git tag if it ever needs to be revived.

## Architecture

```
┌──────── browser tab (PWA) ────────────────┐    ┌────── cloud ──────┐
│                                            │    │                    │
│  mic ▶ getUserMedia                        │    │  Gemini 3.1 Flash  │
│           │                                │    │  Live (WebSocket)  │
│           ▼                                │    │                    │
│  @ricky0123/vad-web                        │    │   ▲                │
│   (Silero v5 in WASM via onnxruntime-web) │    │   │ {input,output} │
│           │ onSpeechEnd(audio: Float32)    │    │   │  transcripts   │
│           ▼                                │    │   │                │
│  GeminiLiveOrchestrator.sendTurn(pcm)      │ ───┼───┘                │
│   (Float32 → Int16 → base64 →             │    │                    │
│    clientContent + turnComplete: true)     │    └────────────────────┘
│           │                                │
│  ── three panes ──                         │
│  Transcript: per-turn "heard" text         │
│  Orchestrator: connection / errors / turns │
│  Cues: surfaced helpful text from model    │
│                                            │
│  LogUploader → POST /lifebot/logs every 5s │
└────────────────────────────────────────────┘
```

The whole pipeline runs in one browser tab. There is no server-side code. Mic capture, VAD, and audio framing all happen in JS. The only network hop is the WebSocket to Gemini Live (and the optional log POSTs back to our own host).

Why we're not using `realtimeInput`: we VAD-gate locally, so we don't continuously stream audio. With `realtimeInput` the server's automatic VAD would never see a clean turn boundary because we just stop sending. `clientContent` with `turnComplete: true` makes the boundary explicit and the response immediate.

## Repo layout

```
src/
  audio/LiveAudioCapture.ts    Mic + Silero VAD wrapper. One emitted turn per utterance.
  orchestrator/GeminiLive.ts   WebSocket client. Setup, base64 PCM, transcript reassembly.
  ui/                          Controls + Transcript + Cues + Orchestrator log panes.
  util/base64.ts               Pure-JS Uint8Array → base64 (no Buffer/btoa dependency).
  util/LogUploader.ts          Batches log entries, POSTs every 5s to /lifebot/logs.
  App.tsx                      Wires capture + orchestrator + UI + log upload.
  main.tsx                     Vite entry.
  styles.css                   Theme tokens + global styles.
public/                        Shipped as-is by Vite. VAD model, ORT WASM, manifest.
index.html                     Vite entry HTML.
vite.config.ts                 Build → .serve/, base './' (works under any path).
.env                           VITE_GEMINI_API_KEY etc. Gitignored.
.env.example                   Template committed to the repo.
.serve/                        npm run build output. Gitignored.
logs/                          Where uploaded device logs land. Gitignored.
PLAN.md                        Original product brief.
README.md                      Public-facing setup instructions.
```

## Dev workflow

```sh
npm run dev               # vite, http://localhost:5174 (or LAN IP)
npm run build             # tsc -b && vite build → .serve/
npm run preview           # serve .serve/ for a quick prod check
```

Iteration is essentially: edit, save, browser HMRs the change. No install dialog, no APK, no emulator.

## Deployment (private tailnet)

The build output is a static site and is served by the existing `lifebot-static.service` (`python3 -m http.server 8003 --directory .serve`). That service is fronted by the path-routed reverse proxy at `~/projects/proxy/` (read its AGENTS.md for the full story).

Relevant routes on the proxy:

| URL | Backend | Notes |
|---|---|---|
| `/lifebot/` | `127.0.0.1:8003` (`lifebot-static.service`) | Serves `.serve/` after `npm run build`. Prefix stripped. |
| `POST /lifebot/logs` | handled by the proxy itself | Appends body lines to `~/projects/lifebot/logs/current.log`. |

The tailnet hostname is *not* committed anywhere in this repo (per the `gpu-server` SSH alias convention in `~/.claude/CLAUDE.md`). Use `gpu-server` or `<gpu-host>` when documenting publicly. The user's own browser bookmark holds the real FQDN.

To redeploy after a code change:

```sh
npm run build
# That's it. python http.server picks up new files immediately. No restart.
```

If you change anything in `public/` (icons, manifest, VAD model), they get copied as-is.

## Log upload

Runtime device-side events (connection state, per-turn transcripts, errors) get POSTed in 5-second batches to `/lifebot/logs`. The proxy handler in `~/projects/proxy/server.js` writes each line to `~/projects/lifebot/logs/current.log` with a server-side timestamp prefix. `tail -f` it for live device debugging.

The logs dir is intentionally outside `.serve/` — that dir is the build output and gets emptied on every `npm run build`.

## Key dep choices

- **Vite 8 + React 19**: standard modern web stack. `tsconfig.app.json` has `erasableSyntaxOnly: true` (Vite default), which forbids constructor parameter properties (`private readonly opts: ...`); use explicit field declarations + an assigning constructor instead.
- **`@ricky0123/vad-web`**: Silero v5 VAD in WASM. Requires four asset families in `public/`: `silero_vad_v5.onnx`, `silero_vad_legacy.onnx`, `vad.worklet.bundle.min.js`, plus the `ort-wasm-simd-threaded.{,jsep.}{wasm,mjs}` runtime files from `onnxruntime-web`. They're copied in by hand at the moment; if you bump versions, recopy from `node_modules/`.
- **`vite-plugin-pwa`**: deliberately not used — the published version (`1.2.0`) doesn't yet support Vite 8. We do "install to home screen" with a hand-written `public/manifest.webmanifest` and no service worker. We don't need offline anyway since Gemini Live needs network.
- **Gemini model**: `gemini-3.1-flash-live-preview` is audio-output only. We request `responseModalities: ['AUDIO']` plus `inputAudioTranscription` and `outputAudioTranscription` so we can read both sides as text and ignore the audio bytes. The system prompt asks for terse responses to keep audio-output cost down.

## Intended direction

- **Dual-mode (price vs intelligence) switch.** The Live audio path costs ~$0.40/active hour. A future cheap-mode path would use on-device Whisper STT + Gemini Flash text REST (~$0.05–0.10/active hour). The complete RN+Whisper code is preserved in `~/projects/lifebot-rn` (tag `rn-final`) — when we want to re-introduce that path, we lift the orchestrator + bootstrap + audio pipeline from there into a new `src/audio/WhisperCapture.ts` and `src/orchestrator/GeminiText.ts`, with an in-app toggle.
- **Backgrounded mic.** The PWA loses mic access when the tab is backgrounded on Android. If passive monitoring with the screen off ever becomes a real requirement, the path forward is either (a) a small Capacitor wrapper around this exact code, or (b) revive the RN snapshot. Don't try to solve it with a Service Worker — SW can't access the mic.

## Don't

- **Don't commit `.env`.** It holds the Gemini API key.
- **Don't put the tailnet hostname in source files** (or in the user-facing README). It belongs in the user's bookmark and in the proxy's tailscale config, nowhere else in this repo.
- **Don't add server-side logic to `.serve/`.** That dir is wiped on every build. The log endpoint lives in the proxy intentionally.
- **Don't bypass the proxy** to serve the PWA on a different port. Add routes to its `ROUTES` table instead. The proxy owns the `:443` Let's Encrypt cert and the request fan-out.
- **Don't switch to `realtimeInput` for audio.** Our VAD-gated, silence-skipping pattern needs an explicit turn-complete signal; `clientContent + turnComplete: true` provides it. With `realtimeInput`, the server's auto-VAD would stall waiting for audio that never comes.

## Quick references

| Need to | Look at |
|---|---|
| Tune VAD sensitivity | `src/audio/LiveAudioCapture.ts` (positive/negativeSpeechThreshold, redemptionMs, etc.) |
| Change cue prompt | `src/orchestrator/GeminiLive.ts` (`DEFAULT_SYSTEM_INSTRUCTION`) |
| Change UI / theme | `src/styles.css` (CSS variables) and the four pane components |
| Add a Live API option | `src/orchestrator/GeminiLive.ts` (`sendSetup`) |
| See what the device sent | `tail -f ~/projects/lifebot/logs/current.log` |
| Revive Whisper / RN path | `~/projects/lifebot-rn` (full git history, `rn-final` tag) |

# LifeBot — AGENTS.md

Read this before making changes. It's the orientation doc for anyone (human or agent) picking the project up cold.

## What it is

A passive, real-time session monitor — listens to ambient conversation in the room, surfaces brief contextual cues from a cloud LLM. Originally scoped in `PLAN.md` (under the working name "Conversate"). Currently a browser-only PWA; the previous React Native incarnation lives at `~/projects/lifebot-rn` and on the `rn-final` git tag if it ever needs to be revived.

## Architecture

```
┌──────── browser tab (PWA) ────────────────┐    ┌──────── cloud ────────┐
│                                            │    │                        │
│  mic ▶ getUserMedia                        │    │  Gemini Flash          │
│           │                                │    │  generateContent (REST)│
│           ▼                                │    │                        │
│  @ricky0123/vad-web                        │    │   ▲    ▼               │
│   (Silero v5 in WASM via onnxruntime-web) │    │   │  {"heard":"...",   │
│           │ onSpeechEnd(audio: Float32)    │    │   │   "cue":"..."|null}│
│           ▼                                │    │   │                    │
│  GeminiAudioOrchestrator.sendTurn(pcm)     │ ───┼───┘                    │
│   (Float32 → Int16 → base64 → POST,        │    │                        │
│    audio inlineData in, JSON text out)     │    └────────────────────────┘
│           │                                │
│  ── three panes ──                         │
│  Transcript: each turn's "heard" text      │
│  Orchestrator: per-turn diagnostics        │
│  Cues: surfaced helpful text from model    │
│                                            │
│  LogUploader → POST /lifebot/logs every 5s │
└────────────────────────────────────────────┘
```

The whole pipeline runs in one browser tab. There is no server-side code. Mic capture, VAD, and audio framing all happen in JS. Each VAD-detected utterance becomes one POST to Gemini's `generateContent` endpoint with the audio inlined as base64 PCM; Gemini returns `{"heard": "...", "cue": "..." | null}` in one shot. The only other network call is the optional log upload back to our host.

**Why not the Live API:** Live's value is bidirectional streaming with server-side VAD. We deliberately do VAD on the device and ship discrete, complete utterances, so Live's streaming machinery doesn't help us — and Live forces audio output (which we'd throw away while still paying for the tokens). Plain `generateContent` with audio input is cheaper, simpler (no WebSocket lifecycle), and returns text directly.

**Why "cheap" history:** `GeminiAudioOrchestrator` keeps a stateful `contents[]` array so the model has conversation context across turns. Past user turns are rewritten to just their `heard` text after the first response — the audio bytes drop out of history entirely. Cost stays roughly flat as the session lengthens; only the new turn pays the audio-token bill.

## Repo layout

```
src/
  audio/LiveAudioCapture.ts    Mic + Silero VAD wrapper. One emitted turn per utterance.
  orchestrator/GeminiAudio.ts  REST client. POST per turn, stateful contents[] with cheap history.
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
- **`vite-plugin-pwa`**: deliberately not used — the published version (`1.2.0`) doesn't yet support Vite 8. We do "install to home screen" with a hand-written `public/manifest.webmanifest` and no service worker. We don't need offline since Gemini needs network.
- **Gemini model**: `gemini-2.5-flash` by default (override with `VITE_GEMINI_MODEL`). Any model that accepts audio inlineData works. The system prompt forces a strict JSON `{heard, cue}` response.

## Intended direction

- **Session summary.** Each turn's `heard` text is written to `~/projects/lifebot/logs/current.log` for free, so the running transcript is always available. A future "summarize" button would read that log (or accumulate transcripts in app state) and fire a one-shot Gemini text request to recap.
- **Dual-mode (price vs intelligence) switch.** Original plan was on-device Whisper STT + Gemini Flash text for "cheap mode" vs Gemini Live audio for "smart mode". Now that we send audio to Gemini directly via REST, we already get Gemini's high-quality audio understanding at near-Whisper-mode cost — the dual-mode tension is mostly resolved. The Whisper-on-device path stays available in `~/projects/lifebot-rn` (tag `rn-final`) if true offline support ever becomes a requirement.
- **Backgrounded mic.** The PWA loses mic access when the tab is backgrounded on Android. If passive monitoring with the screen off ever becomes a real requirement, the path forward is either (a) a small Capacitor wrapper around this exact code, or (b) revive the RN snapshot. Don't try to solve it with a Service Worker — SW can't access the mic.

## Don't

- **Don't commit `.env`.** It holds the Gemini API key.
- **Don't put the tailnet hostname in source files** (or in the user-facing README). It belongs in the user's bookmark and in the proxy's tailscale config, nowhere else in this repo.
- **Don't add server-side logic to `.serve/`.** That dir is wiped on every build. The log endpoint lives in the proxy intentionally.
- **Don't bypass the proxy** to serve the PWA on a different port. Add routes to its `ROUTES` table instead. The proxy owns the `:443` Let's Encrypt cert and the request fan-out.
- **Don't switch back to the Live API.** It was the wrong tool for what we're doing — we VAD locally and send discrete utterances, so streaming isn't useful, and Live forces audio output we'd throw away while still paying for the tokens. Plain `generateContent` with audio input is cheaper and simpler. If we ever want bidirectional spoken interaction (model talks back), reconsider — but for passive monitoring, REST wins.
- **Don't keep audio in the conversation history.** `GeminiAudioOrchestrator` deliberately rewrites past user turns to text after each response — keeping all that base64 audio in `contents[]` would balloon costs over a long session. Past turns become "user said X" so the model still has context.

## Quick references

| Need to | Look at |
|---|---|
| Tune VAD sensitivity | `src/audio/LiveAudioCapture.ts` (positive/negativeSpeechThreshold, redemptionMs, etc.) |
| Change cue prompt | `src/orchestrator/GeminiAudio.ts` (`DEFAULT_SYSTEM_INSTRUCTION`) |
| Change UI / theme | `src/styles.css` (CSS variables) and the four pane components |
| Change history retention | `GeminiAudioOptions.maxHistoryTurns` |
| See what the device sent | `tail -f ~/projects/lifebot/logs/current.log` |
| Revive Whisper / RN path | `~/projects/lifebot-rn` (full git history, `rn-final` tag) |

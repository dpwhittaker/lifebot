# LifeBot

Passive session monitor. Listens to ambient conversation in the room — a tabletop game, a study group, a meeting — and surfaces brief contextual cues from a cloud LLM as the conversation unfolds.

It runs entirely as a web app. Audio capture and voice activity detection happen locally in your browser; only detected speech segments are streamed to the Gemini Live API for understanding.

## How it works

```
mic ──► getUserMedia ──► Silero VAD (in-browser WASM)
                              │  (only when speech is detected)
                              ▼
                     Gemini Live (WebSocket)
                              │
                              ▼
                  cues + transcript appear in the UI
```

You see three panes:

- **Transcript** — what Gemini heard, one row per detected utterance.
- **Orchestrator** — connection events, per-turn diagnostics, errors.
- **Cues** — short helpful summaries the model surfaces when something looks like a factual claim, rule, definition, or explicit data request. Chit-chat is silently dropped.

## Requirements

- Node.js 20 or newer
- A modern browser (Chrome, Edge, Firefox, Safari) with `getUserMedia` and `WebSocket`
- A Google AI Studio API key (free tier works fine for casual use)

## Setup

```sh
git clone <repo-url> lifebot
cd lifebot
npm install
cp .env.example .env
# edit .env and paste your API key from https://aistudio.google.com/apikey
```

## Run locally

```sh
npm run dev
```

The dev server binds to `0.0.0.0:5174`, so you can open it from any device on your LAN — useful if you want to develop on a laptop and test on a phone:

- On the dev machine: <http://localhost:5174>
- From another device: `http://<dev-machine-LAN-ip>:5174`

Browsers require a secure origin for microphone access. `localhost` is exempt; for cross-LAN testing you'll either need to (a) use the device on the same machine that's running `npm run dev`, or (b) put a TLS terminator in front (see "Hosting" below).

## Build for production

```sh
npm run build
```

Outputs a static site to `.serve/`. There's no server-side code — every file is static, including the WASM runtime and the Silero VAD model that ship in `public/`.

Preview the build locally:

```sh
npm run preview
```

## Hosting

`.serve/` is a fully static site. Any static-file server or HTTPS reverse proxy works. Examples:

```sh
# Quick local check, listens on all interfaces:
npx serve .serve -l 8003

# Or python:
python3 -m http.server 8003 --bind 0.0.0.0 --directory .serve
```

For real deployment you want HTTPS (browsers won't grant microphone permission to non-`localhost` HTTP origins). Put any HTTPS-terminating reverse proxy in front — Caddy, nginx, Cloudflare Tunnel, etc.

### Optional: log upload

The app POSTs runtime log entries (orchestrator events, errors) to `<origin>/lifebot/logs` every 5 seconds. If you don't run a backend that handles that endpoint, the requests fail silently and nothing breaks. To disable, set `VITE_LIFEBOT_LOG_URL=` in `.env`.

If you do want to receive them, any HTTP server that accepts POST to that path and appends the body to a file works. The body is newline-delimited JSON, one event per line.

## Project layout

```
src/
  audio/LiveAudioCapture.ts    Mic + Silero VAD; emits one turn per utterance.
  orchestrator/GeminiLive.ts   WebSocket client for the Gemini Live API.
  ui/                          Controls, Transcript, Cues, Orchestrator log.
  util/                        Base64 encoder, log uploader.
  App.tsx                      Wires everything together.
  styles.css                   Theme tokens + global styles.
public/                        Static assets shipped as-is (VAD model, ORT WASM, manifest).
.serve/                        Build output (gitignored).
```

## API key safety

Your `VITE_GEMINI_API_KEY` ends up inlined into the built JavaScript bundle and is therefore visible to anyone who can load your site. That's fine for personal use on a private network, but **do not deploy this app publicly with your API key embedded**. If you want public access, put a thin server in front that owns the key and proxies WebSocket frames between the browser and Gemini.

## Limitations

- **Backgrounded tabs**: most mobile browsers pause microphone capture when the tab is backgrounded or the screen sleeps. The app requests a screen wake-lock when listening, but you'll still want the screen on.
- **Audio cost**: Gemini's Live model is audio-only output. The app asks Gemini for terse responses ("the cue or just the word `null`") to minimize cost, and ignores the audio bytes — but you do pay for the audio output tokens. For an active hour of conversation expect roughly the cost of input + a small amount of output. Check current pricing at <https://ai.google.dev/pricing>.

## License

MIT.

# LifeBot — AGENTS.md

Read this before making changes. It's the orientation doc for anyone (human or agent) picking the project up cold.

## What it is

A passive, real-time, on-device session monitor — listens to ambient conversation (tabletop game, study group, meeting), transcribes locally with Whisper, and pushes contextual cues from a cloud LLM to a dual-pane UI on the Galaxy Z Fold 7's inner display.

Originally scoped in `PLAN.md` (under the working name "Conversate"). Now branded **LifeBot**.

## Architecture

```
┌──────── on-device ────────┐    ┌─────── cloud ──────┐
│                            │    │                    │
│  mic ▶ AudioPcmStream      │    │  Gemini 2.5 Flash  │
│         │                  │    │  (text, REST)      │
│         ▼                  │    │                    │
│  whisper.rn RealtimeXcb    │    │   ▲                │
│   ├─ Silero VAD (gating)   │    │   │ {cue}|null     │
│   └─ ggml-tiny.en (STT)    │    │   │                │
│         │                  │    └───┼────────────────┘
│         ▼                  │        │
│  semantic batcher          │ ───────┘
│   (terminal punctuation +  │   complete sentence
│    abbreviation guard)     │
│         │                  │
│         ▼                  │
│  cue stack (UI right pane) │
│  rolling transcript (left) │
└────────────────────────────┘
```

Two-pane landscape UI sized for the Fold 7 inner display:

- **Left pane** — rolling transcript (FlatList of `TranscriptChunk`, plus a partial-result line styled italic)
- **Right pane** — newest-first stack of dismissible cue cards

The Whisper VAD is what makes "smart batching" cheap: silence between speech is filtered out acoustically, then we wait for terminal punctuation before sending to Gemini. Sentences without `. ! ?` accumulate; single-token abbreviations (`Mr.`, `Dr.`, `etc.`) don't false-trigger.

## Repo layout

```
App.tsx                         entry point, owns transcript/cue state
src/audio/AudioPipeline.ts      whisper.rn wiring, VAD config, semantic batcher
src/orchestrator/Gemini.ts      REST client, stateful contents history, queue
src/models/bootstrap.ts         downloads ggml-tiny.en + ggml-silero on first run
src/ui/                         TranscriptPane / CuePane / Controls / BootstrapScreen / theme
android/                        full native project (no Expo)
.env                            EXPO-style env vars consumed via @env (gitignored)
.serve/                         APK + landing page served at /lifebot/ (gitignored)
lifebot-static.service          systemd unit for .serve/ over :8003
PLAN.md                         original product brief
```

## Build & deploy

The whole build runs locally on this WSL2 host. No Expo, no EAS, no cloud round-trip.

```bash
# one-time: SDK + JDK already installed under ~/Android/Sdk and /usr/lib/jvm/java-17-openjdk-amd64
# subsequent rebuilds (caches from previous build are reused → ~1-2 min):

cd /home/david/projects/lifebot
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
ANDROID_HOME=/home/david/Android/Sdk \
PATH=$JAVA_HOME/bin:$PATH \
  android/gradlew -p android assembleRelease

cp android/app/build/outputs/apk/release/app-release.apk .serve/lifebot.apk
```

That's it — the APK is now live at `https://desktop-uqt6i2t.tail9fb1cb.ts.net/lifebot/`.

First build was 22 min (cold NDK/CMake compile across 4 ABIs for whisper.cpp). Incremental builds skip nearly all of that.

The release variant uses the debug keystore (`android/app/build.gradle` `signingConfigs.debug`) — fine for prototype distribution to the user's own device, not fine for Play Store.

## Tailnet serving

LifeBot piggybacks on the existing tailnet proxy at `desktop-uqt6i2t.tail9fb1cb.ts.net:443`. See `~/projects/proxy/AGENTS.md` for the full proxy story; the LifeBot-specific delta:

| URL | Backend | Notes |
|---|---|---|
| `/lifebot/` | `127.0.0.1:8003` (`lifebot-static.service`) | Prefix stripped. Serves `~/projects/lifebot/.serve/`. |

```bash
systemctl is-active lifebot-static.service tailnet-proxy.service
journalctl -u lifebot-static.service -f
sudo systemctl restart lifebot-static.service   # after editing .serve/ contents (rarely needed; python http.server picks up file changes live)
```

Updating the proxy route lives in `proxy/server.js` — adding `/lifebot` was a single entry in the `ROUTES` array. Don't put LifeBot-specific logic in the proxy.

## Native config notes

- **minSdk 26** (`android/build.gradle`) — required by `react-native-fs` and various RN 0.85 stack pieces; also drops 32-bit-only devices we don't care about.
- **NDK 27.1.12297006** — pinned via `android/build.gradle ext.ndkVersion`. whisper.cpp's CMake build uses this.
- **Landscape-only** — `android:screenOrientation="landscape"` on `MainActivity`, optimized for the Fold 7 inner display.
- **Keep-screen-on** — `MainActivity.onCreate` adds `FLAG_KEEP_SCREEN_ON`. We initially used `react-native-keep-awake` but it's unmaintained (jcenter, gradle 3.x); a single `addFlags` call replaced it cleanly.
- **Permissions** — `RECORD_AUDIO`, `INTERNET`, `WAKE_LOCK`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`. Manifest declares them; `AudioPipeline.requestMicPermission()` requests `RECORD_AUDIO` at runtime.

## Dependency quirks

A few things not obvious from the code:

- **`whisper.rn` package.json `exports` is malformed** — the `react-native` condition value (`"src/*"`) is missing the leading `./`, which makes Metro fail to resolve deep subpaths like `whisper.rn/realtime-transcription/adapters/AudioPcmStreamAdapter`. Fix: `metro.config.js` sets `resolver.unstable_enablePackageExports = false`, falling back to legacy field-based resolution. Imports use the explicit `whisper.rn/src/...` path. If you ever upgrade whisper.rn and the exports field gets fixed upstream, you can flip exports back on and shorten the imports.
- **Env vars use `react-native-dotenv`** — not `react-native-config`, not Expo's `EXPO_PUBLIC_` convention. The babel plugin reads `.env` at build time and inlines via the virtual `@env` module. New env vars need a line in `env.d.ts` to be type-safe.
- **No prebuilt `Orchestrator` interface yet** — `App.tsx` currently calls `GeminiOrchestrator.submit()` directly. The dual-mode plan (below) will introduce an interface so the App can pick which one to instantiate.

## Intended direction

Two near-term things on deck:

1. **In-app price-vs-intelligence switch.** The current Gemini Flash text path costs ~$0.05–0.10 per active hour. A future "intelligence mode" will stream raw audio to **Gemini Live** (3.1 Flash Live Preview or successor) for ~$0.40/active hour — same orchestrator role, but the audio carries tone / multiple speakers / hesitation that text loses. The switch lives in app settings, not env vars; users pick per-session based on what the conversation needs.
2. **VAD-gated audio uploads.** When in intelligence mode, we *still* run local Whisper VAD to detect speech windows — but instead of using the transcribed text, we throw it away and stream the underlying audio bytes to Gemini Live. Skipping silent windows cuts the input bill substantially while preserving the "listen to actual audio" property.

Refactor needed before implementing these: a thin `Orchestrator` interface so `GeminiOrchestrator` (text) and a future `GeminiLiveOrchestrator` (audio) are interchangeable from the App's perspective. The `AudioPipeline` callbacks (`onSentence`, `onChunk`, raw VAD events with audio data) already provide enough signal for both paths; the wiring just needs to fan out to the active orchestrator.

## Don't

- **Don't reintroduce Expo / EAS** — we deliberately exited that path. The build pipeline is local NDK/Gradle and that's a feature, not a constraint.
- **Don't rip out on-device Whisper to "simplify."** Even though Live audio would let us remove the model download, NDK build, and VAD logic, we keep Whisper for offline support, privacy, and the cost-floor it gives us. See `dual_mode_plan` memory.
- **Don't bypass `tailnet-proxy.service`** to serve the APK directly. Add routes to its `ROUTES` table instead. The proxy owns the `:443` Let's Encrypt cert and the request fan-out; orphan listeners on adjacent ports just create EADDRINUSE drama.
- **Don't ship the release APK with the debug keystore** to anywhere but the developer's own device. If this ever leaves the tailnet, generate a real signing key.

## Quick references

| Need to | Look at |
|---|---|
| Change Whisper batching | `src/audio/AudioPipeline.ts` (VAD options, sentence detection regex) |
| Change cue prompt | `src/orchestrator/Gemini.ts` (`SYSTEM_INSTRUCTION`) |
| Change UI / theme | `src/ui/theme.ts` and the four pane components |
| Add a permission | `android/app/src/main/AndroidManifest.xml` |
| Bump whisper / VAD model | `src/models/bootstrap.ts` (`WHISPER_MODEL`, `VAD_MODEL`) |
| Edit Gemini history retention | `GeminiOrchestrator` `maxHistoryTurns` |

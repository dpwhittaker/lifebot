# LifeBot on Even Realities G2 — Plan

**Status:** drafted, not started · **Target hardware:** Even Realities G2 ($599 + Rx lenses) · **Companion runtime:** Even Hub app (iOS/Android)

## Goal

Add the **Even Realities G2** smart glasses as a second deployment target for LifeBot, alongside the existing PWA. The PWA stays the primary "phone in hand / browser open" experience; the G2 build is the "I want this in my eyeline, hands-free" experience for meetings and conversations where pulling out a phone is rude or impractical.

Both targets share the same brain (orchestrator, threads, voiceprints, group inference, cue generation) and differ only in their **input** (microphone source) and **output** (where the cue is shown).

## Feasibility verdict — **YES, via the official Even Hub SDK**

The G2 publishes an official TypeScript SDK (`@evenrealities/even_hub_sdk`) whose runtime is a WebView container inside the Even Realities companion app. Apps are written in HTML + TS + any framework (Vite/React/vanilla — i.e. exactly what LifeBot is already). For development the Even Hub app loads any HTTPS URL via a QR code (`evenhub qr --url ...`) with the bridge injected and hot reload enabled. For distribution, apps are packaged as `.ehpk` (zipped local assets + manifest) and sideloaded by QR.

The two capabilities that gate this project both exist as first-class APIs:

| Capability | API | Format | LifeBot match |
|---|---|---|---|
| Mic capture | `bridge.audioControl(true)` → `audioEvent.audioPcm` | 16-bit mono PCM, 16 kHz | **Identical** to current PWA ingest — no transcoding, no resample |
| Text on HUD | `TextContainerProperty.upgrade()` (partial, flicker-free) | 2000 chars/container hard cap; ~80 chars per glance is the *useful* budget | LifeBot cue (≤240 chars today) needs trimming further for comfortable HUD reading |

**The pure-PWA-in-Safari path is dead.** Web Bluetooth direct to the glasses works for *text* (community has reverse-engineered the relevant BLE protocol), but **no community work has reverse-engineered the mic audio path** — capability A is gone. iOS Safari doesn't ship Web Bluetooth at all, so the browser-PWA route is Chrome-on-Android-only and would still lose audio. The native-bridged Even Hub WebView is the only viable path that gets both A and B.

## How the app reaches the glasses

The Even Hub app is the host; the glasses are paired with it over BLE. Your code runs in a WebView inside Even Hub, where the SDK's `bridge` object is injected. There are two ways the WebView can be pointed at your code:

1. **Dev mode — `evenhub qr --url <https-url>`.** Generates a QR. The Even Hub app scans it and navigates the WebView to that URL with the bridge injected and hot reload on. Works against *any* HTTPS origin you control, including the LifeBot home server. Architecture is literally `[Your Server] ←HTTPS→ [iPhone WebView] ←BLE→ [G2 Glasses]`. **This is the daily-driver path for a single-user app** — no `.ehpk` build, no rebuild/sideload cycle, edit-and-refresh is identical to the PWA dev experience.

2. **Production `.ehpk` — zipped local assets + `app.json` manifest.** The manifest's `entrypoint` is a *local* path (`index.html`); there is no `remote_url` field. Requires a `network` permission with origin whitelist for any `fetch()` to your home server (CORS still enforced on top of it).

For LifeBot's single-user case, dev-mode QR is the answer. For distribution to others, an undocumented but plausible workaround: ship a one-line stub `.ehpk` whose `index.html` does `location.replace('https://your-host/lifebot/')`. Whether the bridge survives that same-WebView cross-origin navigation is the **one unknown** — it should, but origin-isolation rules might block it. Defer until/unless distribution is actually needed.

## Architecture

Refactor the existing codebase to push platform-specific surface behind two thin adapters; share everything else.

```
src/
  core/                  ← unchanged across PWA and G2 builds
    orchestrator/        Gemini, classifier, system prompt building
    threads/             store, schedule, groups, hierarchy
    audio/VadPipeline    VAD logic, merge/flush rules, soft-commit
    util/                wav, base64, schedule parsing
  adapters/
    audio/
      WebAudioCapture.ts        ← getUserMedia + ScriptProcessorNode  (PWA)
      G2AudioCapture.ts         ← bridge.audioControl + audioPcm event (G2)
      types.ts                  ← interface { onPcmFrame, start, stop }
    display/
      DomCueRenderer.tsx        ← React CuePane                        (PWA)
      G2HudRenderer.ts          ← TextContainerProperty.upgrade()      (G2)
      types.ts                  ← interface { showCue, clearCue }
  entry/
    pwa.tsx              Vite entry — wires WebAudioCapture + DomCueRenderer
    g2.tsx               Even Hub entry — wires G2AudioCapture + G2HudRenderer
```

Build outputs:
- `npm run build:pwa` → `.serve/` (existing flow, no change)
- `npm run dev:g2`    → serves `entry/g2.tsx` on the existing dev server; pair via `evenhub qr --url https://desktop-uqt6i2t.tail9fb1cb.ts.net/lifebot-g2/` (or local LAN URL during initial bring-up)
- `npm run build:g2`  → `.ehpk` via `evenhub-cli pack` (only needed if/when distributing to other users)

The orchestrator already accepts PCM via `sendTurn(pcm: Uint8Array)`, so the audio adapter contract is small. The display adapter is even smaller — `showCue(text: string)` plus `clearCue()`. The current `CuePane` will become `DomCueRenderer` with a thin shim.

### What does NOT need to change

- Gemini orchestration (`GeminiAudioOrchestrator`) — already platform-agnostic
- Threads / groups / voiceprints — pure data, already over HTTP to the home server
- VAD logic — Silero VAD WASM works in any modern WebView (Even Hub is Chromium-based)
- System prompt building, cross-thread directory, group inference — all pure functions

The home server (`tailnet-proxy` + thread/group/voiceprint storage) stays as-is. The G2 build calls into the same `https://desktop-uqt6i2t.tail9fb1cb.ts.net/lifebot/...` endpoints over the network; the WebView has standard `fetch`.

## HUD UI — glance, don't read

The G2 display forces a fundamentally different UI than the PWA. Hard numbers from Even's own design guidelines (`everything-evenhub/skills/design-guidelines/SKILL.md` and `glasses-ui/SKILL.md`):

- **Resolution:** 576 × 288 px **per eye**, binocular (both eyes get the same image).
- **Color:** 4-bit greyscale, **single hue** `#3CFA44` (green). Black = transparent (see-through to real world). No backgrounds, no other colors.
- **Brightness:** 1,200 nits microLED. Indoor + most outdoor OK; direct sun and dappled light defeat it (clip-on sunshades are basically required outside).
- **Font:** one baked-in LVGL font, no size control, no bold/italic, no alignment. "Centering" = manual space-padding.
- **Update model:** three paths — boot (`createStartUpPageContainer`), full-page rebuild (`rebuildPageContainer`, **flashes**), partial update (`textContainerUpgrade` / `updateImageRawData`, flicker-free). **Live cue surfaces must use partial updates only.**
- **Per-page budget:** 12 containers max (8 text/list + 4 image), absolute pixel positioning only (no flexbox), declaration-order stacking.
- **Throughput:** 60 Hz hardware but the BLE queue is the bottleneck. Even's own ASR template debounces glasses writes to **≥120 ms** (~8 fps) because per-token writes overflow the queue.
- **Lists can't update in-place.** Any list change forces a full page rebuild, which flashes. Avoid lists for live data.

**Practical character budget:** ~400–500 chars *fills* the screen, but reviewers + Even's own template treat the G2 as a **glance device, not a read device**. The ASR template trims to a 240-char rolling buffer; for short cues the comfortable budget is closer to **80 chars across 2 lines** — readable in a glance without "stopping to read."

**Walking + small green text:** reviewers describe the HUD bouncing "like an erratic autocue" while walking. Long-form reading on the move is unpleasant. This further argues for short, glanceable cues.

### What this means for LifeBot

The PWA UI doesn't translate. The transcript pane, thread sidebar, group switcher, and multi-cue stacks all assume a screen LifeBot doesn't have on the G2. Adapt as follows:

| PWA element | G2 treatment |
|---|---|
| Transcript pane (scrolling) | **Drop on HUD.** Stays on the phone. Scrolling lists force full-page rebuilds and would flash on every update. |
| Cue pane (1–3 cues, ≤240 chars each) | **One cue at a time, ≤80 chars, 2 lines max, fades after ~6–8 s.** Format: line 1 = speaker name + ▸, line 2 = the cue. New cue replaces old. |
| Thread / group switcher | **Drop on HUD.** Configure on the phone before starting; HUD doesn't need it during the session. |
| Voiceprint + people management | **Drop on HUD.** Phone-only, post-session. |
| Recording state / VAD indicator | A small dot or ▸ glyph in a corner. Don't waste screen real estate. |

**Default HUD pattern:** dark by default (transparent), wake on cue, ~6–8 s dwell, fade. Optionally: a ring tap re-shows the last cue. This matches both the platform's strengths (transparent OLED, glance-friendly) and battery realities.

**Cue length contract** — change the orchestrator to emit **two budgets** rather than one: `cue_short` (≤80 chars, single sentence) for the HUD, `cue_long` (current ≤240 chars) for the PWA. Same model call; ask for both in the JSON schema. Keeps logic in one place; lets each renderer pick what fits.

## Phased rollout

The phases below are ordered by *value*, not by hardware availability. Phases 1 and the cue-schema work in 2-prep run in parallel with hardware acquisition — when the G2 arrives, hardware-only validation (Phases 0, 2-real, 3-real, 4) layers on top of the prepared seams. **Hardware testing is a late checkpoint, not a precondition.**

### Phase 1 — Refactor PWA into core + adapters (no behavior change) · *no hardware*

Code-only change — should ship without anyone noticing.

- [ ] Define `AudioCapture` interface (`adapters/audio/types.ts`)
- [ ] Move `LiveAudioCapture` → `adapters/audio/WebAudioCapture.ts`, implement the interface, no logic change
- [ ] Relocate `CuePane` → `adapters/display/DomCueRenderer.tsx` (no logic change; common interface deferred — DOM and HUD renderers have different shapes and forcing one interface today is YAGNI)
- [ ] Verify PWA build + typecheck clean and behavior unchanged

**Gate:** PWA works exactly as it does today. If you can't safely carve this seam, a second target will only multiply pain.

### Phase 2-prep — Cue schema (two-budget) · *no hardware*

Validate that Gemini can self-summarize at the HUD budget *before* hardware lands. The model is the model — no glasses needed.

- [x] Add `cueShort` (≤80 chars, single line) to the `AudioResponse` / `CommitEntry` / response-trace shapes. **Deviation from original plan:** kept the existing `cue` field as-is rather than renaming to `cue_long` — additive change, no on-disk thread-history migration, smaller diff. The two-budget contract reads `cue` (long) + `cueShort` (HUD).
- [x] Update the system prompt with explicit `cueShort` rules: ≤80 chars, single line, drop framing words, abbreviations OK, null when cue is null OR when no useful 80-char form exists for that cue
- [x] Parser enforces the contract: `cueShort` is forced to null when `cue` is null, regardless of model output
- [x] `DomCueRenderer` shows both: full cue body, then a "G2"-tagged row beneath it with the short form (or "— no short form available" when null) plus a character count, so we can eyeball compression quality in real sessions
- [ ] Run real LifeBot sessions; tune the prompt if `cueShort` is consistently bad
- [ ] Decide whether to also persist `cueShort` to thread history (`ThreadCommit` shape + proxy) — currently in-memory only, which is fine for prompt-tuning but loses cross-session signal

**Gate:** in real LifeBot use, the `cueShort` outputs are at least 70% useful (subjective, but you'll know). If they're consistently bad, the HUD experience can't work — escalate before investing in glasses-side code.

### Phase 2-preview — Desktop HUD preview · *no hardware*

A 576×288 simulator panel inside the PWA that renders what the G2 would show, **integrated as a fourth panel in the main app view** (not a separate dev page). Restructure the layout into a 2×2 grid:

```
┌─────────────────┬─────────────────┐
│  Transcript     │  Cues (DOM)     │
├─────────────────┼─────────────────┤
│  OrchestratorLog│  G2 HUD preview │
└─────────────────┴─────────────────┘
```

Top row = "what's happening now" (transcript + DOM cues). Bottom row = "what the system is doing" (log + HUD preview). Every real cue immediately shows up rendered both ways, so iteration on HUD format is continuous, not a separate dev workflow.

- [x] Restructure `App.tsx` layout from `[left-col][cues]` two-pane split to a 2×2 CSS grid (`.grid-2x2`, four direct cells, each independently scrollable via its inner `.pane`)
- [x] Add `<G2HudPreview />` adapter component at the bottom-right cell: native 576×288 fixed div, near-black background (`#050505`), single-hue green text `#3CFA44` with subtle glow, monospace 32px (rough proxy for the LVGL firmware font at native pixel density)
- [x] Wire it to the same `cues[]` state as `DomCueRenderer` — same input, different render
- [x] Implement the renderer logic in `G2HudCore.ts`: ≥120 ms debounce, ~7 s fade clear, word-wrap to 2 lines × 25 chars, "…" truncation, hard-break for single oversized words. **Sink-agnostic** — the same `G2HudCore` will back the real `G2HudRenderer` in Phase 3-real; only the `onFrame` callback changes (DOM React state → `bridge.textContainerUpgrade`).
- [x] Renders `cueShort` directly (Phase 2-prep already shipped it). When `cueShort` is null, leaves HUD dark — honest signal that the real device would skip too.
- [ ] Try several formats live in real sessions (currently cue-only; speaker prefix and multi-cue stack are easy follow-ups once we see real data)

**Gate:** you can identify a preferred HUD layout and timing without ambiguity. The renderer logic transfers verbatim to the real `G2HudRenderer` in Phase 3-real — only the output sink (DOM div → `bridge.textContainerUpgrade`) changes.

### Phase 0 — Hardware bring-up (blocking, external) · *first hardware contact*

- [x] Acquire G2 hardware (arriving this week)
- [ ] Install Even Hub iOS/Android app, pair G2 over BLE
- [ ] `npm install -g @evenrealities/evenhub-cli`
- [ ] Confirm the Even Hub WebView can reach `https://desktop-uqt6i2t.tail9fb1cb.ts.net/...` from the phone (Tailscale on the phone should make this transparent — `fetch()` from a stub page logs success/failure)
- [ ] Run a hello-world from `evenhub-templates/asr` against `evenhub qr --url <local-vite-url>` — confirms mic + HUD both work end-to-end via the dev-mode QR flow
- [ ] Capture a short PCM clip via `audioEvent.audioPcm`, dump to file/console — measure frame size and cadence to confirm Silero VAD-web compatibility

**Gate:** if the `asr` template doesn't show transcribed text on the HUD within a few minutes, stop and reassess. SDK or hardware issues are the most likely killer.

> **Pre-hardware checklist:** before the G2 box is opened, Phase 1 is complete, Phase 2-prep is complete (cue_short in production), and Phase 2-preview has converged on a HUD layout we like. Phase 0 then just confirms the SDK works on real hardware before plugging adapters in.

### Phase 2-sim — Simulator-driven HUD (the iframe-equivalent) · *no hardware*

The `evenhub-simulator` (separate `@evenrealities/evenhub-simulator` npm package, native Tauri desktop app) is a *host*: launch it pointed at the Vite dev server, it loads the PWA inside its own WebView with the SDK `bridge` injected, paints `bridge.textContainerUpgrade` calls onto a 576×288 LVGL framebuffer in its own window. With `--automation-port 9898` it exposes an HTTP API including `GET /api/screenshot/glasses` (PNG of the live framebuffer).

This collapses what was Phase 3-real into a no-hardware task: write the real bridge adapter now, validate against the simulator's actual LVGL output, only revisit on real glass for latency/readability.

- [x] Install `@evenrealities/even_hub_sdk` as project dep, install `@evenrealities/evenhub-simulator` globally (Linux: also `sudo apt install libwebkit2gtk-4.1-0`)
- [x] Vite proxy: `/sim-api` → `http://127.0.0.1:9898` (avoids CORS when the PWA polls the screenshot endpoint)
- [x] `G2HudRenderer.ts` — wraps `G2HudCore`; `init()` waits up to 1.5 s for `waitForEvenAppBridge`, creates a single text container at 0,0,576,288, then translates each `onFrame` into `bridge.textContainerUpgrade(...)`. No-op when no bridge present, so it's safe to instantiate unconditionally in App.tsx.
- [x] `G2HudPreview.tsx` — runtime mode switch: pings `/sim-api/api/ping` every 5 s; if reachable, shows `<img src="/sim-api/api/screenshot/glasses?t=tick">` polling at 500 ms; otherwise falls back to the hand-rolled DOM mock. Live indicator badge in header.
- [x] App.tsx wires `G2HudRenderer` to receive `cueShort` on every cue alongside the existing `setCues` call

**How to run end-to-end (no glasses needed):**
```bash
# 1. Vite dev server (in WSL2)
npm run dev                                   # → http://localhost:5174

# 2. Simulator (separate terminal, also in WSL2)
DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 \
XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir \
evenhub-simulator -g http://localhost:5174 --automation-port 9898

# 3. The simulator window opens, loads the PWA. The PWA detects the bridge,
#    G2HudRenderer pushes cue_short to the LVGL framebuffer. The PWA's bottom-
#    right pane simultaneously polls the screenshot endpoint and shows the
#    same framebuffer inline.
```

**Gate:** cues land on the simulator HUD with the right layout (2 lines, debounced, fading). If the simulator's rendering disagrees with the DOM mock substantially, the DOM mock's font-size preset is wrong — calibrate it against the simulator's output.

### Phase 2-real — G2 audio adapter · *needs hardware*

Build the G2 audio path; output to console for now (no HUD yet). Run via `evenhub qr --url ...` — no `.ehpk` packaging yet.

- [ ] Add `entry/g2.tsx` to the Vite config as a second entry, served alongside the PWA
- [ ] Implement `adapters/audio/G2AudioCapture.ts` — wraps `bridge.audioControl(true)` and emits PCM frames matching the `AudioCapture` interface from Phase 1
- [ ] Decide VAD strategy: re-use the PWA's vad-web pipeline (requires switching MicVAD to its lower-level `AudioNodeVAD`/`NonRealTimeVAD` API since `audioPcm` arrives as discrete BLE events, not as a `MediaStreamTrack`) vs ship a simpler "fixed-window" pipeline for G2. Decide based on Phase 0 frame-cadence measurements.
- [ ] Wire it into the Gemini orchestrator
- [ ] Confirm cues are *generated* correctly (log to JS console; inspect via `evenhub-cli` or simulator)

**Gate:** generating coherent cues from glasses-mic audio. If mic quality (per reviewer concerns about noisy environments) makes cues unreliable, that's a project-level red flag — note it and decide whether to ship anyway with documented limitations.

### Phase 3-real — G2 HUD renderer · *needs hardware*

Renderer is **already written and validated against the simulator** in Phase 2-sim. Hardware just confirms three things the simulator can't:

- Real BLE-PCM round-trip latency from cue → on-glass paint
- Readability of the chosen font size + cue length on actual outdoor / dappled-light scenes
- Battery cost of `textContainerUpgrade` cadence

- [x] `G2HudCore.ts` (debounce, fade timer, line-wrap, truncate) — pure, ships in Phase 2-preview
- [x] `G2HudRenderer.ts` (real `bridge.textContainerUpgrade` adapter) — ships in Phase 2-sim
- [ ] Verify on real hardware that partial updates are flicker-free at the chosen cadence (no `rebuildPageContainer` on the live cue surface)
- [ ] Measure cue → on-glass paint latency end-to-end
- [ ] Tune font-size preset in `G2HudPreview` so the DOM mock matches what real glass renders (calibrate against side-by-side viewing)
- [ ] (Stretch) wake-on-tap: if SDK exposes a ring-tap event, re-show the last cue for 6 s

**Gate:** read-and-react latency feels usable in real conversation. If the cue arrives 2 seconds after the question is asked, that may still be useful for fact-checks but useless for in-flow assists. Time it. Also gate on glanceability — if you find yourself "reading" the HUD instead of glancing, the cue is too long; tighten the `cue_short` budget.

### Phase 4 — Daily-driver hardening

- [ ] Voiceprint capture path — does the G2 mic produce voiceprints good enough to identify speakers later? Test against the existing pipeline.
- [ ] Battery measurements — how long does a session last with mic on continuously? Doc the number.
- [ ] Decide whether the dev-mode QR is the long-term install path (likely YES for personal use) or whether to also build a `.ehpk` for offline launch. If `.ehpk`: try the stub-redirect approach (one-line `index.html` doing `location.replace(...)`) before investing in a full local bundle, since it preserves the single-source-of-truth dev loop.
- [ ] Decide on App Store distribution (probably NO — single-user app, dev-mode QR forever)

## Risks & unknowns

**Hardware-dependent (can't validate without device):**

- Mic quality in noisy environments. Reviewers consistently flag this. May break the use case for restaurants / D&D-with-music sessions. Mitigation: phone-mic fallback (use the PWA when mic conditions are bad).
- HUD readability over real-world backgrounds. Single-hue green at 1200 nits + small text + variable-brightness world. Confirmed problematic in direct sun and dappled light per reviews; clip-on sunshades likely required outdoors.
- Walking-bounce reading discomfort. Forces short cues + dwell-and-fade rather than scrollback. Already designed around this in the HUD UI section, but worth re-validating once hardware is in hand.
- Comfort during 4-hour sessions. The G2 is light (36g) but Rx lenses change the weight distribution.

**SDK / platform:**

- WebView-to-WebView latency for PCM frames. PCM travels Glasses → Phone-via-BLE → WebView. If end-to-end latency is >1s, cues lag the conversation badly.
- API key management inside `.ehpk` — does it ship with environment vars, or do we have to embed and hope for the best? (Single-user sideload, low concern, but worth confirming.)
- Sideload-mode permission quirks — one Zenn dev reported GPS broken in sideloaded apps. Probably doesn't affect us, but means other unexpected things might.
- Simulator-vs-hardware drift. Plan to QA on real device, not just `evenhub-simulator`.

**Project-level:**

- This roughly doubles the surface area of LifeBot. Worth it only if the G2 experience is genuinely better than glancing at a phone. Decide that early — if the prototype isn't notably better, kill the G2 build rather than maintain two.

## Open questions to answer in Phase 0/1

1. Does the WebView allow arbitrary HTTPS to `desktop-uqt6i2t.tail9fb1cb.ts.net` over the user's phone tailnet? (Tailscale on the phone should make it transparent, but confirm.) Note: CORS is enforced by the WebView even with the `network` permission; the home server already serves same-origin so this should be a non-issue, but verify.
2. PCM frame size and cadence from `audioEvent.audioPcm` — does Silero VAD-web work directly on those frames, or does it need rebuffering?
3. ~~How does `TextContainerProperty.upgrade()` handle rapid successive calls — debounce required, or built-in?~~ **Answered:** debounce required, ≥120 ms (Even's own ASR template).
4. Image/list containers — useful for showing speaker name + cue together, or overkill?
5. Is there a way to "wake" the HUD only when there's a cue (vs. it being on continuously)? Battery life depends on this.
6. (Phase 4 only, if pursuing distribution) Does a stub `.ehpk` whose `index.html` does `location.replace(<remote-url>)` keep the SDK `bridge` alive after navigation, or does the cross-origin nav strip it?

## References

- **Official docs:** https://hub.evenrealities.com/docs/getting-started/overview
- **Architecture (dev-mode flow):** https://hub.evenrealities.com/docs/getting-started/architecture
- **CLI reference + `app.json` schema:** https://github.com/even-realities/everything-evenhub (`skills/cli-reference/SKILL.md`, `skills/build-and-deploy/SKILL.md`)
- **Design guidelines (read in full before Phase 3):** `everything-evenhub/skills/design-guidelines/SKILL.md`
- **HUD container API + update model:** `everything-evenhub/skills/glasses-ui/SKILL.md`
- **Official Figma:** https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-
- **Templates (start from `asr`):** https://github.com/even-realities/evenhub-templates
- **Verified feature matrix with code snippets:** https://zenn.dev/bigdra/articles/eveng2-sdk-features?locale=en
- **Community React hooks + components:** https://github.com/fabioglimb/even-toolkit
- **G2 BLE reverse engineering (display only):** https://github.com/i-soxi/even-g2-protocol
- **G1 reference Flutter app (different model, useful for protocol patterns):** https://github.com/even-realities/EvenDemoApp

## Decision log

- **2026-05-02:** Picked the official SDK / WebView path over Web Bluetooth direct. Reason: Web Bluetooth has no audio path on G2 today and no Safari support on iOS — both deal-breakers. Revisit if community reverse-engineers the mic protocol.
- **2026-05-02:** Sharing core code via adapter pattern in a single repo, NOT two separate repos. Reason: orchestrator + threads + voiceprints are 90% of the value and change frequently — duplication would be expensive.
- **2026-05-02:** Keep the home-server as-is. The G2 build is a third client to the same `/lifebot/threads`, `/lifebot/groups`, `/lifebot/voiceprints` API, alongside the PWA and any future native clients.
- **2026-05-02:** Use `evenhub qr --url ...` against the existing tailnet-hosted Vite build as the primary install path, rather than producing `.ehpk` packages. Reason: this is a single-user app, the dev-mode flow loads any HTTPS URL with the bridge injected and hot reload on, and it collapses the build/sideload cycle. `.ehpk` distribution becomes a Phase 4 question only if other users ever need it — and the stub-redirect approach (`index.html` → `location.replace(remote)`) likely makes even that a thin shell rather than a separate bundle.
- **2026-05-02:** HUD UI is its own design problem, not a port of the PWA. Cue budget shrinks from ≤240 chars to **≤80 chars / 2 lines** for the HUD; transcript and thread management stay phone-only; renderer uses partial-update only with ≥120 ms debounce. Reason: 576×288 single-hue green display + walking-bounce + glance-not-read consensus from reviewers and Even's own ASR template (240-char rolling buffer, 120 ms debounce). Add `cue_short` alongside `cue_long` in the Gemini schema so each renderer picks what fits.

# Project Overview: "Conversate" Prototype for Galaxy Z Fold 7

## The Objective

Build a React Native (Expo) application that acts as a passive, real-time background monitor. It will listen to ambient conversation (e.g., a tabletop game session or study group), generate a continuous local transcript, and proactively push contextual AI cues (rules, definitions, references) to the screen using the Gemini Flash API.

## Architecture Summary

- **Environment:** On-device development via Termux + Claude Code.
- **Framework:** React Native via Expo (compiled via EAS for native C++ modules).
- **Audio STT (Local):** whisper.rn using a Tiny English model with built-in VAD (Voice Activity Detection).
- **AI Engine (Cloud):** Gemini 1.5/2.5 Flash via REST API (Stateful/Context-Aware).
- **UI Layout:** Dual-pane split screen optimized for the 12GB Z Fold 7 inner display.

## Phase 1: Environment & Dependency Setup

- **Init:** Scaffold a new Expo project (`npx create-expo-app`).
- **Core Native Modules:**
  - Install `whisper.rn` for local, offline STT.
  - Configure `app.json` with the necessary Expo plugins to support the C++ bindings of `whisper.rn`.
  - Add permissions for `RECORD_AUDIO` and `INTERNET`.
- **Model Management:** Implement a startup check to download the Whisper `ggml-tiny.en.bin` and the `silero_vad.onnx` models to the local device file system if they do not exist.

## Phase 2: The Audio Pipeline (Local STT & Smart Batching)

We must avoid arbitrary audio slicing. We will use a combination of acoustic and semantic checks to ensure complete sentences are evaluated.

- **Initialize RealtimeTranscriber:** Set up `whisper.rn` with the downloaded local models.
- **Acoustic Batching (VAD):**
  - Enable VAD.
  - Set `minSpeechDurationMs` to filter out background noise (e.g., ~300ms).
  - Set `minSilenceDurationMs` to ~600ms. This tells the engine to finalize an audio chunk when the speaker naturally pauses for a breath.
- **Semantic Buffer:**
  - As Whisper outputs finalized text chunks, append them to a React state variable (`sttBuffer`).
  - Check the end of `sttBuffer`. Does it end with terminal punctuation (`.`, `?`, `!`)?
  - If **NO:** Wait for the next chunk to append.
  - If **YES:** Extract the complete sentence/paragraph from `sttBuffer`, clear the buffer, and pass the text to the Orchestrator.

## Phase 3: The Orchestrator & Cloud LLM Pipeline

We will use standard HTTP REST calls to the Gemini Flash API to evaluate the finalized text chunks.

- **The API Trigger:** Receive the finalized, punctuated text chunk from Phase 2.
- **The Payload Structure:** Construct a REST POST request to the Gemini Flash endpoint.
- **System Prompt Constraint:** "You are a passive session monitor. Read the following transcript. If the user mentions a specific factual claim, D&D rule, or requests data, output a brief, helpful summary in JSON format `{"cue": "text"}`. If no specific help is needed from the text, output exactly `{"cue": null}`."
- **Stateful Context:**
  - Use the stateful conversational history parameters (maintaining the `contents` array with previous turns, or using the Interactions API ID if available) to ensure Gemini remembers the context of the session up to this point.
  - Rely on Google's implicit context caching for cost/speed efficiency on repeated history payloads.
- **Handling Responses:**
  - Parse the returned JSON.
  - If `cue` is `null`, discard silently.
  - If `cue` contains text, push it to the UI's Cue Stack.

## Phase 4: UI / UX Implementation

Design specifically for the large inner display of the Galaxy Z Fold 7.

- **Layout:** Horizontal Split (Flex Row).
- **Left Pane (The Feed):** A FlatList/ScrollView displaying the raw, rolling text output directly from `whisper.rn`. This provides visual confirmation that the microphone is hearing the room correctly.
- **Right Pane (The Cues):** A stack of Card components. When Phase 3 returns a valid AI cue, push a new Card to the top of this list. Include a dismiss/swipe-away gesture for old cards.

## Phase 5: The Build & Deployment Workflow

Because Termux cannot natively compile the Android NDK C++ code required by `whisper.rn`:

- Do **not** use bare React Native CLI.
- Once Claude Code has written the logic and UI, run `eas build --platform android --profile development` from within Termux.
- EAS will compile the APK in the cloud.
- Download the resulting APK via the provided link directly to the Z Fold 7 and install it to test the microphone and inference pipeline.

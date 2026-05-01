import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, SafeAreaView, StatusBar, StyleSheet, View } from 'react-native';
import { GEMINI_API_KEY, GEMINI_LIVE_MODEL } from '@env';

import {
  LiveAudioCapture,
  requestMicPermission,
} from './src/audio/LiveAudioCapture';
import { GeminiLiveOrchestrator } from './src/orchestrator/GeminiLive';
import { bootstrapModels, type BootstrapEvent } from './src/models/bootstrap';
import { TranscriptPane } from './src/ui/TranscriptPane';
import { CuePane, type Cue } from './src/ui/CuePane';
import { BootstrapScreen } from './src/ui/BootstrapScreen';
import { Controls } from './src/ui/Controls';
import { OrchestratorLog, type LogEntry } from './src/ui/OrchestratorLog';
import { spacing, theme } from './src/ui/theme';
import type { TranscriptChunk } from './src/audio/AudioPipeline';
import { LogUploader } from './src/util/LogUploader';

const API_KEY: string = GEMINI_API_KEY ?? '';
const LIVE_MODEL: string = GEMINI_LIVE_MODEL ?? 'gemini-3.1-flash-live-preview';

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapEvent | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | undefined>();
  const [pipelineReady, setPipelineReady] = useState(false);

  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [active, setActive] = useState(false);
  const [vadActive, setVadActive] = useState(false);

  const [cues, setCues] = useState<Cue[]>([]);
  const [pendingCues, setPendingCues] = useState(0);
  const cueSeq = useRef(0);
  const chunkSeq = useRef(0);

  const [log, setLog] = useState<LogEntry[]>([]);
  const logSeq = useRef(0);

  const captureRef = useRef<LiveAudioCapture | null>(null);
  const orchestratorRef = useRef<GeminiLiveOrchestrator | null>(null);
  const uploaderRef = useRef<LogUploader>(new LogUploader());

  const appendLog = useCallback((entry: Omit<LogEntry, 'id'>) => {
    const full: LogEntry = { ...entry, id: ++logSeq.current };
    setLog((prev) => [...prev, full].slice(-200));
    uploaderRef.current.enqueue(full);
  }, []);

  useEffect(() => {
    const uploader = uploaderRef.current;
    uploader.start();
    return () => uploader.stop();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { vadPath } = await bootstrapModels((event) => {
          if (!cancelled) setBootstrap(event);
        });
        if (cancelled) return;

        if (!API_KEY) {
          throw new Error('GEMINI_API_KEY not set');
        }

        const orchestrator = new GeminiLiveOrchestrator({
          apiKey: API_KEY,
          model: LIVE_MODEL,
          onTrace: (event) => {
            switch (event.type) {
              case 'connecting':
                appendLog({ kind: 'sent', at: event.at, text: 'connecting…', meta: LIVE_MODEL });
                break;
              case 'connected':
                appendLog({ kind: 'sent', at: event.at, text: 'WebSocket open' });
                break;
              case 'setup_sent':
                appendLog({ kind: 'sent', at: event.at, text: 'setup sent' });
                break;
              case 'setup_complete':
                appendLog({ kind: 'sent', at: event.at, text: 'setup complete (server)' });
                break;
              case 'sent_audio':
              case 'input_transcript_partial':
              case 'output_transcript_partial':
              case 'response_text':
                // Too noisy.
                break;
              case 'turn_complete':
                appendLog({
                  kind: 'sent',
                  at: event.at,
                  text: `turn: heard "${event.heard.slice(0, 80)}", said "${event.said.slice(0, 80)}"`,
                });
                break;
              case 'error':
                appendLog({ kind: 'error', at: event.at, text: event.error });
                break;
              case 'closed':
                appendLog({
                  kind: 'error',
                  at: event.at,
                  text: 'connection closed',
                  meta: event.reason || `code ${event.code ?? '?'}`,
                });
                break;
            }
          },
          onResponse: (response) => {
            if (response.heard) {
              setChunks((prev) =>
                [
                  ...prev,
                  {
                    id: ++chunkSeq.current,
                    text: response.heard ?? '',
                    startedAt: Date.now(),
                    finalizedAt: Date.now(),
                    eventType: 'live' as const,
                  },
                ].slice(-300),
              );
            }
            if (response.cue) {
              const cueText = response.cue;
              appendLog({
                kind: 'cue',
                at: Date.now(),
                text: cueText,
                meta: response.heard ?? undefined,
              });
              setCues((prev) =>
                [
                  {
                    id: ++cueSeq.current,
                    text: cueText,
                    createdAt: Date.now(),
                    source: response.heard ?? '',
                  },
                  ...prev,
                ].slice(0, 50),
              );
            } else {
              appendLog({
                kind: 'null',
                at: Date.now(),
                text: '(no cue)',
                meta: response.heard ?? undefined,
              });
            }
          },
        });
        orchestratorRef.current = orchestrator;

        const capture = new LiveAudioCapture(vadPath, orchestrator, {
          onVadActive: (a) => setVadActive(a),
          onAudioSent: (bytes) => {
            // Maintain a small "in-flight" counter as a stand-in for activity.
            setPendingCues((n) => n);
            void bytes;
          },
          onError: (msg) => Alert.alert('Audio error', msg),
          onStatusChange: (a) => setActive(a),
        });
        captureRef.current = capture;
        setPipelineReady(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setBootstrapError(msg);
      }
    })();

    return () => {
      cancelled = true;
      void captureRef.current?.release();
    };
  }, [appendLog]);

  const onToggle = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    if (capture.isActive) {
      await capture.stop();
      return;
    }
    const ok = await requestMicPermission();
    if (!ok) {
      Alert.alert('Microphone needed', 'Grant mic permission to use LifeBot.');
      return;
    }
    try {
      await capture.start();
    } catch (e) {
      Alert.alert('Failed to start', e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onDismissCue = useCallback((id: number) => {
    setCues((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const onClearCues = useCallback(() => setCues([]), []);

  const onUpdate = useCallback(() => {
    // Opens the APK URL in the system browser. The browser downloads the
    // file and shows a notification; tapping it triggers the system installer.
    void Linking.openURL('https://desktop-uqt6i2t.tail9fb1cb.ts.net/lifebot/lifebot.apk');
  }, []);

  if (!pipelineReady) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
        <BootstrapScreen event={bootstrap} error={bootstrapError} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <Controls
        active={active}
        geminiConfigured={!!API_KEY}
        pendingCues={pendingCues}
        onToggle={onToggle}
        onUpdate={onUpdate}
      />
      <View style={styles.split}>
        <View style={styles.leftColumn}>
          <View style={styles.transcriptWrap}>
            <TranscriptPane chunks={chunks} active={active} vadActive={vadActive} />
          </View>
          <View style={styles.logWrap}>
            <OrchestratorLog entries={log} />
          </View>
        </View>
        <CuePane cues={cues} onDismiss={onDismissCue} onClear={onClearCues} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  split: {
    flex: 1,
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  leftColumn: { flex: 1, flexDirection: 'column', gap: spacing.sm },
  transcriptWrap: { flex: 2 },
  logWrap: { flex: 1, minHeight: 140 },
});

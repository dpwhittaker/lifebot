import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, SafeAreaView, StatusBar, StyleSheet, View } from 'react-native';
import { GEMINI_API_KEY, GEMINI_MODEL } from '@env';

import {
  AudioPipeline,
  requestMicPermission,
  type TranscriptChunk,
} from './src/audio/AudioPipeline';
import { GeminiOrchestrator } from './src/orchestrator/Gemini';
import { bootstrapModels, type BootstrapEvent } from './src/models/bootstrap';
import { TranscriptPane } from './src/ui/TranscriptPane';
import { CuePane, type Cue } from './src/ui/CuePane';
import { BootstrapScreen } from './src/ui/BootstrapScreen';
import { Controls } from './src/ui/Controls';
import { spacing, theme } from './src/ui/theme';

const API_KEY: string = GEMINI_API_KEY ?? '';
const MODEL: string = GEMINI_MODEL ?? 'gemini-2.5-flash';

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapEvent | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | undefined>();
  const [pipelineReady, setPipelineReady] = useState(false);

  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [partial, setPartial] = useState('');
  const [active, setActive] = useState(false);
  const [vadActive, setVadActive] = useState(false);

  const [cues, setCues] = useState<Cue[]>([]);
  const [pendingCues, setPendingCues] = useState(0);
  const cueSeq = useRef(0);

  const pipelineRef = useRef<AudioPipeline | null>(null);
  const orchestratorRef = useRef<GeminiOrchestrator | null>(null);

  const evaluateSentence = useCallback(async (sentence: string) => {
    const orchestrator = orchestratorRef.current;
    if (!orchestrator) return;
    setPendingCues((n) => n + 1);
    try {
      const result = await orchestrator.submit(sentence);
      if (result?.cue) {
        setCues((prev) =>
          [
            {
              id: ++cueSeq.current,
              text: result.cue!,
              createdAt: Date.now(),
              source: sentence,
            },
            ...prev,
          ].slice(0, 50),
        );
      }
    } catch (e) {
      console.warn('Gemini error', e);
    } finally {
      setPendingCues((n) => Math.max(0, n - 1));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { whisperPath, vadPath } = await bootstrapModels((event) => {
          if (!cancelled) setBootstrap(event);
        });
        if (cancelled) return;

        const pipeline = new AudioPipeline(whisperPath, vadPath, {
          onPartial: (text) => setPartial(text),
          onChunk: (chunk) => {
            setPartial('');
            setChunks((prev) => [...prev, chunk].slice(-300));
          },
          onSentence: (sentence) => {
            void evaluateSentence(sentence);
          },
          onVad: (event) => {
            if (event.type === 'speech_start') setVadActive(true);
            if (event.type === 'speech_end' || event.type === 'silence') setVadActive(false);
          },
          onError: (msg) => Alert.alert('Audio error', msg),
          onStatusChange: (isActive) => setActive(isActive),
        });

        pipelineRef.current = pipeline;
        if (API_KEY) {
          orchestratorRef.current = new GeminiOrchestrator({
            apiKey: API_KEY,
            model: MODEL,
          });
        }
        setPipelineReady(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setBootstrapError(msg);
      }
    })();

    return () => {
      cancelled = true;
      void pipelineRef.current?.release();
    };
  }, [evaluateSentence]);

  const onToggle = useCallback(async () => {
    const pipeline = pipelineRef.current;
    if (!pipeline) return;
    if (pipeline.isActive) {
      await pipeline.stop();
      return;
    }
    const ok = await requestMicPermission();
    if (!ok) {
      Alert.alert('Microphone needed', 'Grant mic permission to use LifeBot.');
      return;
    }
    try {
      await pipeline.start();
    } catch (e) {
      Alert.alert('Failed to start', e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onDismissCue = useCallback((id: number) => {
    setCues((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const onClearCues = useCallback(() => setCues([]), []);

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
      />
      <View style={styles.split}>
        <TranscriptPane chunks={chunks} partial={partial} active={active} vadActive={vadActive} />
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
  },
});

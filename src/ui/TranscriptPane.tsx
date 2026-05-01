import { useEffect, useRef } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, theme } from './theme';
import type { TranscriptChunk } from '../audio/AudioPipeline';

type Props = {
  chunks: TranscriptChunk[];
  active: boolean;
  vadActive: boolean;
};

export function TranscriptPane({ chunks, active, vadActive }: Props) {
  const listRef = useRef<FlatList<TranscriptChunk>>(null);

  useEffect(() => {
    if (chunks.length === 0) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [chunks.length]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Transcript</Text>
        <View style={styles.statusRow}>
          <Pill label={active ? 'LISTENING' : 'OFF'} tone={active ? 'good' : 'muted'} />
          <Pill label={vadActive ? 'VOICE' : 'silence'} tone={vadActive ? 'accent' : 'muted'} />
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={chunks}
        keyExtractor={(c) => String(c.id)}
        renderItem={({ item }) => (
          <View style={styles.chunkRow}>
            <Text style={styles.timestamp}>{formatTime(item.finalizedAt)}</Text>
            <View style={styles.chunkBody}>
              <Text style={styles.chunkText}>{item.text}</Text>
              {item.eventType && (
                <Text style={styles.diag}>{formatDiag(item)}</Text>
              )}
            </View>
          </View>
        )}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {active
                ? 'Listening for speech…'
                : 'Tap “Start Listening” to begin transcribing the room.'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

function Pill({ label, tone }: { label: string; tone: 'good' | 'accent' | 'muted' }) {
  const color =
    tone === 'good' ? theme.good : tone === 'accent' ? theme.accent : theme.textMuted;
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDiag(item: TranscriptChunk): string {
  const parts: string[] = [];
  if (item.eventType) parts.push(item.eventType);
  if (item.sliceIndex !== undefined) parts.push(`slice ${item.sliceIndex}`);
  if (item.isCapturing !== undefined) {
    parts.push(item.isCapturing ? 'capturing' : 'final');
  }
  if (item.recordingTimeMs !== undefined) {
    parts.push(`${formatMs(item.recordingTimeMs)} audio`);
  }
  if (item.processTimeMs !== undefined) {
    parts.push(`${formatMs(item.processTimeMs)} infer`);
  }
  return parts.join(' · ');
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.panel,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: theme.panelEdge,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  title: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  statusRow: { flexDirection: 'row', gap: spacing.sm },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  pillText: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  listContent: { paddingBottom: spacing.lg, gap: spacing.sm },
  chunkRow: { flexDirection: 'row', gap: spacing.md },
  timestamp: {
    color: theme.textMuted,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    paddingTop: 3,
    width: 64,
  },
  chunkBody: { flex: 1 },
  chunkText: { color: theme.text, fontSize: 16, lineHeight: 22 },
  diag: {
    color: theme.textMuted,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
    marginTop: 2,
  },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { color: theme.textMuted, textAlign: 'center', fontSize: 14, lineHeight: 20 },
});

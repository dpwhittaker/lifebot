import { useEffect, useRef } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, theme } from './theme';
import type { TranscriptChunk } from '../audio/AudioPipeline';

type Props = {
  chunks: TranscriptChunk[];
  partial: string;
  active: boolean;
  vadActive: boolean;
};

export function TranscriptPane({ chunks, partial, active, vadActive }: Props) {
  const listRef = useRef<FlatList<TranscriptChunk>>(null);

  useEffect(() => {
    if (chunks.length === 0) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [chunks.length, partial]);

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
            <Text style={styles.chunkText}>{item.text}</Text>
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
        ListFooterComponent={
          partial ? (
            <View style={[styles.chunkRow, styles.partialRow]}>
              <Text style={styles.timestamp}>·</Text>
              <Text style={styles.partialText}>{partial}</Text>
            </View>
          ) : null
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.panel,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginRight: spacing.sm,
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
  chunkText: { color: theme.text, fontSize: 16, lineHeight: 22, flex: 1 },
  partialRow: { opacity: 0.6 },
  partialText: { color: theme.accent, fontSize: 16, lineHeight: 22, flex: 1, fontStyle: 'italic' },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { color: theme.textMuted, textAlign: 'center', fontSize: 14, lineHeight: 20 },
});

import { useEffect, useRef } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, theme } from './theme';

export type LogEntry = {
  id: number;
  kind: 'sent' | 'cue' | 'null' | 'error';
  at: number;
  text: string;
  meta?: string;
};

type Props = { entries: LogEntry[] };

export function OrchestratorLog({ entries }: Props) {
  const listRef = useRef<FlatList<LogEntry>>(null);

  useEffect(() => {
    if (entries.length === 0) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [entries.length]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Orchestrator</Text>
        <Text style={styles.sub}>{entries.length} events</Text>
      </View>
      <FlatList
        ref={listRef}
        data={entries}
        keyExtractor={(e) => `${e.id}-${e.kind}`}
        renderItem={({ item }) => <Row entry={item} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Waiting for the first complete sentence to evaluate…
          </Text>
        }
      />
    </View>
  );
}

function Row({ entry }: { entry: LogEntry }) {
  const color =
    entry.kind === 'cue'
      ? theme.good
      : entry.kind === 'error'
        ? theme.error
        : entry.kind === 'sent'
          ? theme.accent
          : theme.textMuted;
  const glyph =
    entry.kind === 'sent' ? '→' : entry.kind === 'cue' ? '✓' : entry.kind === 'null' ? '·' : '✗';
  return (
    <View style={styles.row}>
      <Text style={styles.timestamp}>{formatTime(entry.at)}</Text>
      <Text style={[styles.glyph, { color }]}>{glyph}</Text>
      <View style={styles.body}>
        <Text style={[styles.text, { color }]}>{entry.text}</Text>
        {entry.meta && <Text style={styles.meta}>{entry.meta}</Text>}
      </View>
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
    borderWidth: 1,
    borderColor: theme.panelEdge,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  title: { color: theme.text, fontSize: 14, fontWeight: '600', letterSpacing: 0.4 },
  sub: { color: theme.textMuted, fontSize: 11 },
  listContent: { paddingBottom: spacing.md, gap: 4 },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  timestamp: {
    color: theme.textMuted,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    paddingTop: 2,
    width: 60,
  },
  glyph: { fontSize: 13, fontWeight: '700', width: 14, textAlign: 'center' },
  body: { flex: 1 },
  text: { fontSize: 12, lineHeight: 16 },
  meta: { color: theme.textMuted, fontSize: 10, marginTop: 1, fontStyle: 'italic' },
  empty: { color: theme.textMuted, fontSize: 12, textAlign: 'center', padding: spacing.lg },
});

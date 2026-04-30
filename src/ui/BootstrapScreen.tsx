import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, theme } from './theme';
import type { BootstrapEvent, ModelStatus } from '../models/bootstrap';

type Props = { event: BootstrapEvent | null; error?: string };

export function BootstrapScreen({ event, error }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>LifeBot</Text>
      <Text style={styles.subtitle}>Preparing on-device models…</Text>

      {event && (
        <View style={styles.list}>
          <ModelRow status={event.whisper} />
          <ModelRow status={event.vad} />
        </View>
      )}

      {!event && <ActivityIndicator color={theme.accent} />}

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function ModelRow({ status }: { status: ModelStatus }) {
  const stateLabel = status.state.toUpperCase();
  const tone =
    status.state === 'ready'
      ? theme.good
      : status.state === 'error'
        ? theme.error
        : theme.accent;
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowName}>{status.spec.name}</Text>
        <Text style={[styles.rowState, { color: tone }]}>{stateLabel}</Text>
      </View>
      <Text style={styles.rowMeta}>
        {status.spec.filename} · ~{Math.round(status.spec.bytesApprox / 1_000_000)} MB
      </Text>
      {status.state === 'downloading' && (
        <Text style={styles.rowMeta}>
          {Math.round(status.receivedBytes / 1_000_000)} /{' '}
          {Math.round(status.totalBytes / 1_000_000)} MB
        </Text>
      )}
      {status.state === 'error' && <Text style={styles.error}>{status.error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    backgroundColor: theme.bg,
    gap: spacing.lg,
  },
  title: { color: theme.text, fontSize: 32, fontWeight: '700', letterSpacing: 0.6 },
  subtitle: { color: theme.textMuted, fontSize: 14 },
  list: { gap: spacing.md },
  row: {
    backgroundColor: theme.panel,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: theme.panelEdge,
    gap: spacing.xs,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  rowName: { color: theme.text, fontSize: 16, fontWeight: '600' },
  rowState: { fontSize: 11, letterSpacing: 1, fontWeight: '700' },
  rowMeta: { color: theme.textMuted, fontSize: 12 },
  error: { color: theme.error, fontSize: 12 },
});

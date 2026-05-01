import { Animated, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEffect, useRef } from 'react';
import { radius, spacing, theme } from './theme';

export type Cue = {
  id: number;
  text: string;
  createdAt: number;
  source: string;
};

type Props = {
  cues: Cue[];
  onDismiss: (id: number) => void;
  onClear: () => void;
};

export function CuePane({ cues, onDismiss, onClear }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Cues</Text>
        <Pressable onPress={onClear} hitSlop={8}>
          <Text style={styles.clear}>clear</Text>
        </Pressable>
      </View>

      <FlatList
        data={cues}
        keyExtractor={(c) => String(c.id)}
        renderItem={({ item }) => <CueCard cue={item} onDismiss={onDismiss} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No cues yet. The orchestrator will surface helpful context as the conversation unfolds.
            </Text>
          </View>
        }
      />
    </View>
  );
}

function CueCard({ cue, onDismiss }: { cue: Cue; onDismiss: (id: number) => void }) {
  const fade = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(lift, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
  }, [fade, lift]);

  return (
    <Animated.View style={[styles.card, { opacity: fade, transform: [{ translateY: lift }] }]}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTime}>{formatTime(cue.createdAt)}</Text>
        <Pressable onPress={() => onDismiss(cue.id)} hitSlop={10}>
          <Text style={styles.cardDismiss}>dismiss</Text>
        </Pressable>
      </View>
      <Text style={styles.cardBody}>{cue.text}</Text>
      <Text style={styles.cardSource} numberOfLines={1}>
        ↳ {cue.source}
      </Text>
    </Animated.View>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 5);
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
  title: { color: theme.text, fontSize: 18, fontWeight: '600', letterSpacing: 0.4 },
  clear: { color: theme.textMuted, fontSize: 12, letterSpacing: 0.5 },
  listContent: { gap: spacing.md, paddingBottom: spacing.lg },
  card: {
    backgroundColor: theme.accentSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: theme.accent,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  cardTime: { color: theme.accent, fontSize: 11, letterSpacing: 1, fontWeight: '700' },
  cardDismiss: { color: theme.accent, fontSize: 11, letterSpacing: 1 },
  cardBody: { color: theme.text, fontSize: 16, lineHeight: 22 },
  cardSource: {
    color: theme.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: spacing.sm,
  },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { color: theme.textMuted, textAlign: 'center', fontSize: 14, lineHeight: 20 },
});

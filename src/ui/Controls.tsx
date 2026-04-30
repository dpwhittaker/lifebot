import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, theme } from './theme';

type Props = {
  active: boolean;
  geminiConfigured: boolean;
  pendingCues: number;
  onToggle: () => void;
};

export function Controls({ active, geminiConfigured, pendingCues, onToggle }: Props) {
  return (
    <View style={styles.bar}>
      <View style={styles.brand}>
        <Text style={styles.brandText}>LifeBot</Text>
        <Text style={styles.brandSub}>passive session monitor</Text>
      </View>

      <View style={styles.center}>
        {!geminiConfigured && (
          <Text style={styles.warn}>
            ⚠ EXPO_PUBLIC_GEMINI_API_KEY not set — cues disabled
          </Text>
        )}
        {pendingCues > 0 && (
          <Text style={styles.pending}>
            {pendingCues} request{pendingCues === 1 ? '' : 's'} in flight…
          </Text>
        )}
      </View>

      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [
          styles.button,
          active && styles.buttonActive,
          pressed && { opacity: 0.7 },
        ]}
      >
        <Text style={[styles.buttonText, active && styles.buttonTextActive]}>
          {active ? 'Stop Listening' : 'Start Listening'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  brand: { gap: 2 },
  brandText: { color: theme.text, fontSize: 22, fontWeight: '700', letterSpacing: 0.6 },
  brandSub: { color: theme.textMuted, fontSize: 11, letterSpacing: 1 },
  center: { flex: 1, alignItems: 'center', gap: 2 },
  warn: { color: theme.warn, fontSize: 12 },
  pending: { color: theme.textMuted, fontSize: 11 },
  button: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.accent,
    backgroundColor: 'transparent',
  },
  buttonActive: { backgroundColor: theme.error, borderColor: theme.error },
  buttonText: { color: theme.accent, fontWeight: '700', letterSpacing: 0.5 },
  buttonTextActive: { color: theme.text },
});

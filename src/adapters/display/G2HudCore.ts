/**
 * Rendering logic for the G2 HUD — frame layout, debounce, fade. Sink-agnostic.
 *
 * Two consumers:
 *   - G2HudPreview (DOM div in the PWA)  → onFrame writes to React state
 *   - G2HudRenderer (Phase 3-real)       → onFrame calls bridge.textContainerUpgrade
 *
 * Constraints we're modelling:
 *   - ≥120 ms between writes (BLE queue saturates faster — Even's ASR template
 *     uses this same number).
 *   - Auto-clear after `fadeMs` of no new cue (HUD dark by default).
 *   - 2 lines × ~25 chars per line, hard truncate with "…".
 */

export type HudFrame = { lines: string[] } | null;

export type G2HudCoreOpts = {
  onFrame: (frame: HudFrame) => void;
  /** Min ms between writes to the sink. */
  debounceMs?: number;
  /** Auto-clear after this many ms of no new cue. */
  fadeMs?: number;
  /** Max characters per line at the firmware font size. */
  maxCharsPerLine?: number;
  /** Max lines per frame. */
  maxLines?: number;
};

export class G2HudCore {
  private readonly opts: G2HudCoreOpts;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: HudFrame = null;
  private lastWriteAt = 0;
  private current: HudFrame = null;

  constructor(opts: G2HudCoreOpts) {
    this.opts = opts;
  }

  showText(text: string): void {
    const frame: HudFrame = { lines: layoutHudFrame(text, this.maxCharsPerLine, this.maxLines) };
    this.schedule(frame);
  }

  clear(): void {
    this.schedule(null);
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    this.debounceTimer = null;
    this.fadeTimer = null;
  }

  /** Currently-displayed frame (for inspecting in the preview). */
  get currentFrame(): HudFrame {
    return this.current;
  }

  private get debounceMs(): number {
    return this.opts.debounceMs ?? 120;
  }
  private get fadeMs(): number {
    return this.opts.fadeMs ?? 7000;
  }
  private get maxCharsPerLine(): number {
    return this.opts.maxCharsPerLine ?? 25;
  }
  private get maxLines(): number {
    return this.opts.maxLines ?? 2;
  }

  private schedule(frame: HudFrame): void {
    this.pending = frame;
    const elapsed = Date.now() - this.lastWriteAt;
    if (elapsed >= this.debounceMs) {
      this.flush();
    } else {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs - elapsed);
    }
  }

  private flush(): void {
    this.debounceTimer = null;
    this.lastWriteAt = Date.now();
    this.current = this.pending;
    this.opts.onFrame(this.current);
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    if (this.current !== null) {
      this.fadeTimer = setTimeout(() => {
        this.current = null;
        this.fadeTimer = null;
        this.opts.onFrame(null);
      }, this.fadeMs);
    }
  }
}

/**
 * Word-wrap to N lines × M chars. Hard-truncates the last line with "…" if
 * input doesn't fit. Single oversized words are broken at the line boundary.
 */
export function layoutHudFrame(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let line = words[i++];
    if (line.length > maxCharsPerLine) {
      // Single word longer than a line — break it.
      lines.push(line.slice(0, maxCharsPerLine));
      words.splice(i, 0, line.slice(maxCharsPerLine));
      continue;
    }
    while (i < words.length && line.length + 1 + words[i].length <= maxCharsPerLine) {
      line += ' ' + words[i++];
    }
    lines.push(line);
  }
  if (i < words.length && lines.length > 0) {
    const last = lines[lines.length - 1];
    const room = maxCharsPerLine - last.length;
    lines[lines.length - 1] =
      room >= 1 ? last + '…' : last.slice(0, maxCharsPerLine - 1) + '…';
  }
  return lines;
}

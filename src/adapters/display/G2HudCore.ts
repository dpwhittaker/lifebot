/**
 * Composer for the G2 HUD's two-pane layout.
 *
 * 576 × 288 screen, ~10 rows of text at the firmware default line-height (per
 * Even's design guidelines). Split 50/50 vertically:
 *
 *   ┌──────────────────┬──────────────────┐
 *   │ transcript pane  │ cue list pane    │
 *   │ (text container) │ (list container) │
 *   └──────────────────┴──────────────────┘
 *        288 px              288 px
 *
 * Sink-agnostic — `onFrame` carries both panes' current content. Two
 * consumers:
 *   - G2HudPreview (DOM-mocked side-by-side in the PWA)
 *   - G2HudRenderer (real bridge: TextContainerUpgrade + RebuildPageContainer)
 *
 * No fade. Transcript scrolls naturally; cue items persist until newer ones
 * push them off. The screen blanking is handled by the glasses firmware
 * itself, not by this layer.
 */

export type HudFrame = {
  transcript: string;
  cues: string[];
};

export type G2HudCoreOpts = {
  onFrame: (frame: HudFrame) => void;
  /** Min ms between writes to the sink. Default 120 ms (matches Even's ASR
   *  template). The BLE queue saturates faster than that. */
  debounceMs?: number;
};

export class G2HudCore {
  private readonly opts: G2HudCoreOpts;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private transcript = '';
  private cues: string[] = [];
  private dirty = false;
  private lastWriteAt = 0;

  constructor(opts: G2HudCoreOpts) {
    this.opts = opts;
  }

  setTranscript(text: string): void {
    if (text === this.transcript) return;
    this.transcript = text;
    this.dirty = true;
    this.schedule();
  }

  setCues(items: string[]): void {
    if (arraysEqual(items, this.cues)) return;
    this.cues = items.slice();
    this.dirty = true;
    this.schedule();
  }

  /** Currently-committed frame (last value passed to onFrame). */
  get currentFrame(): HudFrame {
    return { transcript: this.transcript, cues: this.cues.slice() };
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private get debounceMs(): number {
    return this.opts.debounceMs ?? 120;
  }

  private schedule(): void {
    if (!this.dirty) return;
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
    this.dirty = false;
    this.opts.onFrame({ transcript: this.transcript, cues: this.cues.slice() });
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

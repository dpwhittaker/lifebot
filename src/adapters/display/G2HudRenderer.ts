import {
  CreateStartUpPageContainer,
  EvenAppBridge,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { getTextWidth } from '@evenrealities/pretext';

const SCREEN_W = 576;
const SCREEN_H = 288;
const LINE_H = 27;

// ─── Layout ────────────────────────────────────────────────────────────
// Top/bottom stacked panes, full screen width. Transcript on top, cues on
// bottom. The "active" pane gets 7 visible lines; the other gets 2. With
// the per-state inset of 5 px on every side (border + padding always sum
// to 5 — see PaneStyle below), each pane's outer height is
//   lines * 27 + 10
// so the active pane is 199 px tall and the inactive is 64 px tall —
// total 263 px, leaving a 25-px gap which floats between the panes.
const PANE_X = 0;
const PANE_W = SCREEN_W;
const ACTIVE_LINES = 7;
const INACTIVE_LINES = 3;
// border + padding per side, constant across visual states so text never
// shifts horizontally / vertically as selection changes. The SDK has only
// `paddingLength` (single number on all four sides) and `borderWidth`
// (same), so vertical and horizontal insets are necessarily equal.
const PANE_STATE_INSET = 4;
const ACTIVE_PANE_H = ACTIVE_LINES * LINE_H + 2 * PANE_STATE_INSET; // 197
const INACTIVE_PANE_H = INACTIVE_LINES * LINE_H + 2 * PANE_STATE_INSET; // 89
const INNER_W = PANE_W - 2 * PANE_STATE_INSET; // 568

// ─── Container IDs ─────────────────────────────────────────────────────
// Container 1 is a fullscreen, transparent event-capture layer; the
// firmware natively finger-scrolls whichever container has
// isEventCapture=1, so isolating event capture onto a throwaway layer
// keeps the visible transcript/cues panes from finger-scrolling out from
// under us. The layer carries a screenful-plus of blank lines so it
// overflows and the firmware reliably reports SCROLL_TOP / SCROLL_BOTTOM
// on swipe, while nothing the user can see actually moves during the drag.
const EVENT_CONTAINER_ID = 1;
const EVENT_CONTAINER_NAME = 'eventLayer';
const TRANSCRIPT_CONTAINER_ID = 2;
const TRANSCRIPT_CONTAINER_NAME = 'body';
const CUES_CONTAINER_ID = 3;
const CUES_CONTAINER_NAME = 'pager';
// Tiny overlay container pinned to the top-right corner showing the current
// time in Unicode superscript (e.g. ¹¹⁻¹⁵). Superscript glyphs are small and
// ride high, so they sit over the top pane's border without colliding with
// body text. Overlaps the top pane on purpose.
const CLOCK_CONTAINER_ID = 4;
const CLOCK_CONTAINER_NAME = 'clock';
const CLOCK_W = 72;
const CLOCK_H = LINE_H;
// Single-space content: enough to satisfy create-page validation (which
// rejected truly empty content in earlier probing), but small enough that
// the container never overflows. A non-overflowing text container shows
// no scrollbar AND the firmware can't eat the swipe into a native-scroll
// gesture — so SCROLL_TOP / SCROLL_BOTTOM events fire on the first swipe
// instead of after the user drags the scrollbar all the way to its end.
const EVENT_FILLER = ' ';

// ─── Pane visual states ────────────────────────────────────────────────
// `border` and `padding` always sum to PANE_STATE_INSET = 5, so the inner
// content area (and therefore wrapping width and line count) is identical
// across states — only the visible border thickness changes. Inactive
// pane shows no border; the selected pane shows a thin border; the active
// pane shows a thick border. Per-state b/p chosen by the user:
//
//   unselected (b=0, p=5) — no border, content sits at inset 5
//   selected   (b=1, p=4) — 1-px border, content stays at inset 5
//   active     (b=3, p=2) — 3-px border, content stays at inset 5
type PaneStyle = { border: number; padding: number };
// border + padding always == PANE_STATE_INSET so text doesn't shift as
// selection state changes. Reduced from b+p=5 to b+p=4 to recover a 10th
// visible line on the 288-px screen.
const PANE_STYLE_UNSELECTED: PaneStyle = { border: 0, padding: 4 };
const PANE_STYLE_SELECTED: PaneStyle = { border: 1, padding: 3 };
const PANE_STYLE_ACTIVE: PaneStyle = { border: 3, padding: 1 };
const BORDER_COLOR = 5;

// One line moved per SCROLL_TOP / SCROLL_BOTTOM gesture. Each step is a
// full content replace; a larger step looks like a page jump.
const SCROLL_STEP = 1;
const DEBOUNCE_MS = 120;

type Mode = 'select' | 'active';
type CurrentPane = 'transcript' | 'cues';
type PageKind = 'listening' | 'menu';

/** A simple list menu shown on the glasses. Native list scroll + select
 *  is handled by the firmware; `onSelect` fires on single press of an
 *  item, `onCancel` on double press (returns to whatever invoked the
 *  menu). Items are plain strings — the firmware truncates to fit. */
export type MenuSpec = {
  items: string[];
  /** Item to highlight initially. Defaults to 0. */
  initialSelectedIndex?: number;
  onSelect: (index: number, name: string) => void;
  onCancel?: () => void;
};

/** Per-pane scroll model. `stuck` = auto-tail (window pinned to the newest
 *  N lines for whatever line budget the pane has now). When the user
 *  scrolls up, `stuck` flips false and `topLine` pins the window to an
 *  absolute line index, so newly appended content stacks below without
 *  yanking the view back to the bottom. */
type PaneState = {
  fullText: string;
  stuck: boolean;
  topLine: number;
};

/**
 * Stacked HUD renderer.
 *
 * Two visible text panes (transcript on top, cues on bottom) plus a
 * fullscreen event-capture layer. The renderer owns the focus/scroll
 * model — App.tsx just forwards raw gestures (`onUp`/`onDown`/`onClick`/
 * `onDoubleClick`) and pushes content (`setTranscript`/`setCues`).
 *
 * Two modes:
 *   - `select` — one pane is "selected" (thin border), the other
 *     "unselected" (no border). Up/down moves the selection; click on the
 *     selected pane enters `active`.
 *   - `active` — the active pane gets a thick border; up/down scrolls its
 *     history; double-click returns to `select`.
 *
 * Whichever pane is current (selected or active) gets 7 lines of height;
 * the other gets 2 — so swapping `current` rebuilds the page geometry.
 * Mode changes also rebuild (border thickness lives on the container
 * geometry, not the upgrade). Content changes are the only thing that go
 * through the in-place `textContainerUpgrade` path.
 *
 * Safe to instantiate without a bridge present; `init()` resolves to false
 * and every update is a no-op.
 */
export class G2HudRenderer {
  private bridge: EvenAppBridge | null = null;
  private ready = false;
  private destroyed = false;
  private pageKind: PageKind = 'listening';
  private menuSpec: MenuSpec | null = null;
  private menuSelectedIndex = 0;
  private mode: Mode = 'select';
  // Default focus is the cues pane — cues are the actionable content of a
  // listening session, so the user lands on the pane they're most likely
  // to want to interact with. Transcript is reference; cues are the point.
  private current: CurrentPane = 'cues';
  private readonly transcript: PaneState = { fullText: '', stuck: true, topLine: 0 };
  private readonly cues: PaneState = { fullText: '', stuck: true, topLine: 0 };
  /** Last content string actually pushed per container — skip the BLE
   *  write when a re-render produces identical bytes. */
  private readonly lastSent = new Map<number, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current superscript clock string and its per-minute update timer. */
  private clockText = superscriptTime();
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  /** Optional callback so callers can surface init-result diagnostics. */
  onDiag?: (msg: string) => void;

  async init(timeoutMs = 1500): Promise<boolean> {
    const bridge = await raceWithTimeout(waitForEvenAppBridge(), timeoutMs);
    if (!bridge) return false;
    this.bridge = bridge;
    try {
      // On first init both panes are empty — currentPaneContents produces
      // blank-padded strings of the right line counts.
      const [transcriptContent, cuesContent] = this.currentPaneContents();
      const textObject = this.buildPageTextObject(transcriptContent, cuesContent);
      // createStartUpPageContainer is one-shot per app session. On HMR /
      // re-mount the second call returns `invalid` and our new layout
      // would never reach the firmware — fall back to rebuildPageContainer
      // so the dev loop produces the layout currently in source.
      const result = await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: 4, textObject }),
      );
      this.onDiag?.(`createStartUpPageContainer → ${result}`);
      if (result !== StartUpPageCreateResult.success) {
        const rebuilt = await bridge.rebuildPageContainer(
          new RebuildPageContainer({ containerTotalNum: 4, textObject }),
        );
        this.onDiag?.(`rebuildPageContainer → ${rebuilt}`);
      }
      // Mark ready even when create/rebuild fail: the host appears to keep
      // a prior session's page latched across WebView reloads, and our
      // textContainerUpgrade calls land on its containers as long as we
      // use the same containerID / containerName ('body' / 'pager').
      this.ready = true;
      this.lastSent.set(CLOCK_CONTAINER_ID, this.clockText);
      // Push initial content so the panes show our placeholders rather
      // than the literal 'body' / 'pager' strings from the create payload.
      this.schedule();
      this.startClock();
      return true;
    } catch (e) {
      console.error('[G2HudRenderer] init error', e);
      this.onDiag?.(`init threw: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  // ─── Content ─────────────────────────────────────────────────────────

  setTranscript(text: string): void {
    if (!this.ready) return;
    if (text === this.transcript.fullText) return;
    // Empty text == session reset: snap back to auto-tail so the first
    // message of the new session is visible.
    if (text === '') {
      this.transcript.stuck = true;
      this.transcript.topLine = 0;
    }
    this.transcript.fullText = text;
    this.schedule();
  }

  setCues(items: string[]): void {
    if (!this.ready) return;
    const joined = items.join('\n');
    if (joined === this.cues.fullText) return;
    if (joined === '') {
      this.cues.stuck = true;
      this.cues.topLine = 0;
    }
    this.cues.fullText = joined;
    this.schedule();
  }

  // ─── Gesture handlers ────────────────────────────────────────────────
  // App.tsx forwards raw events; the renderer decides what each gesture
  // means based on `mode`. `onDoubleClick` returns `true` when consumed
  // (exited active mode) so the app knows it shouldn't fall through to an
  // exit/back action.

  onUp(): void {
    if (!this.ready) return;
    if (this.pageKind === 'menu') {
      this.moveMenuSelection(-1);
      return;
    }
    if (this.mode === 'select') {
      // Swipe up while the top pane is already selected commits to focusing
      // it for scrolling; otherwise it just moves the selection up.
      if (this.current === 'transcript') this.setMode('active');
      else this.selectPane('transcript');
    } else this.scrollCurrent(-1);
  }

  onDown(): void {
    if (!this.ready) return;
    if (this.pageKind === 'menu') {
      this.moveMenuSelection(1);
      return;
    }
    if (this.mode === 'select') {
      // Mirror of onUp: swipe down on the already-selected bottom pane focuses
      // it for scrolling.
      if (this.current === 'cues') this.setMode('active');
      else this.selectPane('cues');
    } else this.scrollCurrent(1);
  }

  /** Returns true if the click was consumed (a menu selection). False in the
   *  listening view — the app treats that as a "send now" tap, since entering
   *  scroll/active mode is now a swipe-past-boundary gesture. */
  onClick(): boolean {
    if (!this.ready) return false;
    if (this.pageKind === 'menu') {
      const spec = this.menuSpec;
      if (!spec) return false;
      const idx = clamp(this.menuSelectedIndex, 0, spec.items.length - 1);
      spec.onSelect(idx, spec.items[idx] ?? '');
      return true;
    }
    return false;
  }

  /** Returns true if the double-click was consumed (was in active mode and
   *  returned to select, or cancelled a menu). False means the app should
   *  fall through — typically to "show in-session menu" or "exit app",
   *  depending on the current page. */
  onDoubleClick(): boolean {
    if (!this.ready) return false;
    if (this.pageKind === 'menu') {
      const cb = this.menuSpec?.onCancel;
      if (cb) {
        cb();
        return true;
      }
      return false;
    }
    if (this.mode === 'active') {
      this.setMode('select');
      return true;
    }
    return false;
  }

  // ─── Pages ───────────────────────────────────────────────────────────

  /** Switch the glasses page to the stacked listening view. Always
   *  re-enters in select mode with the transcript pane selected — modes
   *  don't carry over from a previous listening session, otherwise a
   *  user who'd activated a pane, gone to a menu, and come back would
   *  find their swipes silently scrolling the same pane instead of
   *  re-picking one. Re-renders content + geometry via rebuildPage. */
  showListening(): void {
    this.pageKind = 'listening';
    this.menuSpec = null;
    const modeChanged = this.mode !== 'select';
    const currentChanged = this.current !== 'cues';
    this.mode = 'select';
    this.current = 'cues';
    if (modeChanged || currentChanged) {
      // Geometry / border thickness depends on mode+current — push a
      // rebuild so the glasses reflect the reset state immediately
      // rather than waiting for the next content tick.
      void this.rebuildPage();
    } else {
      this.lastSent.clear();
      this.schedule();
    }
  }

  /** Switch to a menu rendered as text content in the listening view's
   *  panes. No rebuild, no list container — robust against the firmware's
   *  rebuildPageContainer rejecting list-only layouts on a latched session.
   *  Menu items show in the transcript pane (which has the bigger line
   *  budget when current=transcript); cues pane is blanked.
   *
   *  Up/down moves the `▶` selection marker; single press fires onSelect;
   *  double press fires onCancel. */
  showMenu(spec: MenuSpec): void {
    this.pageKind = 'menu';
    this.menuSpec = spec;
    this.menuSelectedIndex = clamp(
      spec.initialSelectedIndex ?? 0,
      0,
      Math.max(0, spec.items.length - 1),
    );
    // Make sure the transcript pane (where the menu lives) holds the big
    // 7-line budget. If `current` was 'cues' coming in, this requires a
    // pane swap — which goes through the same rebuild path as listening
    // mode/current changes; that one has been observed working.
    if (this.current !== 'transcript') {
      this.current = 'transcript';
      void this.rebuildPage();
    }
    this.lastSent.clear();
    this.schedule();
  }

  private moveMenuSelection(dir: number): void {
    const spec = this.menuSpec;
    if (!spec || spec.items.length === 0) return;
    this.menuSelectedIndex = clamp(
      this.menuSelectedIndex + (dir < 0 ? -1 : 1),
      0,
      spec.items.length - 1,
    );
    this.schedule();
  }

  /** Current page kind — App.tsx reads this to decide whether an
   *  unconsumed double-click means "show in-session menu" (listening
   *  page) or "exit app" (entrypoint menu). */
  get currentPage(): PageKind {
    return this.pageKind;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.stopClock();
    this.ready = false;
  }

  // ─── Internal: state transitions ─────────────────────────────────────

  private selectPane(pane: CurrentPane): void {
    if (this.current === pane) return;
    this.current = pane;
    void this.rebuildPage();
  }

  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    void this.rebuildPage();
  }

  private scrollCurrent(dir: number): void {
    const pane = this.current === 'transcript' ? this.transcript : this.cues;
    this.scroll(pane, dir);
  }

  private scroll(pane: PaneState, dir: number): void {
    if (dir === 0) return;
    const lineBudget = this.lineBudgetFor(pane);
    const total = wrapToLines(pane.fullText, INNER_W).length;
    const maxTop = Math.max(0, total - lineBudget);
    if (maxTop === 0) return;
    const step = dir < 0 ? -SCROLL_STEP : SCROLL_STEP;
    if (pane.stuck) {
      if (dir > 0) return; // already tailing
      pane.stuck = false;
      pane.topLine = Math.max(0, maxTop + step);
    } else {
      pane.topLine = clamp(pane.topLine + step, 0, maxTop);
      if (pane.topLine >= maxTop) pane.stuck = true;
    }
    this.schedule();
  }

  /** How many visible lines the pane gets right now — depends on whether
   *  it's the current pane. */
  private lineBudgetFor(pane: PaneState): number {
    const isCurrent =
      (pane === this.transcript && this.current === 'transcript') ||
      (pane === this.cues && this.current === 'cues');
    return isCurrent ? ACTIVE_LINES : INACTIVE_LINES;
  }

  // ─── Internal: page rebuild + content push ───────────────────────────

  /** Rebuild the whole page geometry — needed whenever the line budget
   *  changes (current pane swap) or a pane's border thickness changes
   *  (mode swap). Per-container borderWidth/paddingLength live on the
   *  geometry payload, not on textContainerUpgrade, so a mode change
   *  cannot be done in place. Also used to swap between the listening
   *  view and a menu view (different container kinds entirely). */
  private async rebuildPage(): Promise<void> {
    if (!this.bridge || this.destroyed) return;
    // Compute the content the panes should show right now, ship it inside
    // the geometry payload so the rebuild itself paints the real content
    // (no flash to placeholder strings), then seed lastSent so the next
    // flush dedups against what's already on screen.
    const [transcriptContent, cuesContent] = this.currentPaneContents();
    const payload = new RebuildPageContainer({
      containerTotalNum: 4,
      textObject: this.buildPageTextObject(transcriptContent, cuesContent),
    });
    try {
      const result = await this.bridge.rebuildPageContainer(payload);
      this.onDiag?.(
        `rebuildPageContainer page=${this.pageKind} mode=${this.mode} current=${this.current} → ${result}`,
      );
    } catch (e) {
      this.onDiag?.(`rebuild threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.lastSent.set(TRANSCRIPT_CONTAINER_ID, transcriptContent);
    this.lastSent.set(CUES_CONTAINER_ID, cuesContent);
    this.lastSent.set(CLOCK_CONTAINER_ID, this.clockText);
  }

  // ─── Clock ───────────────────────────────────────────────────────────

  /** Start the per-minute clock tick. Aligns the first tick to the next
   *  minute boundary so the displayed time flips when the wall clock does. */
  startClock(): void {
    if (this.clockTimer || this.destroyed) return;
    this.updateClock();
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    this.clockTimer = setTimeout(() => {
      this.clockTimer = null;
      this.updateClock();
      // Re-arm on a steady 60s cadence now that we're minute-aligned.
      this.clockTimer = setInterval(() => this.updateClock(), 60_000);
    }, msToNextMinute);
  }

  /** Stop the clock tick (e.g. while backgrounded). */
  stopClock(): void {
    if (this.clockTimer) {
      clearTimeout(this.clockTimer);
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  /** Recompute the time string and push it to the clock container if changed. */
  private updateClock(): void {
    const next = superscriptTime();
    if (next === this.clockText) return;
    this.clockText = next;
    if (!this.ready) return;
    this.upgradeIfChanged(CLOCK_CONTAINER_ID, CLOCK_CONTAINER_NAME, next);
  }

  /** Layout: top pane y=0, bottom pane flush to screen bottom. The
   *  current pane is `ACTIVE_LINES` tall; the other is `INACTIVE_LINES`.
   *  Content is computed the *same* way as `renderPane` so a rebuild
   *  paints the correct content immediately — no flash to placeholder
   *  strings before the follow-up textContainerUpgrade lands. */
  private buildPageTextObject(
    transcriptContent: string,
    cuesContent: string,
  ): TextContainerProperty[] {
    const topIsActive = this.current === 'transcript';
    const topH = topIsActive ? ACTIVE_PANE_H : INACTIVE_PANE_H;
    const bottomH = topIsActive ? INACTIVE_PANE_H : ACTIVE_PANE_H;
    const bottomY = SCREEN_H - bottomH;
    const topStyle = this.styleFor('transcript');
    const bottomStyle = this.styleFor('cues');
    return [
      buildEventLayer(),
      buildPane({
        id: TRANSCRIPT_CONTAINER_ID,
        name: TRANSCRIPT_CONTAINER_NAME,
        y: 0,
        h: topH,
        style: topStyle,
        content: transcriptContent,
      }),
      buildPane({
        id: CUES_CONTAINER_ID,
        name: CUES_CONTAINER_NAME,
        y: bottomY,
        h: bottomH,
        style: bottomStyle,
        content: cuesContent,
      }),
      buildClock(this.clockText),
    ];
  }

  /** Compute the (transcript, cues) content strings the panes should show
   *  right now. In `menu` page kind, the transcript pane carries the menu
   *  items and the cues pane is blank; in `listening` page kind, both
   *  panes render their bottom-anchored windowed text. Used by both
   *  rebuildPage (geometry payload) and the in-place upgrade path. */
  private currentPaneContents(): [string, string] {
    if (this.pageKind === 'menu') {
      return [this.menuContent(), '\n'.repeat(INACTIVE_LINES)];
    }
    return [this.contentFor(this.transcript), this.contentFor(this.cues)];
  }

  /** Bottom-anchored windowed text for a pane, padded so the newest line
   *  sits on the bottom row. Also normalises pane.stuck / pane.topLine in
   *  case scroll state needs clamping (e.g. line budget changed after a
   *  pane swap). */
  private contentFor(pane: PaneState): string {
    const lineBudget = this.lineBudgetFor(pane);
    const lines = wrapToLines(pane.fullText, INNER_W);
    const total = lines.length;
    const maxTop = Math.max(0, total - lineBudget);
    let top: number;
    if (pane.stuck || maxTop === 0) {
      top = maxTop;
      pane.stuck = true;
      pane.topLine = top;
    } else {
      top = clamp(pane.topLine, 0, maxTop);
      pane.topLine = top;
    }
    const win = lines.slice(top, top + lineBudget);
    const pad = lineBudget - win.length;
    return (pad > 0 ? '\n'.repeat(pad) : '') + win.join('\n');
  }

  private menuContent(): string {
    const spec = this.menuSpec;
    if (!spec) return '\n'.repeat(ACTIVE_LINES);
    const items = spec.items;
    const selected = clamp(this.menuSelectedIndex, 0, Math.max(0, items.length - 1));
    const lines = items.map((it, i) => (i === selected ? `▶ ${it}` : `  ${it}`));
    const pad = Math.max(0, ACTIVE_LINES - lines.length);
    return (pad > 0 ? '\n'.repeat(pad) : '') + lines.join('\n');
  }

  private styleFor(pane: CurrentPane): PaneStyle {
    const isCurrent = this.current === pane;
    if (!isCurrent) return PANE_STYLE_UNSELECTED;
    return this.mode === 'active' ? PANE_STYLE_ACTIVE : PANE_STYLE_SELECTED;
  }

  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, DEBOUNCE_MS);
  }

  private flush(): void {
    if (this.destroyed || !this.bridge) return;
    const [transcriptContent, cuesContent] = this.currentPaneContents();
    this.upgradeIfChanged(TRANSCRIPT_CONTAINER_ID, TRANSCRIPT_CONTAINER_NAME, transcriptContent);
    this.upgradeIfChanged(CUES_CONTAINER_ID, CUES_CONTAINER_NAME, cuesContent);
  }

  private upgradeIfChanged(id: number, name: string, content: string): void {
    if (this.lastSent.get(id) === content) return;
    this.lastSent.set(id, content);
    this.upgrade(id, name, content);
  }

  private upgrade(id: number, name: string, content: string): void {
    if (!this.bridge) return;
    // Always full-replace — contentOffset/contentLength behave as
    // partial-replace on this firmware, not as a viewport.
    this.bridge
      .textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content }))
      .catch((e) => {
        console.error('[G2HudRenderer] upgrade error', name, e);
        this.onDiag?.(`upgrade ${name} threw: ${e instanceof Error ? e.message : String(e)}`);
      });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Word-wrap `text` to `maxWidth` using the firmware's own glyph metrics
 *  (getTextWidth). Keeps whitespace tokens so spacing survives; hard-breaks
 *  any single token wider than the pane. Blank input lines are preserved as
 *  empty lines so paragraph breaks render. */
function wrapToLines(text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.length === 0) {
      out.push('');
      continue;
    }
    const tokens = para.split(/(\s+)/);
    let current = '';
    for (const tok of tokens) {
      const probe = current + tok;
      if (getTextWidth(probe) <= maxWidth) {
        current = probe;
        continue;
      }
      if (current) out.push(current.trimEnd());
      if (getTextWidth(tok) > maxWidth) {
        // Token alone too long — hard-break by character.
        let chunk = '';
        for (const ch of tok) {
          if (getTextWidth(chunk + ch) > maxWidth) {
            if (chunk) out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      } else {
        current = tok.trimStart();
      }
    }
    if (current) out.push(current.trimEnd());
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// Superscript digit glyphs; ⁻ stands in for the colon (there is no
// superscript colon). e.g. 11:15 → ¹¹⁻¹⁵.
const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', ':': '⁻',
};

/** Current local time as HH:MM rendered in superscript glyphs (24-hour). */
function superscriptTime(now: Date = new Date()): string {
  const hh = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`
    .split('')
    .map((c) => SUPERSCRIPT[c] ?? c)
    .join('');
}

/** Top-right overlay container carrying the superscript clock. */
function buildClock(content: string): TextContainerProperty {
  return new TextContainerProperty({
    containerID: CLOCK_CONTAINER_ID,
    containerName: CLOCK_CONTAINER_NAME,
    xPosition: SCREEN_W - CLOCK_W,
    yPosition: 0,
    width: CLOCK_W,
    height: CLOCK_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 0,
    isEventCapture: 0,
    content,
  });
}

/** Fullscreen, transparent event-capture layer. Per Even docs, EXACTLY
 *  ONE container per startup page may have isEventCapture: 1 — this is it,
 *  so the visible panes can stay non-capturing and immune to the
 *  firmware's native finger-scroll. */
function buildEventLayer(): TextContainerProperty {
  return new TextContainerProperty({
    containerID: EVENT_CONTAINER_ID,
    containerName: EVENT_CONTAINER_NAME,
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_W,
    height: SCREEN_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 0,
    isEventCapture: 1,
    content: EVENT_FILLER,
  });
}

function buildPane(args: {
  id: number;
  name: string;
  y: number;
  h: number;
  style: PaneStyle;
  content: string;
}): TextContainerProperty {
  return new TextContainerProperty({
    containerID: args.id,
    containerName: args.name,
    xPosition: PANE_X,
    yPosition: args.y,
    width: PANE_W,
    height: args.h,
    borderWidth: args.style.border,
    borderColor: BORDER_COLOR,
    paddingLength: args.style.padding,
    isEventCapture: 0,
    content: args.content,
  });
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

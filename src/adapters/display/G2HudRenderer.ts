import {
  CreateStartUpPageContainer,
  EvenAppBridge,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import { G2HudCore, type HudFrame } from './G2HudCore';

const SCREEN_H = 288;
const SPLIT_X = 288; // 50/50 vertical split (full screen is 576 px wide)

const TRANSCRIPT_CONTAINER_ID = 1;
const TRANSCRIPT_CONTAINER_NAME = 'lifebot-transcript';
const CUES_CONTAINER_ID = 2;
const CUES_CONTAINER_NAME = 'lifebot-cues';
const PADDING = 8;

/**
 * Real-bridge HUD renderer. Two **text** containers — transcript on the left,
 * a cue stack on the right with the most recent cue prefixed by `> ` to
 * signal current focus. We use text containers for both panes (rather than
 * the SDK's ListContainer) because the simulator's LVGL layer doesn't
 * reliably render list containers; on real glasses we may revisit, but text
 * containers are universally supported and `textContainerUpgrade` is the
 * fastest update path (granular, no full page rebuild).
 *
 * Init flow:
 *   1. waitForEvenAppBridge (≤1.5 s)
 *   2. createStartUpPageContainer with both containers empty
 *   3. flip `ready=true`; setTranscript / setCues drive separate
 *      `textContainerUpgrade` calls.
 *
 * Safe to instantiate without a bridge present; `init()` resolves to false
 * and every update is a no-op.
 */
export class G2HudRenderer {
  private core: G2HudCore | null = null;
  private bridge: EvenAppBridge | null = null;
  private ready = false;

  async init(timeoutMs = 1500): Promise<boolean> {
    const bridge = await raceWithTimeout(waitForEvenAppBridge(), timeoutMs);
    if (!bridge) return false;
    this.bridge = bridge;
    try {
      const textObject = [
        buildContainer(TRANSCRIPT_CONTAINER_ID, TRANSCRIPT_CONTAINER_NAME, 0, ''),
        buildContainer(CUES_CONTAINER_ID, CUES_CONTAINER_NAME, SPLIT_X, ''),
      ];
      // createStartUpPageContainer is one-shot per app session. On HMR /
      // re-mount the second call returns `invalid` and our new layout would
      // never reach the firmware — fall back to rebuildPageContainer so the
      // dev loop produces the layout currently in source.
      const result = await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: 2, textObject }),
      );
      if (result !== StartUpPageCreateResult.success) {
        await bridge.rebuildPageContainer(
          new RebuildPageContainer({ containerTotalNum: 2, textObject }),
        );
      }
      this.core = new G2HudCore({ onFrame: (frame) => this.writeFrame(frame) });
      this.ready = true;
      return true;
    } catch (e) {
      console.error('[G2HudRenderer] init error', e);
      return false;
    }
  }

  setTranscript(text: string): void {
    if (!this.ready || !this.core) return;
    this.core.setTranscript(text);
  }

  setCues(items: string[]): void {
    if (!this.ready || !this.core) return;
    this.core.setCues(items);
  }

  destroy(): void {
    this.core?.destroy();
    this.core = null;
    this.ready = false;
  }

  private writeFrame(frame: HudFrame): void {
    if (!this.bridge) return;
    this.upgrade(TRANSCRIPT_CONTAINER_ID, TRANSCRIPT_CONTAINER_NAME, frame.transcript);
    this.upgrade(CUES_CONTAINER_ID, CUES_CONTAINER_NAME, cuesToText(frame.cues));
  }

  private upgrade(id: number, name: string, content: string): void {
    if (!this.bridge) return;
    console.log('[G2HudRenderer] upgrade', { id, name, len: content.length, preview: content.slice(0, 60) });
    this.bridge
      .textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: id,
          containerName: name,
          contentOffset: 0,
          contentLength: content.length,
          content,
        }),
      )
      .then((res) => console.log('[G2HudRenderer] upgrade ok', name, res))
      .catch((e) => console.error('[G2HudRenderer] upgrade error', name, e));
  }
}

/** TextContainerProperty factory for one of the two panes. */
function buildContainer(
  id: number,
  name: string,
  xPosition: number,
  content: string,
): TextContainerProperty {
  return new TextContainerProperty({
    containerID: id,
    containerName: name,
    xPosition,
    yPosition: 0,
    width: SPLIT_X,
    height: SCREEN_H,
    paddingLength: PADDING,
    isEventCapture: 0,
    content,
  });
}

/**
 * Serialise the cue list to a single string for the text container. App.tsx
 * stores items newest-first; the HUD reads top-to-bottom, so reverse here.
 * The newest cue (now the last line) gets a `> ` focus marker; older cues
 * get a 2-space indent so columns align. Items separated by a blank line —
 * the firmware handles word-wrap inside each paragraph.
 */
function cuesToText(items: string[]): string {
  if (items.length === 0) return '';
  const reversed = items.slice().reverse();
  const lastIndex = reversed.length - 1;
  return reversed
    .map((line, i) => (i === lastIndex ? `> ${line}` : `  ${line}`))
    .join('\n\n');
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

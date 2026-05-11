import {
  CreateStartUpPageContainer,
  EvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import { G2HudCore, type HudFrame } from './G2HudCore';

const CONTAINER_ID = 1;
const CONTAINER_NAME = 'lifebot-cue';
const SCREEN_W = 576;
const SCREEN_H = 288;

/**
 * Real-bridge HUD renderer. `G2HudCore` does the layout/debounce/fade work;
 * this class just owns the bridge handshake and translates `onFrame(frame)`
 * into `bridge.textContainerUpgrade(...)`.
 *
 * Same `G2HudCore` instance lives behind `G2HudPreview` (DOM sink) — the only
 * difference is where frames go.
 *
 * Safe to instantiate when no bridge is present; init() will resolve to a
 * no-op in plain browsers (the SDK's `waitForEvenAppBridge` resolves only
 * when the bridge actually shows up, so we time-bound it).
 */
export class G2HudRenderer {
  private core: G2HudCore | null = null;
  private bridge: EvenAppBridge | null = null;
  private ready = false;

  /** Resolves true when the bridge is available and the container is created. */
  async init(timeoutMs = 1500): Promise<boolean> {
    const bridge = await raceWithTimeout(waitForEvenAppBridge(), timeoutMs);
    if (!bridge) return false;
    this.bridge = bridge;
    try {
      const container = new TextContainerProperty({
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        xPosition: 0,
        yPosition: 0,
        width: SCREEN_W,
        height: SCREEN_H,
        paddingLength: 16,
        isEventCapture: 1,
        content: '',
      });
      await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: 1,
          textObject: [container],
        }),
      );
      this.core = new G2HudCore({ onFrame: (frame) => this.writeFrame(frame) });
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  showCue(cueShort: string | null): void {
    if (!this.ready || !this.core) return;
    if (cueShort) this.core.showText(cueShort);
    else this.core.clear();
  }

  destroy(): void {
    this.core?.destroy();
    this.core = null;
    this.ready = false;
  }

  private writeFrame(frame: HudFrame): void {
    if (!this.bridge) return;
    const content = frame ? frame.lines.join('\n') : '';
    void this.bridge
      .textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          containerName: CONTAINER_NAME,
          contentOffset: 0,
          contentLength: content.length,
          content,
        }),
      )
      .catch(() => {
        // Bridge errors are logged-but-not-fatal — the next cue will retry.
      });
  }
}

/** Resolve to the original promise's value, or null if it doesn't settle in time. */
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

import { useEffect, useRef, useState } from 'react';

import { G2HudCore, type HudFrame } from './G2HudCore';
import type { Cue } from './DomCueRenderer';

type Props = {
  cues: Cue[];
};

/**
 * Bottom-right pane: shows what the G2 HUD would render right now.
 *
 * Two modes, picked at runtime by reachability:
 *   - **simulator mode** — when the evenhub-simulator's automation API is up
 *     (`/sim-api/api/ping`), embed the live LVGL framebuffer as an `<img>`
 *     polling `/api/screenshot/glasses`. Ground-truth: the actual LVGL
 *     renderer's pixels.
 *   - **DOM mode** — fallback for plain-browser dev. Hand-rolled simulation
 *     using `G2HudCore` for layout/debounce/fade. Less faithful, but works
 *     offline and gives instant feedback while iterating cue prompts.
 *
 * Mode is re-checked every 5 s so flipping the simulator on/off live works
 * without a page reload.
 */
const FONT_SIZE_PRESETS = [16, 20, 24, 28, 32] as const;
const DEFAULT_FONT_SIZE = 24;
const SIM_PING_INTERVAL_MS = 5000;
const SIM_SCREENSHOT_INTERVAL_MS = 500;

export function G2HudPreview({ cues }: Props) {
  const [frame, setFrame] = useState<HudFrame>(null);
  const [fontSize, setFontSize] = useState<number>(DEFAULT_FONT_SIZE);
  const [simAvailable, setSimAvailable] = useState<boolean>(false);
  const [screenshotTick, setScreenshotTick] = useState<number>(0);
  const coreRef = useRef<G2HudCore | null>(null);
  const lastCueIdRef = useRef<number | null>(null);

  // DOM-mode renderer logic. Runs unconditionally so when the simulator is
  // *not* reachable, the panel still shows our local prediction.
  useEffect(() => {
    const core = new G2HudCore({ onFrame: setFrame });
    coreRef.current = core;
    return () => {
      core.destroy();
      coreRef.current = null;
    };
  }, []);

  useEffect(() => {
    const head = cues[0];
    if (!head) return;
    if (lastCueIdRef.current === head.id) return;
    lastCueIdRef.current = head.id;
    if (head.short) coreRef.current?.showText(head.short);
  }, [cues]);

  // Detect simulator. Polls /sim-api/api/ping and toggles mode based on result.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/sim-api/api/ping', { method: 'GET' });
        if (!cancelled) setSimAvailable(res.ok);
      } catch {
        if (!cancelled) setSimAvailable(false);
      }
    };
    void check();
    const id = setInterval(() => void check(), SIM_PING_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // When sim is up, refresh the screenshot src on a tick so the <img> reloads.
  useEffect(() => {
    if (!simAvailable) return;
    const id = setInterval(() => setScreenshotTick((n) => n + 1), SIM_SCREENSHOT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [simAvailable]);

  return (
    <div className="pane">
      <div className="pane-header">
        <div className="pane-title">G2 HUD preview</div>
        <div className="g2-controls">
          <span className={`g2-mode-tag ${simAvailable ? 'g2-mode-live' : 'g2-mode-dom'}`}>
            {simAvailable ? '● live (sim)' : '○ DOM mock'}
          </span>
          {!simAvailable && (
            <label className="g2-meta-tag">
              font
              <select
                className="g2-font-select"
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
              >
                {FONT_SIZE_PRESETS.map((s) => (
                  <option key={s} value={s}>
                    {s}px
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="g2-meta-tag">576×288</span>
        </div>
      </div>
      <div className="pane-body g2-hud-wrap">
        <div className="g2-hud-frame" aria-label="G2 HUD simulation">
          {simAvailable ? (
            <img
              className="g2-hud-screenshot"
              src={`/sim-api/api/screenshot/glasses?t=${screenshotTick}`}
              alt="Live HUD framebuffer from evenhub-simulator"
              width={576}
              height={288}
            />
          ) : frame ? (
            <div className="g2-hud-text" style={{ fontSize: `${fontSize}px` }}>
              {frame.lines.map((line, i) => (
                <div className="g2-hud-line" key={i}>
                  {line}
                </div>
              ))}
            </div>
          ) : (
            <div className="g2-hud-dark">— HUD dark —</div>
          )}
        </div>
      </div>
    </div>
  );
}

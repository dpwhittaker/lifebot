import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { G2HudCore, type HudFrame } from './G2HudCore';
import type { Cue } from './DomCueRenderer';
import { useStickyScrollBottom } from '../../util/useStickyScrollBottom';

/**
 * Split a string on `*...*` markers and return a flat array of React nodes
 * where the wrapped segments are rendered bold (G2 "100% white" / brightest
 * pixel level) and the rest is normal (light-gray / ~AA brightness).
 *
 * The asterisks themselves are consumed in the output — the G2 firmware
 * doesn't natively parse markdown, but we use this convention in cueShort
 * (e.g. `*Psalm 74:14* The Lord is my shepherd…`) so the preview shows the
 * intended brightness distinction. Bridge output ships the literal asterisks
 * unchanged.
 */
function renderWithBold(text: string): ReactNode {
  if (!text) return text;
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const start = text.indexOf('*', i);
    if (start < 0) {
      out.push(text.slice(i));
      break;
    }
    const end = text.indexOf('*', start + 1);
    if (end < 0) {
      out.push(text.slice(i));
      break;
    }
    if (start > i) out.push(text.slice(i, start));
    out.push(
      <span className="g2-hud-bold" key={key++}>
        {text.slice(start + 1, end)}
      </span>,
    );
    i = end + 1;
  }
  return out;
}

type Props = {
  transcript: string;
  cues: Cue[];
};

/**
 * Bottom-right pane: shows what the G2 HUD would render right now.
 *
 * Two-pane layout (50/50 split, matches G2HudRenderer):
 *   - left  → running transcript (text container)
 *   - right → scrollable cue list (selection list)
 *
 * Two modes, picked at runtime by reachability:
 *   - **simulator mode** — when the evenhub-simulator's automation API is up
 *     (`/sim-api/api/ping`), embed the live LVGL framebuffer as an `<img>`
 *     polling `/api/screenshot/glasses`. Ground-truth pixels.
 *   - **DOM mode** — fallback for plain-browser dev. Hand-rolled mock using
 *     `G2HudCore` for the dual-pane state + debounce. Less faithful but
 *     immediate.
 *
 * Mode is re-checked every 5 s so flipping the simulator on/off works without
 * a reload.
 */
const SIM_PING_INTERVAL_MS = 5000;
const SIM_SCREENSHOT_INTERVAL_MS = 500;

export function G2HudPreview({ transcript, cues }: Props) {
  const [frame, setFrame] = useState<HudFrame>({ transcript: '', cues: [] });
  const [simAvailable, setSimAvailable] = useState<boolean>(false);
  const [screenshotTick, setScreenshotTick] = useState<number>(0);
  const coreRef = useRef<G2HudCore | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const cuesRef = useRef<HTMLDivElement>(null);

  // App.tsx stores cues newest-first. The HUD reads top-to-bottom now, so
  // reverse for display. The focus marker `>` goes on the last (newest) row.
  const orderedCues = useMemo(() => frame.cues.slice().reverse(), [frame.cues]);

  useStickyScrollBottom(transcriptRef, frame.transcript.length);
  useStickyScrollBottom(cuesRef, orderedCues.length);

  useEffect(() => {
    const core = new G2HudCore({ onFrame: setFrame });
    coreRef.current = core;
    return () => {
      core.destroy();
      coreRef.current = null;
    };
  }, []);

  useEffect(() => {
    coreRef.current?.setTranscript(transcript);
  }, [transcript]);

  useEffect(() => {
    const items = cues
      .map((c) => c.short ?? c.text)
      .filter((s): s is string => !!s);
    coreRef.current?.setCues(items);
  }, [cues]);

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
          <span className="g2-meta-tag">576×288 · 50/50</span>
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
          ) : (
            <div className="g2-hud-split">
              <div className="g2-hud-transcript" aria-label="Transcript pane" ref={transcriptRef}>
                {frame.transcript ? (
                  renderWithBold(frame.transcript)
                ) : (
                  <span className="g2-hud-placeholder">— no transcript —</span>
                )}
              </div>
              <div className="g2-hud-cues" aria-label="Cue list pane" ref={cuesRef}>
                {orderedCues.length === 0 ? (
                  <span className="g2-hud-placeholder">— no cues —</span>
                ) : (
                  orderedCues.map((item, i) => {
                    const isFocused = i === orderedCues.length - 1;
                    return (
                      <div
                        className={
                          'g2-hud-cue-item' + (isFocused ? ' g2-hud-cue-item--focused' : '')
                        }
                        key={i}
                      >
                        <span className="g2-hud-cue-marker">{isFocused ? '>' : ' '}</span>
                        <span className="g2-hud-cue-text">{renderWithBold(item)}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

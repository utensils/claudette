import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { formatElapsedSeconds } from "./chatHelpers";
import styles from "./ChatPanel.module.css";

interface VoiceMeterProps {
  elapsedSeconds: number;
  /**
   * When true, subscribe to `voice://level` and animate the bars from RMS.
   * When false, render static mid-range bars — used for `prefers-reduced-motion`
   * and for webview-driven providers (Web Speech API) that don't emit levels.
   */
  useDynamicMeter: boolean;
}

/**
 * Live VU meter for the chat composer's recording indicator. Owns its own
 * level-event subscription so 30 Hz updates re-render only this component
 * rather than the ~1k-line `ChatInputArea` parent.
 */
export function VoiceMeter({ elapsedSeconds, useDynamicMeter }: VoiceMeterProps) {
  const [vuLevel, setVuLevel] = useState(0);
  const smoothedRef = useRef(0);

  useEffect(() => {
    if (!useDynamicMeter) return;
    smoothedRef.current = 0;
    setVuLevel(0);
    let unlistenFn: UnlistenFn | undefined;
    const promise = listen<{ level: number }>("voice://level", (event) => {
      const raw = event.payload.level;
      smoothedRef.current = 0.6 * smoothedRef.current + 0.4 * raw;
      setVuLevel(smoothedRef.current);
    }).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      promise.then(() => unlistenFn?.());
      smoothedRef.current = 0;
      setVuLevel(0);
    };
  }, [useDynamicMeter]);

  // Perceptual mapping: sqrt expands quiet speech, the noise gate ignores
  // ambient hiss, and saturating at RMS=0.4 leaves headroom for loud peaks
  // while letting typical speech (RMS 0.05–0.15) reach the middle of the bar
  // range. Static fallback when dynamic mode is disabled.
  const barMin = 4;
  const barRange = 10; // 4–14 px
  let center: number;
  let outer: number;
  if (!useDynamicMeter) {
    center = 8;
    outer = 8;
  } else {
    const noiseFloor = 0.002;
    const saturation = 0.4;
    const perceptual =
      vuLevel <= noiseFloor
        ? 0
        : Math.min(Math.sqrt(vuLevel / saturation), 1);
    center = barMin + perceptual * barRange;
    outer = barMin + perceptual * barRange * 0.85;
  }

  return (
    <div className={styles.voiceRecordingStatus} aria-live="polite">
      <span className={styles.voiceWaveform} aria-hidden="true">
        <span style={{ height: `${outer}px` }} />
        <span style={{ height: `${center}px` }} />
        <span style={{ height: `${outer}px` }} />
      </span>
      <span>{formatElapsedSeconds(elapsedSeconds)}</span>
    </div>
  );
}

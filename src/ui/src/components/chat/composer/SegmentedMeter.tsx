import { type CSSProperties, forwardRef } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { computeMeterState } from "../contextMeterLogic";
import { formatTokens } from "../formatTokens";
import { useSelectedModelEntry } from "../useSelectedModelEntry";
import { segmentedBand, segmentedColor } from "./segmentedMeterLogic";
import styles from "./SegmentedMeter.module.css";

const CELL_COUNT = 10;

interface SegmentedMeterProps {
  sessionId: string;
  onClick: () => void;
  suspended?: boolean;
}

export const SegmentedMeter = forwardRef<HTMLButtonElement, SegmentedMeterProps>(
function SegmentedMeter({ sessionId, onClick, suspended = false }, ref) {
  const usage = useAppStore((s) => s.latestTurnUsage[sessionId]);

  const model = useSelectedModelEntry(sessionId);
  const state = computeMeterState(usage, model?.contextWindowTokens);
  if (suspended || !state) return null;

  const ratio = state.totalTokens / state.capacity;
  const band = segmentedBand(ratio);
  const color = segmentedColor(band);
  const urgent = ratio >= 0.85;

  const filledFloat = (state.fillPercent / 100) * CELL_COUNT;
  const filled = Math.floor(filledFloat);
  const partial = filledFloat - filled;

  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.meter} ${urgent ? styles.meterUrgent : ""}`}
      onClick={onClick}
      aria-label={`Context ${state.percentRounded}% used`}
    >
      <div className={styles.cells}>
        {Array.from({ length: CELL_COUNT }, (_, i) => {
          const isFilled = i < filled;
          const isLeading = i === filled && partial > 0.02;
          const isEmpty = !isFilled && !isLeading;
          const isBreathing = isFilled && i === filled - 1;

          return (
            <span
              key={i}
              className={`${styles.cell} ${isFilled ? styles.cellFilled : ""} ${isBreathing ? styles.cellBreathing : ""} ${isEmpty ? styles.cellEmpty : ""}`}
              style={{
                "--cell-index": i,
                "--cell-color": color,
                "--breath-duration": urgent ? "0.9s" : "1.8s",
                "--lead-duration": urgent ? "1.2s" : "2.2s",
              } as CSSProperties}
            >
              {isLeading && (
                <span
                  className={styles.cellPartial}
                  style={{
                    height: `${partial * 100}%`,
                    background: color,
                  }}
                />
              )}
            </span>
          );
        })}

        {urgent && (
          <span
            className={styles.edgePulse}
            aria-hidden
            style={{
              left: `calc(${Math.min(filled, CELL_COUNT - 1) * 7}px)`,
              "--cell-color": color,
            } as CSSProperties}
          />
        )}
      </div>

      <span className={styles.readout}>
        {formatTokens(state.totalTokens)} / {formatTokens(state.capacity)}
      </span>
    </button>
  );
});

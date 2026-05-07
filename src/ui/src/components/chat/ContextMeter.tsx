import { useAppStore } from "../../stores/useAppStore";
import { formatTokens } from "./formatTokens";
import { buildMeterTooltip, computeMeterState, type Band } from "./contextMeterLogic";
import { useSelectedModelEntry } from "./useSelectedModelEntry";
import styles from "./ContextMeter.module.css";

interface ContextMeterProps {
  sessionId: string;
}

function fillClassForBand(band: Band): string {
  switch (band) {
    case "critical":
      return styles.fillCritical;
    case "near-full":
      return styles.fillNearFull;
    case "warn":
      return styles.fillWarn;
    case "normal":
      return styles.fillNormal;
  }
}

/**
 * Compact context-window utilization meter for the chat toolbar.
 *
 * Reads the most recent turn's usage from the `latestTurnUsage` slice
 * (populated on every turn end by `finalizeTurn`, including tool-free
 * turns that don't produce a `CompletedTurn`) and the currently-selected
 * model's capacity. Hidden when either source is missing — covers fresh
 * workspaces, pre-migration history, and stale model ids. All computation
 * lives in `contextMeterLogic.ts` so this component is a thin presentational
 * wrapper.
 */
export function ContextMeter({ sessionId }: ContextMeterProps) {
  const usage = useAppStore((s) => s.latestTurnUsage[sessionId]);

  const model = useSelectedModelEntry(sessionId);
  const state = computeMeterState(usage, model?.contextWindowTokens);
  if (!state) return null;

  const tooltip = buildMeterTooltip(state);

  return (
    <div className={styles.meter} title={tooltip}>
      <div className={styles.track}>
        <div
          className={`${styles.fill} ${fillClassForBand(state.band)}`}
          data-band={state.band}
          style={{ width: `${state.fillPercent}%` }}
        />
      </div>
      <span className={styles.readout}>
        {formatTokens(state.totalTokens)} / {formatTokens(state.capacity)}
      </span>
    </div>
  );
}

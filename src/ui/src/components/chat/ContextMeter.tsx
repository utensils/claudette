import { useAppStore } from "../../stores/useAppStore";
import { MODELS } from "./modelRegistry";
import { formatTokens } from "./formatTokens";
import { buildMeterTooltip, computeMeterState, type Band } from "./contextMeterLogic";
import styles from "./ContextMeter.module.css";

interface ContextMeterProps {
  workspaceId: string;
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
 * Reads the most recent completed turn for the workspace and the
 * currently-selected model's capacity. Hidden when either source is
 * missing — covers fresh workspaces, pre-migration history, and stale
 * model ids. All computation lives in `contextMeterLogic.ts` so this
 * component is a thin presentational wrapper.
 */
export function ContextMeter({ workspaceId }: ContextMeterProps) {
  const turns = useAppStore((s) => s.completedTurns[workspaceId]);
  const selectedModel = useAppStore((s) => s.selectedModel[workspaceId]);

  const latestTurn = turns && turns.length > 0 ? turns[turns.length - 1] : undefined;
  const model = MODELS.find((m) => m.id === selectedModel);
  const state = computeMeterState(latestTurn, model?.contextWindowTokens);
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

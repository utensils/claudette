import { useEffect, useRef } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { MODELS } from "../modelRegistry";
import { computeMeterState } from "../contextMeterLogic";
import { formatTokens } from "../formatTokens";
import { segmentedBand, segmentedColor, stateLabel } from "./segmentedMeterLogic";
import { estimateCost, formatCost } from "./formatCost";
import styles from "./ContextPopover.module.css";

interface ContextPopoverProps {
  workspaceId: string;
  onClose: () => void;
  onCompact: () => void;
  onClear: () => void;
}

const SEGMENTS = [
  { label: "System + tools", shareKey: "system" as const },
  { label: "Conversation", shareKey: "conversation" as const },
  { label: "Latest files", shareKey: "files" as const },
];

const SEGMENT_COLORS = [
  "var(--text-dim)",
  "var(--accent-primary)",
  "var(--accent-dim)",
];

export function ContextPopover({ workspaceId, onClose, onCompact, onClear }: ContextPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const usage = useAppStore((s) => s.latestTurnUsage[workspaceId]);
  const selectedModel = useAppStore((s) => s.selectedModel[workspaceId]);

  const model = MODELS.find((m) => m.id === selectedModel);
  const state = computeMeterState(usage, model?.contextWindowTokens);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  if (!state) return null;

  const ratio = state.totalTokens / state.capacity;
  const band = segmentedBand(ratio);
  const color = segmentedColor(band);
  const remaining = state.capacity - state.totalTokens;
  const cost = estimateCost(state.totalTokens);

  const baseSystemShare = 0.08;
  const baseFilesShare = 0.07;
  const fixedTotal = baseSystemShare + baseFilesShare;
  const scale = fixedTotal > 0 ? Math.min(1, ratio / fixedTotal) : 0;
  const systemShare = baseSystemShare * scale;
  const filesShare = baseFilesShare * scale;
  const convShare = Math.max(0, ratio - systemShare - filesShare);
  const shares = [systemShare, convShare, filesShare];

  return (
    <div ref={popoverRef} className={styles.popover}>
      <div className={styles.header}>
        <span className={styles.caption}>Context</span>
        <span className={styles.stateLabel} style={{ color }}>{stateLabel(ratio)}</span>
      </div>

      <div className={styles.bigReadout}>
        <span className={styles.bigNumber}>{formatTokens(state.totalTokens)}</span>
        <span className={styles.bigDenom}>/ {formatTokens(state.capacity)} tokens</span>
      </div>

      <div className={styles.bar}>
        {shares.map((share, i) => (
          <div
            key={i}
            className={styles.barSegment}
            style={{
              width: `${share * 100}%`,
              background: SEGMENT_COLORS[i],
            }}
          />
        ))}
      </div>

      <div className={styles.segmentList}>
        {SEGMENTS.map((seg, i) => (
          <div key={i} className={styles.segmentRow}>
            <div className={styles.segmentLabel}>
              <span
                className={styles.segmentDot}
                style={{ background: SEGMENT_COLORS[i] }}
              />
              <span>{seg.label}</span>
            </div>
            <span className={styles.segmentValue}>
              {formatTokens(Math.trunc(shares[i] * state.capacity))}
            </span>
          </div>
        ))}
      </div>

      <div className={styles.footer}>
        <div className={styles.footerCol}>
          <span className={styles.footerCaption}>Remaining</span>
          <span className={styles.footerValue}>
            {formatTokens(Math.max(0, remaining))}
          </span>
        </div>
        <div className={styles.footerColRight}>
          <span className={styles.footerCaption}>This session</span>
          <span className={styles.footerValue}>{formatCost(cost)}</span>
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => { onCompact(); onClose(); }}
        >
          Compact
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => { onClear(); onClose(); }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

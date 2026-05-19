import { type RefObject, useEffect, useMemo, useRef } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { computeMeterState } from "../contextMeterLogic";
import { formatTokens } from "../formatTokens";
import { useSelectedModelEntry } from "../useSelectedModelEntry";
import { segmentedBand, segmentedColor, stateLabel } from "./segmentedMeterLogic";
import { estimateCost, formatCost } from "./formatCost";
import { resolveSessionHarness } from "../resolveSessionHarness";
import styles from "./ContextPopover.module.css";

interface ContextPopoverProps {
  sessionId: string;
  onClose: () => void;
  onCompact: () => void;
  onClear: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
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

export function ContextPopover({ sessionId, onClose, onCompact, onClear, triggerRef }: ContextPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const usage = useAppStore((s) => s.latestTurnUsage[sessionId]);
  const agentBackends = useAppStore((s) => s.agentBackends);
  const selectedModelProvider = useAppStore((s) => s.selectedModelProvider);
  const defaultAgentBackendId = useAppStore((s) => s.defaultAgentBackendId);

  const model = useSelectedModelEntry(sessionId);
  const state = computeMeterState(usage, model?.contextWindowTokens);

  // The Pi SDK harness has no native compaction protocol. Disable the
  // button so clicking can't produce a confusing no-op. Resolution
  // matches the send pipeline's fallback (per-session provider →
  // default backend → first available), so a fresh session with no
  // explicit provider still gates correctly when the default backend
  // is Pi. Fail-closed: if we can't resolve a harness at all (backends
  // not loaded yet), keep the button enabled (resolution returns null
  // → we treat as "not Pi" so the user isn't blocked unnecessarily on
  // the more common Claude/Codex case).
  const compactSupported = useMemo(() => {
    const harness = resolveSessionHarness({
      sessionId,
      selectedModelProvider,
      agentBackends,
      defaultAgentBackendId,
    });
    return harness !== "pi_sdk";
  }, [agentBackends, defaultAgentBackendId, selectedModelProvider, sessionId]);

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
      const target = e.target as Node;
      if (triggerRef?.current?.contains(target)) return;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, triggerRef]);

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
        {/* Wrap the disabled-state button in a tooltip-bearing span:
            Chromium swallows `title`/hover events on disabled <button>
            elements, so users would get no explanation. The shared
            AppTooltip pattern reads `data-tooltip` via document-level
            pointerover, which still fires over the wrapper span. The
            wrapper has zero visual effect when the button is enabled
            (no data-tooltip attribute, no styles). */}
        <span
          className={styles.actionBtnWrap}
          data-tooltip={
            compactSupported
              ? undefined
              : "Compaction is not supported on this backend."
          }
        >
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => { onCompact(); onClose(); }}
          disabled={!compactSupported}
          aria-disabled={!compactSupported || undefined}
        >
          Compact
        </button>
        </span>
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

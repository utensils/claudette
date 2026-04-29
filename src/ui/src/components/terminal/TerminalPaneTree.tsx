import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import type { TerminalPaneNode } from "../../types/terminal";
import styles from "./TerminalPanel.module.css";

export interface TerminalPaneTreeProps {
  tabId: number;
  node: TerminalPaneNode;
  activePaneId: string | null;
  onActivatePane: (leafId: string) => void;
  onLayout: (splitId: string, sizes: [number, number]) => void;
  onRetryLeaf: (leafId: string) => void;
}

/**
 * Recursive renderer for the split-pane binary tree.
 *
 * CRITICAL: leaves DO NOT render xterm themselves. They emit an empty
 * target `<div data-pane-target={leafId}>` that the parent TerminalPanel
 * later `appendChild`s the xterm host into via a useLayoutEffect. This
 * keeps xterm instances alive across structural rewrites of the tree
 * (splitting, closing, re-parenting) — if React owned the xterm, every
 * split would remount the existing pane and respawn its PTY.
 *
 * Split nodes use react-resizable-panels `Group`/`Panel`/`Separator`.
 * Our direction vocabulary matches the library's `orientation` prop:
 *   - "horizontal" → side-by-side columns (vertical divider)
 *   - "vertical"   → stacked rows (horizontal divider)
 */
export const TerminalPaneTree = memo(function TerminalPaneTree(
  props: TerminalPaneTreeProps,
) {
  const { t } = useTranslation(["chat", "common"]);
  const { tabId, node, activePaneId, onActivatePane, onLayout, onRetryLeaf } = props;

  if (node.kind === "leaf") {
    const isActive = activePaneId === node.id;
    return (
      <div
        className={`${styles.paneLeaf} ${isActive ? styles.paneLeafActive : ""}`}
        data-pane-target={node.id}
        data-pane-tab-id={tabId}
        onPointerDown={() => onActivatePane(node.id)}
      >
        {node.spawnError && (
          <div className={styles.paneLeafError} role="alert">
            <div className={styles.spawnErrorTitle}>{t("chat:terminal_failed_to_start")}</div>
            <div className={styles.spawnErrorMessage}>{node.spawnError}</div>
            <button
              className={styles.spawnErrorRetry}
              onClick={() => onRetryLeaf(node.id)}
            >
              {t("common:retry")}
            </button>
          </div>
        )}
      </div>
    );
  }

  const handleClass =
    node.direction === "horizontal"
      ? styles.paneHandleVertical
      : styles.paneHandleHorizontal;

  const leftId = `${node.id}-a`;
  const rightId = `${node.id}-b`;

  return (
    <Group
      orientation={node.direction}
      id={`pane-group-${node.id}`}
      style={{ width: "100%", height: "100%" }}
      onLayoutChanged={(layout: Layout) => {
        const left = layout[leftId];
        const right = layout[rightId];
        if (typeof left === "number" && typeof right === "number") {
          onLayout(node.id, [left, right]);
        }
      }}
    >
      <Panel id={leftId} defaultSize={node.sizes[0]} minSize={10}>
        <TerminalPaneTree
          tabId={tabId}
          node={node.children[0]}
          activePaneId={activePaneId}
          onActivatePane={onActivatePane}
          onLayout={onLayout}
          onRetryLeaf={onRetryLeaf}
        />
      </Panel>
      <Separator className={handleClass} />
      <Panel id={rightId} defaultSize={node.sizes[1]} minSize={10}>
        <TerminalPaneTree
          tabId={tabId}
          node={node.children[1]}
          activePaneId={activePaneId}
          onActivatePane={onActivatePane}
          onLayout={onLayout}
          onRetryLeaf={onRetryLeaf}
        />
      </Panel>
    </Group>
  );
});

import { memo } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import type { TerminalPaneNode } from "../../types/terminal";
import { TerminalLeaf } from "./TerminalLeaf";
import styles from "./TerminalPanel.module.css";

export interface TerminalPaneTreeProps {
  tabId: number;
  workspaceId: string;
  worktreePath: string;
  node: TerminalPaneNode;
  activePaneId: string | null;
  keyHandler: (ev: KeyboardEvent) => boolean;
  onActivatePane: (leafId: string) => void;
  onLayout: (splitId: string, sizes: [number, number]) => void;
}

/**
 * Recursive renderer for the split-pane binary tree.
 *
 * Each split node becomes a react-resizable-panels `Group` with two `Panel`s
 * and a `Separator` between them. The `orientation` we pass matches our
 * TerminalSplitDirection vocabulary directly:
 *   - "horizontal" → side-by-side columns (vertical divider)
 *   - "vertical"   → stacked rows (horizontal divider)
 *
 * Leaf nodes render a single TerminalLeaf, which owns its xterm + PTY.
 */
export const TerminalPaneTree = memo(function TerminalPaneTree(
  props: TerminalPaneTreeProps,
) {
  const {
    tabId,
    workspaceId,
    worktreePath,
    node,
    activePaneId,
    keyHandler,
    onActivatePane,
    onLayout,
  } = props;

  if (node.kind === "leaf") {
    return (
      <TerminalLeaf
        tabId={tabId}
        leafId={node.id}
        workspaceId={workspaceId}
        worktreePath={worktreePath}
        isActivePane={activePaneId === node.id}
        keyHandler={keyHandler}
        onActivate={() => onActivatePane(node.id)}
      />
    );
  }

  const handleClass =
    node.direction === "horizontal"
      ? styles.paneHandleVertical
      : styles.paneHandleHorizontal;

  // Stable panel ids — the parent split id plus a suffix. react-resizable-
  // panels keys its Layout dict by panel id, so we read both back in order
  // and write them into the store's sizes tuple.
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
          workspaceId={workspaceId}
          worktreePath={worktreePath}
          node={node.children[0]}
          activePaneId={activePaneId}
          keyHandler={keyHandler}
          onActivatePane={onActivatePane}
          onLayout={onLayout}
        />
      </Panel>
      <Separator className={handleClass} />
      <Panel id={rightId} defaultSize={node.sizes[1]} minSize={10}>
        <TerminalPaneTree
          tabId={tabId}
          workspaceId={workspaceId}
          worktreePath={worktreePath}
          node={node.children[1]}
          activePaneId={activePaneId}
          keyHandler={keyHandler}
          onActivatePane={onActivatePane}
          onLayout={onLayout}
        />
      </Panel>
    </Group>
  );
});

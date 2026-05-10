import { useState, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { DiffFile, DiffLayer } from "../../types/diff";
import { buildDiffTree, type DiffTreeNode } from "../../utils/buildDiffTree";
import { getMaterialFolderIconUrl } from "../../utils/materialIcons";
import { useIsLightTheme } from "../../hooks/useIsLightTheme";
import styles from "./RightSidebar.module.css";

interface DiffTreeViewProps {
  files: DiffFile[];
  layer?: DiffLayer;
  renderFileRow: (file: DiffFile, layer?: DiffLayer) => React.ReactElement;
}

export function DiffTreeView({ files, layer, renderFileRow }: DiffTreeViewProps) {
  const isLight = useIsLightTheme();
  const tree = useMemo(() => buildDiffTree(files), [files]);
  // Dirs start expanded; key is the deepest-dir path of the compressed node.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleDir = (path: string) =>
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));

  const renderNode = (node: DiffTreeNode, depth: number): React.ReactElement => {
    if (node.kind === "file") {
      return (
        <div key={node.path} className={styles.treeFileRow} style={{ paddingLeft: depth * 12 }}>
          {renderFileRow(node.file, layer)}
        </div>
      );
    }

    const isCollapsed = !!collapsed[node.path];
    // Use the last segment of the label for the folder icon lookup.
    const lastSegment = node.label.split("/").pop()!;
    const iconUrl = getMaterialFolderIconUrl(lastSegment, !isCollapsed, isLight);

    return (
      <div key={node.path}>
        <div
          className={styles.treeDir}
          style={{ paddingLeft: depth * 12 + 8 }}
          onClick={() => toggleDir(node.path)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleDir(node.path);
            }
          }}
        >
          <ChevronRight
            size={12}
            className={`${styles.groupChevron} ${!isCollapsed ? styles.groupChevronOpen : ""}`}
          />
          <img
            src={iconUrl}
            width={14}
            height={14}
            className={styles.fileIcon}
            alt=""
            aria-hidden="true"
          />
          <span className={styles.treeDirLabel}>{renderCompressedLabel(node.label)}</span>
        </div>
        {!isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return <>{tree.map((node) => renderNode(node, 0))}</>;
}

function renderCompressedLabel(label: string): React.ReactElement {
  const parts = label.split("/");
  if (parts.length === 1) return <span>{label}</span>;
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <span className={styles.treeLabelSep}>/</span>}
          <span className={i < parts.length - 1 ? styles.treeLabelDim : undefined}>{part}</span>
        </span>
      ))}
    </>
  );
}

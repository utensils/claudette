import { ContextMenu, type ContextMenuItem } from "../shared/ContextMenu";

export type AttachmentContextMenuItem = Extract<
  ContextMenuItem,
  { type?: "item" }
>;

interface AttachmentContextMenuProps {
  x: number;
  y: number;
  items: AttachmentContextMenuItem[];
  onClose: () => void;
}

export function AttachmentContextMenu({
  x,
  y,
  items,
  onClose,
}: AttachmentContextMenuProps) {
  return (
    <ContextMenu
      x={x}
      y={y}
      items={items}
      onClose={onClose}
      dataTestId="attachment-context-menu"
    />
  );
}

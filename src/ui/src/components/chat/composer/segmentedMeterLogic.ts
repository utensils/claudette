export type SegmentedBand = "normal" | "warn" | "critical";

export function segmentedBand(ratio: number): SegmentedBand {
  if (ratio >= 0.85) return "critical";
  if (ratio >= 0.60) return "warn";
  return "normal";
}

export function stateLabel(ratio: number): string {
  if (ratio < 0.6) return "healthy";
  if (ratio < 0.85) return "filling up";
  return "nearing limit";
}

export function segmentedColor(band: SegmentedBand): string {
  switch (band) {
    case "normal":
      return "var(--accent-primary)";
    case "warn":
      return "var(--badge-ask)";
    case "critical":
      return "var(--status-stopped)";
  }
}

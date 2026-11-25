import i18n from "../../../i18n";

export type SegmentedBand = "normal" | "warn" | "critical";

export function segmentedBand(ratio: number): SegmentedBand {
  if (ratio >= 0.85) return "critical";
  if (ratio >= 0.60) return "warn";
  return "normal";
}

export function stateLabel(ratio: number): string {
  if (ratio < 0.6) return i18n.t("chat:context_state_healthy");
  if (ratio < 0.85) return i18n.t("chat:context_state_filling");
  return i18n.t("chat:context_state_nearing");
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

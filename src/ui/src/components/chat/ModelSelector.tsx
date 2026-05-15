import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  CircleDollarSign,
  ChevronRight,
  Search as SearchIcon,
  SearchX,
  X,
} from "lucide-react";
import styles from "./ModelSelector.module.css";
import { type Model } from "./modelRegistry";
import { useModelRegistry } from "./useModelRegistry";
import { useAppStore } from "../../stores/useAppStore";

export { MODELS, is1mContextModel, get1mFallback } from "./modelRegistry";

interface ModelSelectorProps {
  selected: string;
  selectedProvider?: string;
  onSelect: (model: string, providerId?: string) => void;
  onClose: () => void;
}

function isSelectedModel(
  model: Model,
  selected: string,
  selectedProvider: string,
): boolean {
  return (
    model.id === selected &&
    (model.providerId ?? "anthropic") === selectedProvider
  );
}

// NOTE (god-file watch): this component tripled in size (~150 → ~520
// lines) when the Pi sub-section grouping + runtime-badge logic landed.
// Two cohesive helpers worth extracting into siblings here: `buildSections`
// (the grouping pass below — pure data shape, no React) and the routing
// badge string-mapping inside the render tree. Splitting them would let
// `ModelSelector` stay focused on UI state (expansion, search, focus
// movement). Tracked as a follow-up; not done in this PR to keep the
// diff scoped.

interface PiSubSection {
  key: string;
  label: string;
  primary: Model[];
  overflow: Model[];
}

interface Section {
  /** Unique section key used for header rendering. For non-Pi groups
   *  this is the group label itself. */
  key: string;
  /** Human-readable header. */
  label: string;
  /** Models always visible in this section. */
  primary: Model[];
  /** Models hidden behind the section-level "More" disclosure
   *  (Claude Code's older Anthropic models). */
  legacy: Model[];
  /** Populated only for the Pi section. Each entry has its own
   *  "Show all" disclosure rather than a single section-wide one. */
  piSubSections: PiSubSection[];
  /** Effective harness for the backend that supplied this section's
   *  models, inherited from the first model. Drives the
   *  "via Pi" / "via Claude CLI" badge in the section header so the
   *  user can see at a glance which sidecar will run the turn. */
  runtimeHarness?: string;
  /** Backend `kind` carried up from the first model, used to scope
   *  badge rendering (e.g. only show "via Pi" on cards whose
   *  allow-list contains both Pi and Claude CLI — Ollama / LM Studio /
   *  Custom OpenAI / Codex Native). */
  providerKind?: string;
}

/**
 * Group `models` by their section. Sections appear in the iteration
 * order of `models` (so the Claude Code curated list always renders
 * first). The Pi section additionally splits its members by
 * `subProviderKey` and respects the per-sub-section primary cap that
 * `modelRegistry` already applied via `legacy: true`.
 */
function buildSections(models: readonly Model[]): Section[] {
  const sections = new Map<string, Section>();
  const piSubSectionLookup = new Map<string, Map<string, PiSubSection>>();
  const piSubSectionOrder = new Map<string, string[]>();
  for (const model of models) {
    const key = model.group;
    let section = sections.get(key);
    if (!section) {
      section = {
        key,
        label: key,
        primary: [],
        legacy: [],
        piSubSections: [],
        // Inherit the dispatch metadata from the first model in this
        // section — all models in a flat backend section share a
        // backend, so these fields are constant per section.
        runtimeHarness: model.runtimeHarness,
        providerKind: model.providerKind,
      };
      sections.set(key, section);
    }
    if (model.providerKind === "pi_sdk") {
      // Pi: group into per-sub-provider buckets. The model registry
      // already tagged legacy-within-sub-section via `legacy: true`,
      // so we route on that flag here.
      const subKey = model.subProviderKey ?? "other";
      let subMap = piSubSectionLookup.get(key);
      if (!subMap) {
        subMap = new Map();
        piSubSectionLookup.set(key, subMap);
        piSubSectionOrder.set(key, []);
      }
      let sub = subMap.get(subKey);
      if (!sub) {
        sub = {
          key: subKey,
          label: model.subProvider ?? subKey,
          primary: [],
          overflow: [],
        };
        subMap.set(subKey, sub);
        piSubSectionOrder.get(key)!.push(subKey);
      }
      if (model.legacy) sub.overflow.push(model);
      else sub.primary.push(model);
      continue;
    }
    if (model.legacy) section.legacy.push(model);
    else section.primary.push(model);
  }
  // Materialize ordered sub-sections back onto the parent section.
  for (const [sectionKey, subKeys] of piSubSectionOrder) {
    const section = sections.get(sectionKey);
    const subMap = piSubSectionLookup.get(sectionKey);
    if (!section || !subMap) continue;
    section.piSubSections = subKeys
      .map((key) => subMap.get(key))
      .filter((sub): sub is PiSubSection => Boolean(sub));
  }
  return Array.from(sections.values());
}

export function ModelSelector({
  selected,
  selectedProvider = "anthropic",
  onSelect,
  onClose,
}: ModelSelectorProps) {
  const { t } = useTranslation("chat");
  const disable1mContext = useAppStore((s) => s.disable1mContext);
  // `useModelRegistry` applies every cross-cutting visibility gate
  // (feature flags + OAuth Pi-anthropic filter) so this picker never
  // surfaces a row the Rust resolver would refuse mid-send.
  const registry = useModelRegistry();
  const visibleModels = useMemo(
    () =>
      registry.filter((m) => {
        if (disable1mContext && m.contextWindowTokens >= 1_000_000) return false;
        return true;
      }),
    [disable1mContext, registry],
  );

  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().toLowerCase();
  const searching = trimmedQuery.length > 0;
  const filteredBySearch = useMemo(() => {
    if (!searching) return visibleModels;
    return visibleModels.filter((m) =>
      `${m.id} ${m.label} ${m.subProvider ?? ""} ${m.group}`
        .toLowerCase()
        .includes(trimmedQuery),
    );
  }, [searching, trimmedQuery, visibleModels]);

  // Always keep the currently selected option visible even when a
  // filter would hide it — otherwise typing a non-matching query makes
  // the in-effect choice disappear, which is disorienting.
  const selectedEntry = useMemo(
    () =>
      visibleModels.find((m) => isSelectedModel(m, selected, selectedProvider)),
    [visibleModels, selected, selectedProvider],
  );
  const filteredHasSelected = filteredBySearch.some((m) =>
    isSelectedModel(m, selected, selectedProvider),
  );
  const finalModels =
    !filteredHasSelected && selectedEntry
      ? [selectedEntry, ...filteredBySearch]
      : filteredBySearch;

  const sections = useMemo(() => buildSections(finalModels), [finalModels]);

  const selectedIsLegacy = registry.some(
    (m) => isSelectedModel(m, selected, selectedProvider) && m.legacy,
  );

  // Section-level + sub-section-level disclosure state. Keys are the
  // section's `key`; for Pi sub-sections we use `${section}::${subKey}`.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // On open, if the in-effect selection lives behind a disclosure,
  // pre-expand its container so the row is visible.
  useEffect(() => {
    if (!selectedIsLegacy || !selectedEntry) return;
    const key =
      selectedEntry.providerKind === "pi_sdk"
        ? `${selectedEntry.group}::${selectedEntry.subProviderKey ?? "other"}`
        : selectedEntry.group;
    setExpanded((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [selectedIsLegacy, selectedEntry]);

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

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Tiny delay so the focus survives the click that opened the popover.
    const handle = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, []);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function rowsForSection(section: Section): React.ReactElement[] {
    if (section.piSubSections.length > 0) {
      // Pi: each sub-section gets its own header + capped rows + "Show all".
      const subRows: React.ReactElement[] = [];
      for (const sub of section.piSubSections) {
        const subKey = `${section.key}::${sub.key}`;
        const isExpanded = searching || expanded.has(subKey);
        const totalCount = sub.primary.length + sub.overflow.length;
        subRows.push(
          <div key={subKey} className={styles.subSection}>
            <div className={styles.subSectionHeader}>
              <span>{sub.label}</span>
              {totalCount > 1 && (
                <span className={styles.subSectionCount}>{totalCount}</span>
              )}
            </div>
            {sub.primary.map((model) => (
              <ModelRow
                key={model.providerQualifiedId ?? model.id}
                model={model}
                selected={isSelectedModel(model, selected, selectedProvider)}
                onSelect={onSelect}
                showProviderBadge={false}
              />
            ))}
            {sub.overflow.length > 0 && !searching && (
              <>
                <button
                  type="button"
                  className={`${styles.item} ${styles.showAllRow}`}
                  aria-expanded={isExpanded}
                  onClick={() => toggleExpanded(subKey)}
                >
                  {t("model_picker_show_all_in_subsection", {
                    count: totalCount,
                    defaultValue: "Show all {{count}}",
                  })}
                  <ChevronRight
                    size={14}
                    className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`}
                  />
                </button>
                {isExpanded &&
                  sub.overflow.map((model) => (
                    <ModelRow
                      key={model.providerQualifiedId ?? model.id}
                      model={model}
                      selected={isSelectedModel(model, selected, selectedProvider)}
                      onSelect={onSelect}
                      showProviderBadge={false}
                    />
                  ))}
              </>
            )}
            {/* When searching, overflow rows must surface inline too so
                the filter is authoritative across the whole list. */}
            {sub.overflow.length > 0 &&
              searching &&
              sub.overflow.map((model) => (
                <ModelRow
                  key={model.providerQualifiedId ?? model.id}
                  model={model}
                  selected={isSelectedModel(model, selected, selectedProvider)}
                  onSelect={onSelect}
                  showProviderBadge={false}
                />
              ))}
          </div>,
        );
      }
      return subRows;
    }
    // Non-Pi section: primary rows + a single "More" disclosure for legacy.
    const rows: React.ReactElement[] = [];
    for (const model of section.primary) {
      rows.push(
        <ModelRow
          key={model.providerQualifiedId ?? model.id}
          model={model}
          selected={isSelectedModel(model, selected, selectedProvider)}
          onSelect={onSelect}
          showProviderBadge={model.providerLabel !== section.key}
        />,
      );
    }
    if (section.legacy.length > 0 && !searching) {
      const isExpanded = expanded.has(section.key);
      rows.push(
        <button
          key={`${section.key}__more`}
          type="button"
          className={`${styles.item} ${styles.moreToggle}`}
          aria-expanded={isExpanded}
          onClick={() => toggleExpanded(section.key)}
        >
          {t("more_models")}
          <ChevronRight
            size={14}
            className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`}
          />
        </button>,
      );
      if (isExpanded) {
        for (const model of section.legacy) {
          rows.push(
            <ModelRow
              key={model.providerQualifiedId ?? model.id}
              model={model}
              selected={isSelectedModel(model, selected, selectedProvider)}
              onSelect={onSelect}
              showProviderBadge={Boolean(model.providerLabel)}
            />,
          );
        }
      }
    }
    if (section.legacy.length > 0 && searching) {
      for (const model of section.legacy) {
        rows.push(
          <ModelRow
            key={model.providerQualifiedId ?? model.id}
            model={model}
            selected={isSelectedModel(model, selected, selectedProvider)}
            onSelect={onSelect}
            showProviderBadge={Boolean(model.providerLabel)}
          />,
        );
      }
    }
    return rows;
  }

  const searchPlaceholder = t("model_picker_search_placeholder", {
    defaultValue: "Search models…",
  });

  return (
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div className={styles.dropdown}>
        <div className={styles.searchBar}>
          <SearchIcon size={14} className={styles.searchIcon} aria-hidden />
          <input
            ref={searchRef}
            type="search"
            className={styles.searchInput}
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className={styles.searchClearBtn}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              aria-label={t("model_picker_clear_search", {
                defaultValue: "Clear search",
              })}
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </div>
        <div className={styles.scrollArea}>
          {sections.length === 0 ? (
            <div className={styles.emptyState}>
              <SearchX size={18} className={styles.emptyStateIcon} aria-hidden />
              <span>
                {t("model_picker_no_results", {
                  defaultValue: "No models match",
                })}
              </span>
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.key} className={styles.section}>
                <div className={styles.groupHeader}>
                  <span className={styles.groupLabel}>{section.label}</span>
                  {renderRoutingBadge(section, t)}
                </div>
                {rowsForSection(section)}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

/** Render a small "via Pi" / "via Claude CLI" pill next to a section
 *  header. The pill shows the dispatch path Settings has chosen for
 *  this section's backend — important for cards like Ollama and LM
 *  Studio where the user (and a quick glance at the picker) can't
 *  otherwise tell which sidecar will actually run the turn. We hide
 *  the pill when the harness matches what the section's label already
 *  implies: the Pi card → Pi runtime is redundant, and a Codex Native
 *  → Codex app-server runtime is the obvious default. */
function renderRoutingBadge(
  section: Section,
  t: TFunction<"chat">,
): React.ReactNode {
  const { runtimeHarness, providerKind } = section;
  if (!runtimeHarness || !providerKind) return null;
  // Don't badge a card that's running its own native harness — the
  // section label already says so.
  if (providerKind === "pi_sdk" && runtimeHarness === "pi_sdk") return null;
  if (providerKind === "codex_native" && runtimeHarness === "codex_app_server") return null;
  if (providerKind === "anthropic" && runtimeHarness === "claude_code") return null;
  if (providerKind === "custom_anthropic" && runtimeHarness === "claude_code") return null;
  if (providerKind === "codex_subscription" && runtimeHarness === "claude_code") return null;
  // Backends whose only sanctioned harness is `claude_code` (OpenAI /
  // Custom OpenAI without a Pi opt-in) match the default — no badge.
  if (
    (providerKind === "openai_api" || providerKind === "custom_openai") &&
    runtimeHarness === "claude_code"
  ) {
    return null;
  }
  let label: string;
  let className = styles.routingBadge;
  if (runtimeHarness === "pi_sdk") {
    label = t("model_picker_routing_via_pi", { defaultValue: "via Pi" });
    className = `${styles.routingBadge} ${styles.routingBadgePi}`;
  } else if (runtimeHarness === "claude_code") {
    label = t("model_picker_routing_via_claude_cli", {
      defaultValue: "via Claude CLI",
    });
  } else if (runtimeHarness === "codex_app_server") {
    label = t("model_picker_routing_via_codex", {
      defaultValue: "via Codex app-server",
    });
  } else {
    return null;
  }
  return (
    <span
      className={className}
      title={t("model_picker_routing_tooltip", {
        defaultValue:
          "Dispatch path picked by this card's Runtime setting in Settings → Models.",
      })}
    >
      {label}
    </span>
  );
}

function ModelRow({
  model,
  selected,
  onSelect,
  showProviderBadge,
}: {
  model: Model;
  selected: boolean;
  onSelect: (id: string, providerId?: string) => void;
  showProviderBadge?: boolean;
}) {
  const { t } = useTranslation("chat");
  const shouldShowProviderBadge = Boolean(showProviderBadge && model.providerLabel);
  return (
    <button
      type="button"
      className={`${styles.item} ${selected ? styles.itemSelected : ""}`}
      onClick={() => onSelect(model.id, model.providerId)}
    >
      <span className={styles.dot} />
      <span className={styles.modelLabel} title={model.label}>{model.label}</span>
      {shouldShowProviderBadge && (
        <span className={styles.providerBadge}>{model.providerLabel}</span>
      )}
      {model.extraUsage && (
        <span
          className={styles.extraUsage}
          title={t("mcp_extra_usage_tip")}
        >
          <CircleDollarSign size={14} />
        </span>
      )}
      {selected && <span className={styles.check}>✓</span>}
    </button>
  );
}

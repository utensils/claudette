import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleDollarSign, ChevronRight, Search as SearchIcon } from "lucide-react";
import styles from "./ModelSelector.module.css";
import { buildModelRegistry, type Model } from "./modelRegistry";
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
  const alternativeBackendsEnabled = useAppStore((s) => s.alternativeBackendsEnabled);
  const codexEnabled = useAppStore((s) => s.codexEnabled);
  const agentBackends = useAppStore((s) => s.agentBackends);
  const claudeAuthMethod = useAppStore((s) => s.claudeAuthMethod);
  const registry = useMemo(
    () => buildModelRegistry(alternativeBackendsEnabled, agentBackends, codexEnabled),
    [alternativeBackendsEnabled, agentBackends, codexEnabled],
  );
  // Claude OAuth subscription users must not see Pi-routed Anthropic
  // models — see `ensure_anthropic_not_routed_through_pi_via_oauth` in
  // agent_backends.rs. Matches the Rust gate exactly so the picker
  // never offers a row that the resolver would refuse.
  const isClaudeOauthSubscriber = useMemo(
    () => claudeAuthMethod?.toLowerCase() === "oauth_token",
    [claudeAuthMethod],
  );
  const visibleModels = useMemo(
    () =>
      registry.filter((m) => {
        if (disable1mContext && m.contextWindowTokens >= 1_000_000) return false;
        if (
          isClaudeOauthSubscriber &&
          m.providerKind === "pi_sdk" &&
          m.subProviderKey === "anthropic"
        ) {
          return false;
        }
        return true;
      }),
    [disable1mContext, registry, isClaudeOauthSubscriber],
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
        subRows.push(
          <div key={subKey} className={styles.subSection}>
            <div className={styles.subSectionHeader}>{sub.label}</div>
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
                    count: sub.primary.length + sub.overflow.length,
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
            placeholder={t("model_picker_search_placeholder", {
              defaultValue: "Search models…",
            })}
            aria-label={t("model_picker_search_placeholder", {
              defaultValue: "Search models…",
            })}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className={styles.scrollArea}>
          {sections.length === 0 ? (
            <div className={styles.emptyState}>
              {t("model_picker_no_results", {
                defaultValue: "No models match",
              })}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.key}>
                <div className={styles.groupLabel}>{section.label}</div>
                {rowsForSection(section)}
              </div>
            ))
          )}
        </div>
      </div>
    </>
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

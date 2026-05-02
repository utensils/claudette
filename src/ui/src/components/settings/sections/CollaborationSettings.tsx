import { useEffect, useState } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { setAppSetting } from "../../../services/tauri";
import styles from "../Settings.module.css";

/**
 * Settings for collaborative shared sessions.
 *
 * Today this surface holds two values:
 *
 * - **Display name**: stamped onto your user messages and shown in the
 *   participants roster of every collaborative session you're in. Empty
 *   means "fall back to the OS hostname" (the same default the legacy
 *   1:1 pairing flow used). Persisted as `collab:display_name`.
 * - **Default plan-approval consensus**: pre-checks the "require unanimous
 *   plan approval" toggle in the share dialog so users who always want
 *   consensus don't have to flip it every time. Persisted as
 *   `collab:default_consensus_required`.
 *
 * The section is a single page rather than a modal because the user is
 * likely to also adjust it alongside other shared-session preferences as
 * we add them (e.g. avatar color, default mute behavior).
 */
export function CollaborationSettings() {
  const displayName = useAppStore((s) => s.collabDisplayName);
  const setDisplayName = useAppStore((s) => s.setCollabDisplayName);
  const defaultConsensus = useAppStore(
    (s) => s.collabDefaultConsensusRequired,
  );
  const setDefaultConsensus = useAppStore(
    (s) => s.setCollabDefaultConsensusRequired,
  );

  // Local input state lets us defer persistence to blur, matching the
  // pattern of other text fields in Settings (Appearance/font sizes).
  const [draftName, setDraftName] = useState(displayName);
  useEffect(() => {
    setDraftName(displayName);
  }, [displayName]);

  const [error, setError] = useState<string | null>(null);

  const persistName = async () => {
    const trimmed = draftName.trim();
    if (trimmed === displayName) return;
    try {
      setError(null);
      await setAppSetting("collab:display_name", trimmed);
      setDisplayName(trimmed);
    } catch (e) {
      setDraftName(displayName);
      setError(String(e));
    }
  };

  const toggleDefaultConsensus = async () => {
    const next = !defaultConsensus;
    setDefaultConsensus(next);
    try {
      setError(null);
      await setAppSetting(
        "collab:default_consensus_required",
        next ? "true" : "false",
      );
    } catch (e) {
      setDefaultConsensus(!next);
      setError(String(e));
    }
  };

  return (
    <div>
      <h2 className={styles.sectionTitle}>Collaboration</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Display name</div>
          <div className={styles.settingDescription}>
            Shown to other participants in shared sessions. Leave blank to
            use this machine's hostname.
          </div>
        </div>
        <div className={styles.settingControl}>
          <input
            className={styles.input}
            type="text"
            placeholder="e.g. Sean"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={persistName}
          />
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            Require plan approval by default
          </div>
          <div className={styles.settingDescription}>
            Pre-checks the "Require unanimous plan approval" option when you
            start a collaborative session.
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={defaultConsensus}
            aria-label="Require plan approval by default"
            data-checked={defaultConsensus}
            onClick={toggleDefaultConsensus}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>
    </div>
  );
}

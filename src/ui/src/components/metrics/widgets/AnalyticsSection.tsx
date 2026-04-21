import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import styles from "../metrics.module.css";
import { RepoLeaderboard } from "./RepoLeaderboard";
import { SessionHeatmap } from "./SessionHeatmap";
import { TurnHistogram } from "./TurnHistogram";
import { SlashCommandTop } from "./SlashCommandTop";

export function AnalyticsSection() {
  const [open, setOpen] = useState(true);

  return (
    <div className={styles.analyticsSection}>
      <button
        type="button"
        className={styles.analyticsHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className={styles.analyticsTitle}>Analytics</span>
      </button>
      {open ? (
        <div className={styles.analyticsGrid}>
          <RepoLeaderboard />
          <SessionHeatmap />
          <TurnHistogram />
          <SlashCommandTop />
        </div>
      ) : null}
    </div>
  );
}

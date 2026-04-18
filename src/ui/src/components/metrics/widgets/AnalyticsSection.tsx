import { useState } from "react";
import styles from "../metrics.module.css";
import { RepoLeaderboard } from "./RepoLeaderboard";
import { SessionHeatmap } from "./SessionHeatmap";
import { TurnHistogram } from "./TurnHistogram";
import { SlashCommandTop } from "./SlashCommandTop";
import { SessionTimeline } from "./SessionTimeline";

export function AnalyticsSection() {
  const [open, setOpen] = useState(true);

  return (
    <div className={styles.analyticsSection}>
      <div className={styles.analyticsHeader} onClick={() => setOpen(!open)}>
        <span className={styles.analyticsTitle}>
          {open ? "▾" : "▸"} Analytics
        </span>
      </div>
      {open ? (
        <>
          <div className={styles.analyticsGrid}>
            <RepoLeaderboard />
            <SessionHeatmap />
            <TurnHistogram />
            <SlashCommandTop />
          </div>
          <SessionTimeline />
        </>
      ) : null}
    </div>
  );
}

import styles from "../metrics.module.css";
import { ParallelAgents } from "./ParallelAgents";
import { CommitsSparkline } from "./CommitsSparkline";
import { ChurnBar } from "./ChurnBar";
import { SuccessRing } from "./SuccessRing";
import { CostCard } from "./CostCard";
import { TokenUsageTile } from "./TokenUsageTile";

export function StatsStrip() {
  return (
    <div className={styles.statsStrip}>
      <ParallelAgents />
      <CommitsSparkline />
      <ChurnBar />
      <SuccessRing />
      <CostCard />
      <TokenUsageTile />
    </div>
  );
}

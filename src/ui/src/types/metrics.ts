export interface DashboardMetrics {
  activeSessions: number;
  sessionsToday: number;
  commitsToday: number;
  additions7d: number;
  deletions7d: number;
  cost30dUsd: number;
  successRate30d: number;
  /** 14 entries, oldest first. */
  commitsDaily14d: number[];
  /** 30 entries, oldest first. */
  costDaily30d: number[];
}

export interface WorkspaceMetrics {
  commitsCount: number;
  additions: number;
  deletions: number;
  latestSessionTurns: number;
}

export interface RepoLeaderRow {
  repositoryId: string;
  sessions: number;
  commits: number;
  totalCostUsd: number;
}

export interface HeatmapCell {
  dow: number;
  week: number;
  count: number;
}

export interface SessionDot {
  endedAt: string;
  completedOk: boolean;
  workspaceId: string;
}

export interface AnalyticsMetrics {
  repoLeaderboard: RepoLeaderRow[];
  /** 91 entries (7 × 13). */
  heatmap: HeatmapCell[];
  /** 8 buckets. */
  turnHistogram: number[];
  topSlashCommands: [string, number][];
  recentSessions24h: SessionDot[];
}

export interface UsageLimit {
  utilization: number;
  resets_at: string | number;
}

export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
}

export interface UsageData {
  five_hour: UsageLimit | null;
  seven_day: UsageLimit | null;
  seven_day_sonnet: UsageLimit | null;
  seven_day_opus: UsageLimit | null;
  extra_usage: ExtraUsage | null;
}

export interface ClaudeCodeUsage {
  subscription_type: string | null;
  rate_limit_tier: string | null;
  usage: UsageData;
  fetched_at: number;
}

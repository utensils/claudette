import type { CiCheck } from "../types/plugin";

export type CiCheckTone = "success" | "failure" | "pending" | "cancelled";

export interface CiCheckSummary {
  title: string;
  total: number;
  failed: number;
  pending: number;
  cancelled: number;
  passed: number;
}

const STATUS_PRIORITY: Record<CiCheckTone, number> = {
  failure: 0,
  pending: 1,
  cancelled: 2,
  success: 3,
};

export function ciCheckStatusLabel(status: CiCheckTone): string {
  switch (status) {
    case "success":
      return "Passed";
    case "failure":
      return "Failing";
    case "pending":
      return "Running";
    case "cancelled":
      return "Cancelled";
  }
}

export function summarizeCiChecks(checks: readonly CiCheck[]): CiCheckSummary {
  const failed = checks.filter((check) => check.status === "failure").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const cancelled = checks.filter((check) => check.status === "cancelled").length;
  const passed = checks.filter((check) => check.status === "success").length;

  let title = "Checks";
  if (failed > 0) {
    title = failed === 1 ? "1 check failing" : `${failed} checks failing`;
  } else if (pending > 0) {
    title = pending === 1 ? "1 check running" : `${pending} checks running`;
  } else if (cancelled > 0) {
    title = cancelled === 1 ? "1 check cancelled" : `${cancelled} checks cancelled`;
  } else if (checks.length > 0) {
    title = checks.length === 1 ? "1 check passed" : "Checks passed";
  }

  return {
    title,
    total: checks.length,
    failed,
    pending,
    cancelled,
    passed,
  };
}

export function sortCiChecks(checks: readonly CiCheck[]): CiCheck[] {
  return [...checks].sort((a, b) => {
    const statusDelta = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (statusDelta !== 0) return statusDelta;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export type AssessmentDeadline = {
  workDeadlineAtMs: number;
  reportDeadlineAtMs: number;
  hardDeadlineAtMs: number;
};

export function assessmentDeadline(input: {
  nowMs: number;
  maxTimeMs: number;
  reportGraceMs: number;
  hardDeadlineAtMs?: number;
}): AssessmentDeadline {
  const RESERVE_MS = 5_000;
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.maxTimeMs) ||
      !Number.isSafeInteger(input.nowMs + input.maxTimeMs) ||
      !Number.isSafeInteger(input.reportGraceMs) || input.reportGraceMs < 0 ||
      input.reportGraceMs >= input.maxTimeMs - RESERVE_MS ||
      input.maxTimeMs <= RESERVE_MS ||
      (input.hardDeadlineAtMs !== undefined && !Number.isSafeInteger(input.hardDeadlineAtMs))) {
    throw new Error("invalid assessment deadline");
  }
  const hardDeadlineAtMs = Math.min(
    input.nowMs + input.maxTimeMs,
    input.hardDeadlineAtMs ?? Number.POSITIVE_INFINITY,
  );
  const reportDeadlineAtMs = hardDeadlineAtMs - RESERVE_MS;
  const workDeadlineAtMs = reportDeadlineAtMs - input.reportGraceMs;
  if (!Number.isSafeInteger(workDeadlineAtMs)) throw new Error("invalid assessment deadline");
  return { hardDeadlineAtMs, reportDeadlineAtMs, workDeadlineAtMs };
}

export type AssessmentDecision = {
  kind: "report" | "timed_out" | "cancelled" | "errored";
  atMs: number;
  reason: string;
};

// The caller supplies wall time advanced by monotonic elapsed time, anchored
// when the allowance is received, so wall-clock adjustments cannot extend work.
export function createAssessmentDecision(
  reportDeadlineAtMs: number,
  now: () => number,
): {
  decide(kind: AssessmentDecision["kind"], reason: string): boolean;
  current(): AssessmentDecision | null;
} {
  let decision: AssessmentDecision | null = null;
  return {
    decide(kind, reason) {
      if (decision !== null) return false;
      const atMs = now();
      if (kind === "report" && atMs >= reportDeadlineAtMs) {
        decision = { kind: "timed_out", atMs, reason: "assessment report deadline elapsed" };
        return false;
      }
      decision = { kind, atMs, reason };
      return true;
    },
    current() {
      return decision === null ? null : { ...decision };
    },
  };
}

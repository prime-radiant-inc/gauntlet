import { expect, test } from "bun:test";
import { assessmentDeadline, createAssessmentDecision } from "../../src/assessment/lifecycle";

test("startup time is not granted again and stop beats a late report", () => {
  const d = assessmentDeadline({ reportGraceMs: 0, nowMs: 20_000, maxTimeMs: 120_000, hardDeadlineAtMs: 120_000 });
  expect(d).toEqual({ workDeadlineAtMs: 115_000, reportDeadlineAtMs: 115_000, hardDeadlineAtMs: 120_000 });
  let now = 114_999;
  const state = createAssessmentDecision(d.workDeadlineAtMs, () => now);
  expect(state.decide("cancelled", "operator cancelled")).toBe(true);
  now = 115_001;
  expect(state.decide("report", "valid native report")).toBe(false);
  expect(state.current()?.kind).toBe("cancelled");
});

test.each([
  [{ nowMs: 0, maxTimeMs: 120_000 }, { workDeadlineAtMs: 115_000, reportDeadlineAtMs: 115_000, hardDeadlineAtMs: 120_000 }],
  [{ nowMs: 20_000, maxTimeMs: 10_000, hardDeadlineAtMs: 120_000 }, { workDeadlineAtMs: 25_000, reportDeadlineAtMs: 25_000, hardDeadlineAtMs: 30_000 }],
  [{ nowMs: 20_000, maxTimeMs: 120_000, hardDeadlineAtMs: 0 }, { workDeadlineAtMs: -5_000, reportDeadlineAtMs: -5_000, hardDeadlineAtMs: 0 }],
  [{ nowMs: 0, maxTimeMs: 5_001 }, { workDeadlineAtMs: 1, reportDeadlineAtMs: 1, hardDeadlineAtMs: 5_001 }],
])("reserves finalization time within both allowances: %j", (input, expected) => {
  expect(assessmentDeadline({ reportGraceMs: 0, ...input })).toEqual(expected);
});

test.each([
  { nowMs: NaN, maxTimeMs: 120_000 },
  { nowMs: Infinity, maxTimeMs: 120_000 },
  { nowMs: -Infinity, maxTimeMs: 120_000 },
  { nowMs: 0, maxTimeMs: 0 },
  { nowMs: 0, maxTimeMs: -1 },
  { nowMs: 0, maxTimeMs: 5_000 },
  { nowMs: 0, maxTimeMs: 4_999 },
  { nowMs: 0, maxTimeMs: NaN },
  { nowMs: 0, maxTimeMs: Infinity },
  { nowMs: 0, maxTimeMs: -Infinity },
  { nowMs: 0, maxTimeMs: 120_000, hardDeadlineAtMs: NaN },
  { nowMs: 0, maxTimeMs: 120_000, hardDeadlineAtMs: Infinity },
  { nowMs: 0, maxTimeMs: 120_000, hardDeadlineAtMs: -Infinity },
  { nowMs: 0, maxTimeMs: 120_000, hardDeadlineAtMs: 1.5 },
  { nowMs: 0, maxTimeMs: 120_000, hardDeadlineAtMs: Number.MAX_SAFE_INTEGER + 1 },
])("rejects an invalid allowance before work starts: %j", (input) => {
  expect(() => assessmentDeadline({ reportGraceMs: 0, ...input })).toThrow("invalid assessment deadline");
});

test.each([115_000, 120_001])("expired inherited work time cannot accept a report at %i", (nowMs) => {
  const deadline = assessmentDeadline({ reportGraceMs: 0, nowMs, maxTimeMs: 120_000, hardDeadlineAtMs: 120_000 });
  const state = createAssessmentDecision(deadline.workDeadlineAtMs, () => nowMs);
  expect(state.current()).toBeNull();
  expect(state.decide("report", "valid native report")).toBe(false);
  expect(state.current()).toMatchObject({ kind: "timed_out", atMs: nowMs });
  expect(state.current()?.reason).not.toBe("valid native report");
  expect(state.decide("cancelled", "operator cancelled")).toBe(false);
});

test.each(["report", "timed_out", "cancelled", "errored"] as const)("the first %s decision wins exactly once", (kind) => {
  let now = 114_999;
  const state = createAssessmentDecision(115_000, () => now);
  expect(state.decide(kind, "selected outcome")).toBe(true);
  now = 119_000;
  for (const next of ["report", "timed_out", "cancelled", "errored"] as const) {
    expect(state.decide(next, "competing outcome")).toBe(false);
  }
  expect(state.current()).toEqual({ kind, atMs: 114_999, reason: "selected outcome" });
});

test("reading a decision cannot mutate the selected outcome", () => {
  const state = createAssessmentDecision(115_000, () => 114_999);
  state.decide("cancelled", "operator cancelled");
  state.current()!.kind = "report";
  expect(state.current()?.kind).toBe("cancelled");
});


test("separates inspection, report, and publication within the inherited total", () => {
  expect(assessmentDeadline({ nowMs: 1000, maxTimeMs: 600000, reportGraceMs: 60000 })).toEqual({
    workDeadlineAtMs: 536000, reportDeadlineAtMs: 596000, hardDeadlineAtMs: 601000,
  });
  expect(assessmentDeadline({ nowMs: 1000, maxTimeMs: 600000, reportGraceMs: 60000, hardDeadlineAtMs: 301000 })).toEqual({
    workDeadlineAtMs: 236000, reportDeadlineAtMs: 296000, hardDeadlineAtMs: 301000,
  });
});

test.each([-1, NaN, Infinity, 0.5, 115000, 120000, Number.MAX_SAFE_INTEGER])("rejects invalid report grace %s", reportGraceMs => {
  expect(() => assessmentDeadline({ nowMs: 0, maxTimeMs: 120000, reportGraceMs })).toThrow("invalid assessment deadline");
});

test.each([120000.5, Number.MAX_SAFE_INTEGER])("rejects unsafe duration arithmetic %s", maxTimeMs => {
  expect(() => assessmentDeadline({ nowMs: 1000, maxTimeMs, reportGraceMs: 0 })).toThrow("invalid assessment deadline");
});

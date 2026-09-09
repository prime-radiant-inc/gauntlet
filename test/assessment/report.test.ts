import { describe, expect, test } from "bun:test";
import {
  ASSESSMENT_REPORT_TOOL,
  deriveAssessmentStatus,
  parseAssessmentReport,
} from "../../src/assessment/report";

const acceptanceCriteria = [
  "Identify the required defect",
  "Keep all material findings grounded",
] as const;

const canonicalReport = {
  summary: "Review delivered",
  reasoning: "The additional consequence was unsupported.",
  criteria: [
    { verdict: "pass", evidence: "visible/review.txt: required defect identified" },
    { verdict: "fail", evidence: "visible/review.txt: unsupported deployment claim" },
  ],
};

describe("parseAssessmentReport", () => {
  test("canonical rubric rows determine a failed overall result", () => {
    const parsed = parseAssessmentReport(canonicalReport, acceptanceCriteria);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.status).toBe("fail");
    expect(parsed.value.observations).toEqual([]);
    expect(parsed.value.criteria.map((row) => row.criterion)).toEqual([
      "Identify the required defect",
      "Keep all material findings grounded",
    ]);
  });

  for (const [verdicts, expectedStatus] of [
    [["pass"], "pass"],
    [["pass", "fail"], "fail"],
    [["pass", "unclear"], "investigate"],
    [["unclear"], "investigate"],
    [["fail", "unclear"], "fail"],
    [["pass", "pass", "pass", "fail"], "fail"],
  ] as const) {
    test(`derives ${verdicts.join("/")} as ${expectedStatus}`, () => {
      const criteria = verdicts.map((verdict) => ({ verdict, evidence: "visible/review.txt: observed" }));
      const rubric = verdicts.map((_, index) => `Criterion ${index + 1}`);

      const parsed = parseAssessmentReport({
        summary: "Review delivered",
        reasoning: "Each criterion was assessed from retained evidence.",
        criteria,
      }, rubric);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(parsed.value.status).toBe(expectedStatus);
    });
  }

  test("preserves valid observations and evidence while attaching canonical criteria", () => {
    const parsed = parseAssessmentReport({
      ...canonicalReport,
      observations: [{ kind: "bug", description: "Unsupported claim in the review" }],
    }, acceptanceCriteria);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.observations).toEqual([
      { kind: "bug", description: "Unsupported claim in the review" },
    ]);
    expect(parsed.value.criteria).toEqual([
      {
        criterion: "Identify the required defect",
        verdict: "pass",
        evidence: "visible/review.txt: required defect identified",
      },
      {
        criterion: "Keep all material findings grounded",
        verdict: "fail",
        evidence: "visible/review.txt: unsupported deployment claim",
      },
    ]);
  });

  test.each([
    ["zero acceptance criteria", canonicalReport, []],
    ["absent criteria", { summary: canonicalReport.summary, reasoning: canonicalReport.reasoning }, acceptanceCriteria],
    ["short criteria", { ...canonicalReport, criteria: canonicalReport.criteria.slice(0, 1) }, acceptanceCriteria],
    ["extra criteria", {
      ...canonicalReport,
      criteria: [
        ...canonicalReport.criteria,
        { verdict: "pass", evidence: "visible/review.txt: extra row" },
      ],
    }, acceptanceCriteria],
    ["string-encoded criteria", { ...canonicalReport, criteria: JSON.stringify(canonicalReport.criteria) }, acceptanceCriteria],
    ["nonobject row", { ...canonicalReport, criteria: [canonicalReport.criteria[0], "fail"] }, acceptanceCriteria],
    ["invalid verdict", {
      ...canonicalReport,
      criteria: [canonicalReport.criteria[0], { verdict: "errored", evidence: "visible/review.txt: observed" }],
    }, acceptanceCriteria],
    ["blank evidence", {
      ...canonicalReport,
      criteria: [canonicalReport.criteria[0], { verdict: "fail", evidence: "  " }],
    }, acceptanceCriteria],
    ["top-level status", { ...canonicalReport, status: "fail" }, acceptanceCriteria],
    ["row-level criterion", {
      ...canonicalReport,
      criteria: [
        { ...canonicalReport.criteria[0], criterion: acceptanceCriteria[0] },
        canonicalReport.criteria[1],
      ],
    }, acceptanceCriteria],
  ] as const)("rejects %s", (_name, value, rubric) => {
    expect(parseAssessmentReport(value, rubric).ok).toBe(false);
  });

  test.each([[null], [[]], ["report"]] as const)("rejects nonobject input: %p", (value) => {
    expect(parseAssessmentReport(value, acceptanceCriteria).ok).toBe(false);
  });

  test("allows repeated valid verdicts and evidence", () => {
    const repeated = { verdict: "pass" as const, evidence: "visible/review.txt: observed" };
    const parsed = parseAssessmentReport({
      summary: "Review delivered",
      reasoning: "Both criteria use the same retained evidence.",
      criteria: [repeated, repeated],
    }, acceptanceCriteria);

    expect(parsed.ok).toBe(true);
  });
});

test("assessment report tool exposes only model-authored assessment fields", () => {
  const parameters = ASSESSMENT_REPORT_TOOL.parameters as {
    properties: Record<string, { properties?: Record<string, unknown> }>;
    required: string[];
  };

  expect(parameters.required).toEqual(["summary", "reasoning", "criteria"]);
  expect(Object.keys(parameters.properties)).toEqual([
    "summary", "observations", "criteria", "reasoning",
  ]);
  expect(parameters.properties.criteria.properties).toBeUndefined();
  const criteria = parameters.properties.criteria as {
    items: { properties: Record<string, unknown>; required: string[] };
  };
  expect(Object.keys(criteria.items.properties)).toEqual(["verdict", "evidence"]);
  expect(criteria.items.required).toEqual(["verdict", "evidence"]);
});

test("deriveAssessmentStatus rejects an empty rubric", () => {
  expect(() => deriveAssessmentStatus([])).toThrow("Assessment requires criteria");
});

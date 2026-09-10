import { describe, expect, test } from "bun:test";
import {
  ASSESSMENT_REPORT_TOOL,
  deriveAssessmentStatus,
  parseAssessmentReport,
  recoverCriteriaFromReasoning,
} from "../../src/assessment/report";

const acceptanceCriteria = [
  "Identify the required defect",
  "Keep all material findings grounded",
] as const;
const exposedEvidencePaths = new Set(["visible/review.txt"]);

function submission(
  verdicts: readonly ("pass" | "fail" | "unclear")[] = ["pass", "fail"],
) {
  return {
    summary: "Review delivered",
    reasoning: "The retained evidence supports the submitted verdicts.",
    criteria: verdicts.map((verdict) => ({
      verdict,
      observation: "The review states the relevant behavior.",
      basis: "This directly bears on the corresponding acceptance criterion.",
      limitations: "Only the retained review was available.",
      references: ["visible/review.txt"],
    })),
  };
}

describe("parseAssessmentReport", () => {
  test.each([
    ["pass", "pass"],
    ["fail", "fail"],
    ["unclear", "investigate"],
  ] as const)("accepts a canonical %s row and derives %s", (verdict, status) => {
    const parsed = parseAssessmentReport(
      submission([verdict]),
      [acceptanceCriteria[0]],
      exposedEvidencePaths,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.status).toBe(status);
    expect(parsed.value.criteria).toEqual([{
      criterion: acceptanceCriteria[0],
      verdict,
      evidence: [
        "Observation: The review states the relevant behavior.",
        "Basis: This directly bears on the corresponding acceptance criterion.",
        "Limitations: Only the retained review was available.",
        "Sources: visible/review.txt",
      ].join("\n"),
    }]);
  });

  test("preserves valid observations while attaching canonical criteria", () => {
    const parsed = parseAssessmentReport({
      ...submission(),
      observations: [{ kind: "bug", description: "Unsupported claim in the review" }],
    }, acceptanceCriteria, exposedEvidencePaths);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.observations).toEqual([
      { kind: "bug", description: "Unsupported claim in the review" },
    ]);
    expect(parsed.value.criteria.map((row) => row.criterion)).toEqual(acceptanceCriteria);
  });

  test.each([
    ["missing observation", { observation: undefined }],
    ["blank observation", { observation: "  " }],
    ["missing basis", { basis: undefined }],
    ["blank basis", { basis: "  " }],
    ["missing limitations", { limitations: undefined }],
    ["blank limitations", { limitations: "  " }],
  ] as const)("rejects %s", (_name, replacement) => {
    const value = submission(["pass"]);
    value.criteria[0] = { ...value.criteria[0], ...replacement } as typeof value.criteria[0];

    expect(parseAssessmentReport(value, [acceptanceCriteria[0]], exposedEvidencePaths).ok)
      .toBe(false);
  });

  test.each([
    ["missing references", undefined],
    ["empty references", []],
    ["non-array references", "visible/review.txt"],
    ["non-string reference", [7]],
    ["blank reference", ["  "]],
    ["unread reference", ["visible/unread.txt"]],
    ["one valid and one invalid reference", ["visible/review.txt", "visible/unread.txt"]],
  ] as const)("rejects %s", (_name, references) => {
    const value = submission(["pass"]);
    value.criteria[0] = { ...value.criteria[0], references } as typeof value.criteria[0];

    expect(parseAssessmentReport(value, [acceptanceCriteria[0]], exposedEvidencePaths).ok)
      .toBe(false);
  });

  test.each([
    ["zero acceptance criteria", submission(), []],
    ["absent criteria", { summary: "Review", reasoning: "Grounded" }, acceptanceCriteria],
    ["missing row", { ...submission(), criteria: submission().criteria.slice(0, 1) }, acceptanceCriteria],
    ["extra row", { ...submission(), criteria: [...submission().criteria, submission(["pass"]).criteria[0]] }, acceptanceCriteria],
    ["string-encoded criteria", { ...submission(), criteria: JSON.stringify(submission().criteria) }, acceptanceCriteria],
    ["nonobject row", { ...submission(), criteria: [submission().criteria[0], "fail"] }, acceptanceCriteria],
    ["invalid verdict", { ...submission(), criteria: [submission().criteria[0], { ...submission().criteria[1], verdict: "errored" }] }, acceptanceCriteria],
    ["old evidence field", { ...submission(["pass"]), criteria: [{ verdict: "pass", evidence: "visible/review.txt: observed" }] }, [acceptanceCriteria[0]]],
    ["top-level status", { ...submission(), status: "fail" }, acceptanceCriteria],
    ["row-level criterion", { ...submission(), criteria: [{ ...submission().criteria[0], criterion: acceptanceCriteria[0] }, submission().criteria[1]] }, acceptanceCriteria],
  ] as const)("rejects %s", (_name, value, rubric) => {
    expect(parseAssessmentReport(value, rubric, exposedEvidencePaths).ok).toBe(false);
  });

  test.each([[null], [[]], ["report"]] as const)("rejects nonobject input: %p", (value) => {
    expect(parseAssessmentReport(value, acceptanceCriteria, exposedEvidencePaths).ok).toBe(false);
  });

  test("allows repeated valid rows", () => {
    const repeated = submission(["pass"]).criteria[0];
    const parsed = parseAssessmentReport({
      summary: "Review delivered",
      reasoning: "Both criteria use the same retained evidence.",
      criteria: [repeated, repeated],
    }, acceptanceCriteria, exposedEvidencePaths);

    expect(parsed.ok).toBe(true);
  });
});

test("assessment report tool exposes only model-authored assessment fields", () => {
  const parameters = ASSESSMENT_REPORT_TOOL.parameters as {
    properties: Record<string, {
      description?: string;
      properties?: Record<string, unknown>;
    }>;
    required: string[];
  };

  expect(parameters.required).toEqual(["summary", "reasoning", "criteria"]);
  expect(Object.keys(parameters.properties)).toEqual([
    "summary", "observations", "criteria", "reasoning",
  ]);
  expect(parameters.properties.criteria.properties).toBeUndefined();
  const criteria = parameters.properties.criteria as {
    description: string;
    items: {
      properties: Record<string, { description?: string }>;
      required: string[];
    };
  };
  expect(Object.keys(criteria.items.properties)).toEqual([
    "verdict", "observation", "basis", "limitations", "references",
  ]);
  expect(criteria.items.required).toEqual([
    "verdict", "observation", "basis", "limitations", "references",
  ]);
  expect(criteria.description).toMatch(/native array.*not.*reasoning/i);
  expect(parameters.properties.reasoning.description).toMatch(
    /concise overall synthesis.*criteria array/i,
  );
  expect(criteria.items.properties.basis.description).toMatch(
    /obligation.*entities.*conditions.*relationships/i,
  );
  expect(criteria.items.properties.limitations.description).toMatch(
    /complete inspected delivery.*omits.*unavailable evidence/i,
  );
});

test("deriveAssessmentStatus rejects an empty rubric", () => {
  expect(() => deriveAssessmentStatus([])).toThrow("Assessment requires criteria");
});

describe("recoverCriteriaFromReasoning", () => {
  const rows = submission(["pass", "fail"]).criteria;
  const rowsJson = JSON.stringify(rows);

  test("recovers a <criteria> block after a stray closing reasoning tag", () => {
    const recovered = recoverCriteriaFromReasoning(
      `Synthesis text.</reasoning> <criteria>${rowsJson}</criteria>`,
    );
    expect(recovered).toEqual({ rows, wrapper: "<criteria>", reasoning: "Synthesis text." });
  });

  test('recovers a <parameter name="criteria"> block followed by </invoke>', () => {
    const recovered = recoverCriteriaFromReasoning(
      `Synthesis text.</parameter> <parameter name="criteria">${rowsJson}</parameter> </invoke>`,
    );
    expect(recovered).toEqual({
      rows,
      wrapper: '<parameter name="criteria">',
      reasoning: "Synthesis text.",
    });
  });

  test("recovers an unclosed <criteria> block that runs to the end of the string", () => {
    const recovered = recoverCriteriaFromReasoning(
      `Synthesis text.</reasoning> <criteria>${rowsJson}`,
    );
    expect(recovered).toEqual({ rows, wrapper: "<criteria>", reasoning: "Synthesis text." });
  });

  test("returns undefined without a criteria tag or when the block is not a JSON array", () => {
    expect(recoverCriteriaFromReasoning("Plain synthesis with no block.")).toBeUndefined();
    expect(recoverCriteriaFromReasoning("<criteria>not json</criteria>")).toBeUndefined();
    expect(recoverCriteriaFromReasoning('<criteria>{"verdict":"pass"}</criteria>')).toBeUndefined();
  });
});

import { REPORT_TOOL } from "../agent/agent";
import { parseReportResult, type ParseResult } from "../agent/validators";
import type { ToolDefinition } from "../models/provider";
import type { CriterionVerdict, Observation, VetStatus } from "../types";

export interface AssessmentReport {
  status: Exclude<VetStatus, "errored">;
  summary: string;
  reasoning: string;
  observations: Observation[];
  criteria: CriterionVerdict[];
}

const CRITERION_VERDICTS: readonly CriterionVerdict["verdict"][] = [
  "pass",
  "fail",
  "unclear",
];

const reportProperties = (
  REPORT_TOOL.parameters as { properties: Record<string, unknown> }
).properties;
const reportReasoning = reportProperties.reasoning as Record<string, unknown>;
const reportCriterionProperties = (
  reportProperties.criteria as {
    items: { properties: Record<string, unknown> };
  }
).items.properties;

export type AssessmentCriterionSubmission = {
  verdict: CriterionVerdict["verdict"];
  observation: string;
  basis: string;
  limitations: string;
  references: string[];
};

export const ASSESSMENT_REPORT_TOOL: ToolDefinition = {
  name: "report_result",
  description: "Report your assessment result. Call this when you are done assessing.",
  parameters: {
    type: "object",
    properties: {
      summary: reportProperties.summary,
      observations: reportProperties.observations,
      criteria: {
        type: "array",
        description:
          "One independent judgment per acceptance criterion, in the supplied order. " +
          "Pass as a native array here, not as JSON text or tags inside reasoning.",
        items: {
          type: "object",
          properties: {
            verdict: reportCriterionProperties.verdict,
            observation: {
              type: "string",
              description: "What the retained evidence directly shows.",
            },
            basis: {
              type: "string",
              description:
                "Why the observation supports this verdict for the criterion as stated. " +
                "Preserve its obligation, entities, conditions, and relationships; identify any inference.",
            },
            limitations: {
              type: "string",
              description:
                "Contrary evidence or missing context and how it affects this verdict. " +
                "Distinguish a complete inspected delivery that omits a requirement from unavailable evidence.",
            },
            references: {
              type: "array",
              description: "One or more exact paths successfully read in an earlier turn.",
              items: { type: "string" },
            },
          },
          required: ["verdict", "observation", "basis", "limitations", "references"],
        },
      },
      reasoning: {
        ...reportReasoning,
        description:
          "Concise overall synthesis of the assessment. Put criterion judgments in the " +
          "top-level native criteria array, not inside this string.",
      },
    },
    required: ["summary", "reasoning", "criteria"],
  },
};

export function formatAssessmentReportRejection(
  reason: string,
  criterionCount: number,
): string {
  const illustrativeShape = {
    summary: "<concise assessment summary>",
    reasoning: "<concise overall synthesis>",
    criteria: [{
      verdict: "<pass | fail | unclear>",
      observation: "<what retained evidence directly shows>",
      basis: "<why the evidence supports this criterion judgment>",
      limitations: "<contrary evidence or missing context>",
      references: ["<successfully read evidence path>"],
    }],
  };
  return [
    `Error: report_result rejected: ${reason}`,
    "criteria must be a top-level array alongside summary and reasoning. " +
      "XML tags or JSON text inside a string do not provide tool arguments.",
    `Your resubmission must contain exactly ${criterionCount} criteria rows, one per ` +
      "acceptance criterion in the supplied order.",
    "You must resubmit the complete object through report_result. This JSON shows the " +
      "required shape with one illustrative criterion row:",
    "```json",
    JSON.stringify(illustrativeShape, null, 2),
    "```",
  ].join("\n");
}

export function deriveAssessmentStatus(
  criteria: readonly CriterionVerdict[],
): AssessmentReport["status"] {
  if (criteria.length === 0) throw new Error("Assessment requires criteria");
  if (criteria.some((row) => row.verdict === "fail")) return "fail";
  return criteria.every((row) => row.verdict === "pass") ? "pass" : "investigate";
}

export function parseAssessmentReport(
  value: unknown,
  acceptanceCriteria: readonly string[],
  exposedEvidencePaths: ReadonlySet<string>,
): ParseResult<AssessmentReport> {
  if (!isRecord(value)) {
    return { ok: false, reason: `expected object, got ${typeName(value)}` };
  }
  if (Object.hasOwn(value, "status")) {
    return { ok: false, reason: "status: must not be supplied; it is derived from criteria" };
  }
  if (acceptanceCriteria.length === 0) {
    return { ok: false, reason: "criteria: assessment requires at least one acceptance criterion" };
  }
  if (!Array.isArray(value.criteria)) {
    return { ok: false, reason: `criteria: expected array, got ${typeName(value.criteria)}` };
  }
  if (value.criteria.length !== acceptanceCriteria.length) {
    return {
      ok: false,
      reason:
        `criteria: expected ${acceptanceCriteria.length} entries (one per ` +
        `acceptance criterion, in order), got ${value.criteria.length}`,
    };
  }

  const criteria: CriterionVerdict[] = [];
  for (let i = 0; i < value.criteria.length; i++) {
    const row = value.criteria[i];
    if (!isRecord(row)) {
      return { ok: false, reason: `criteria[${i}]: expected object, got ${typeName(row)}` };
    }
    if (Object.hasOwn(row, "criterion")) {
      return {
        ok: false,
        reason: `criteria[${i}].criterion: must not be supplied; canonical text is attached by position`,
      };
    }
    if (
      typeof row.verdict !== "string" ||
      !CRITERION_VERDICTS.includes(row.verdict as CriterionVerdict["verdict"])
    ) {
      return {
        ok: false,
        reason:
          `criteria[${i}].verdict: "${String(row.verdict)}" not in ` +
          `[${CRITERION_VERDICTS.join(", ")}]`,
      };
    }
    for (const field of ["observation", "basis", "limitations"] as const) {
      if (typeof row[field] !== "string" || row[field].trim() === "") {
        return {
          ok: false,
          reason: `criteria[${i}].${field}: must be a non-empty string`,
        };
      }
    }
    if (!Array.isArray(row.references) || row.references.length === 0) {
      return {
        ok: false,
        reason: `criteria[${i}].references: must be a non-empty array`,
      };
    }
    for (let referenceIndex = 0; referenceIndex < row.references.length; referenceIndex++) {
      const reference = row.references[referenceIndex];
      if (typeof reference !== "string" || reference.trim() === "") {
        return {
          ok: false,
          reason:
            `criteria[${i}].references[${referenceIndex}]: must be a non-empty string`,
        };
      }
      if (!exposedEvidencePaths.has(reference)) {
        return {
          ok: false,
          reason:
            `criteria[${i}].references[${referenceIndex}]: evidence path has not been read: ${reference}`,
        };
      }
    }
    const submission = row as unknown as AssessmentCriterionSubmission;
    const evidence = [
      `Observation: ${submission.observation}`,
      `Basis: ${submission.basis}`,
      `Limitations: ${submission.limitations}`,
      `Sources: ${submission.references.join(", ")}`,
    ].join("\n");
    criteria.push({
      criterion: acceptanceCriteria[i],
      verdict: row.verdict as CriterionVerdict["verdict"],
      evidence,
    });
  }

  const core = parseReportResult({
    ...value,
    status: deriveAssessmentStatus(criteria),
    criteria,
  });
  if (!core.ok) return core;
  return { ok: true, value: { ...core.value, criteria } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

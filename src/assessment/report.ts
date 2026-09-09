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
const reportCriterionProperties = (
  reportProperties.criteria as {
    items: { properties: Record<string, unknown> };
  }
).items.properties;

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
          "One verdict per acceptance criterion, in the supplied order. Pass as an array literal, not a JSON string.",
        items: {
          type: "object",
          properties: {
            verdict: reportCriterionProperties.verdict,
            evidence: reportCriterionProperties.evidence,
          },
          required: ["verdict", "evidence"],
        },
      },
      reasoning: reportProperties.reasoning,
    },
    required: ["summary", "reasoning", "criteria"],
  },
};

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
    if (typeof row.evidence !== "string" || row.evidence.trim() === "") {
      return {
        ok: false,
        reason: `criteria[${i}].evidence: must be a non-empty string`,
      };
    }
    criteria.push({
      criterion: acceptanceCriteria[i],
      verdict: row.verdict as CriterionVerdict["verdict"],
      evidence: row.evidence,
    });
  }

  const core = parseReportResult({ ...value, status: deriveAssessmentStatus(criteria) });
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

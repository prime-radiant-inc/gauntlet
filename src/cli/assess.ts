import { readFileSync } from "node:fs";
import { assessmentClock, finalizeAssessment, runAssessment } from "../assessment/assess";
import { assessmentDeadline } from "../assessment/lifecycle";
import { parseEvidenceIndex } from "../context/scoped-read";
import { EvidenceLogger } from "../evidence/logger";
import { parseStoryCard } from "../format/story-card";
import { createAssessmentAttemptJournal } from "../models/assessment-request";
import { createClient, resolveProvider } from "../models/resolve";
import { RESULT_SCHEMA_VERSION, type VetResult } from "../types";
import type { AssessArgs } from "./args";

export function assessmentExitCode(result: VetResult): 0 | 1 {
  return result.status === "pass" ? 0 : 1;
}
export async function assess(args: AssessArgs): Promise<VetResult> {
  // Anchor before parsing inputs or constructing a client. Passing this absolute
  // hard deadline into the loop prevents startup from creating a fresh allowance.
  const now = assessmentClock();
  const startedAt = now();
  const deadline = assessmentDeadline({ nowMs: startedAt, maxTimeMs: args.maxTimeMs, reportGraceMs: args.reportGraceMs, hardDeadlineAtMs: args.hardDeadlineAtMs });
  const controller = new AbortController();
  const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map(signal => {
    const handler = () => controller.abort(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    const logger = new EvidenceLogger(args.outDir);
    let journal: ReturnType<typeof createAssessmentAttemptJournal> | undefined;
    let inputs;
    try {
      const provider = resolveProvider(args.model);
      logger.logRunStart({
        runId: args.runId, cardId: args.cardId, target: undefined, provider,
        model: args.model, adapter: "assessment", budgetMs: args.maxTimeMs,
        reflectionInterval: 0, toolTimeoutMs: 30_000, contextTreeBytes: 0, outDir: args.outDir,
      });
      // Physical admission includes the final report; per-request cancellation
      // ends inspection earlier without spending the report opportunity.
      journal = createAssessmentAttemptJournal({
        outDir: args.outDir, provider, model: args.model, now,
        workDeadlineAtMs: deadline.reportDeadlineAtMs, fetch, captureBodies: false, logger,
      });
      inputs = {
        rubric: parseStoryCard(readFileSync(args.rubricPath, "utf8")),
        evidenceIndex: parseEvidenceIndex(JSON.parse(readFileSync(args.evidenceIndexPath, "utf8")) as unknown),
        client: createClient(args.model),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const result: VetResult = {
        schemaVersion: RESULT_SCHEMA_VERSION, runId: args.runId, scenario: args.cardId,
        status: "investigate", summary: "Assessment failed", reasoning: reason, observations: [],
        evidence: { screenshots: [], log: logger.logPath }, duration_ms: now() - startedAt,
        usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
      };
      try {
        finalizeAssessment({ outDir: args.outDir, result, logger, attemptJournal: journal,
          decision: { kind: "errored", atMs: now(), reason } });
      } catch (publicationError) {
        throw new AggregateError([error, publicationError], `${reason}; ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`);
      }
      throw error;
    }
    return await runAssessment({
      ...inputs, evidenceRoot: args.evidenceRoot, outDir: args.outDir, logger,
      runId: args.runId, maxTimeMs: args.maxTimeMs, reportGraceMs: args.reportGraceMs,
      hardDeadlineAtMs: deadline.hardDeadlineAtMs, now, signal: controller.signal, attemptJournal: journal,
    });
  } finally {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  }
}

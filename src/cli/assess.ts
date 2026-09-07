import { readFileSync } from "node:fs";
import { runAssessment } from "../assessment/assess";
import { parseEvidenceIndex } from "../context/scoped-read";
import { EvidenceLogger } from "../evidence/logger";
import { parseStoryCard } from "../format/story-card";
import { createClient, resolveProvider } from "../models/resolve";
import type { VetResult } from "../types";
import type { AssessArgs } from "./args";

export function assessmentExitCode(result: VetResult): 0 | 1 {
  return result.status === "pass" ? 0 : 1;
}
export async function assess(args: AssessArgs): Promise<VetResult> {
  const rubric = parseStoryCard(readFileSync(args.rubricPath, "utf8"));
  const evidenceIndex = parseEvidenceIndex(
    JSON.parse(readFileSync(args.evidenceIndexPath, "utf8")) as unknown,
  );
  const provider = resolveProvider(args.model);
  const client = createClient(args.model);
  const logger = new EvidenceLogger(args.outDir);
  logger.logRunStart({
    runId: args.runId,
    cardId: args.cardId,
    target: undefined,
    provider,
    model: args.model,
    adapter: "assessment",
    budgetMs: args.maxTimeMs,
    reflectionInterval: 0,
    toolTimeoutMs: 30_000,
    contextTreeBytes: 0,
    outDir: args.outDir,
  });
  return runAssessment({
    rubric,
    evidenceRoot: args.evidenceRoot,
    evidenceIndex,
    outDir: args.outDir,
    client,
    logger,
    runId: args.runId,
    maxTimeMs: args.maxTimeMs,
  });
}

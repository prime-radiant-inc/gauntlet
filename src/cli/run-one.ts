import { readFileSync } from "fs";
import { parseStoryCard } from "../format/story-card";
import type { EvidenceLogger } from "../evidence/logger";
import { createClient } from "../models/resolve";
import { executeRunCore, type RunAdapterType } from "../runs/orchestrator";
import type { AppConfig } from "../config";
import type { LLMClient } from "../models/provider";
import type { VetResult } from "../types";
import type { RunSetCtx } from "../runs/run-set-types";
import type { RunId } from "../util/brands";

export interface RunOneOptions {
  scenarioPath: string;
  target: string;
  outDir?: string;
  adapterType: RunAdapterType;
  config: AppConfig;
  /** Invoked once with the freshly constructed EvidenceLogger, before
   * runAgent starts. Returns a detach function that runs after the
   * adapter is closed. The single-card command uses this to attach the
   * streaming renderer; batch.ts uses it to subscribe its per-card
   * observer. */
  onLogger?: (logger: EvidenceLogger) => () => void;
  runSetCtx?: RunSetCtx;
  /** Externally-supplied runId (from the orchestrator). When provided,
   * this overrides the `makeRunId(card.id)` call so the run directory
   * name matches what the RunSet manifest already recorded. */
  runId?: RunId;
  /** Test seam: substitute the LLM client construction. Production callers
   * leave this undefined and the shim falls through to `createClient`.
   * Tests inject a scripted client here instead of `mock.module`-ing
   * `models/resolve` (PRI-1505). */
  clientFactory?: (model: string) => LLMClient;
  /** Optional explicit Project prompt path. Forwarded to `executeRunCore`
   * which resolves it via `resolveProjectPrompt`. Undefined means "fall
   * through to .gauntlet/project.md auto-load". */
  projectPromptPath?: string;
  tuiInputGuardPath?: string;
}

export interface RunOneSummary {
  runId: RunId;
  outDir: string;
  result: VetResult;
}

export async function runOne(opts: RunOneOptions): Promise<RunOneSummary> {
  const { scenarioPath, target, adapterType, config } = opts;

  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);

  const client = (opts.clientFactory ?? createClient)(config.models.agent);
  const chrome = config.sources.defaultChrome === "default"
    ? undefined
    : config.defaultChrome;

  return executeRunCore({
    card,
    storyPath: scenarioPath,
    runId: opts.runId,
    outDir: opts.outDir,
    client,
    runSetCtx: opts.runSetCtx,
    projectPromptPath: opts.projectPromptPath,
    tuiInputGuardPath: opts.tuiInputGuardPath,
    runConfig: {
      projectRoot: config.projectRoot,
      stateDirName: config.stateDirName,
      model: config.models.agent,
      adapter: adapterType,
      target,
      budgetMs: config.defaultBudgetMs,
      reflectionInterval: config.defaultReflectionInterval,
      chrome,
      viewport: config.defaultViewport,
      saveScreencast: config.defaultSaveScreencast,
      credentialResolver: config.credentialResolver,
    },
    hooks: opts.onLogger
      ? { onLogger: (logger) => opts.onLogger!(logger) }
      : undefined,
  });
}

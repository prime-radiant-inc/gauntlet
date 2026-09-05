import { readFileSync } from "fs";
import { runOne } from "./run-one";
import { safeEmitIndexHtml } from "./auto-emit-html";
import { attachRenderer } from "./stream/attach";
import { resolveStreamOptions } from "./stream/format";
import { runRunSet } from "../runs/run-set";
import { installSigintHandler } from "./signals";
import { gauntletPath } from "../paths";
import { parseStoryCard } from "../format/story-card";
import { BatchTableRenderer } from "./stream/batch-table";
import type { AppConfig } from "../config";
import type { EvidenceLogger, EventObserver } from "../evidence/logger";
import type { LLMClient } from "../models/provider";
import type { RunSetCtx } from "../runs/run-set-types";
import type { WriteSink } from "./stream/jsonl";

export interface RunCommandOptions {
  scenarioPath: string;
  target: string;
  outDir?: string;
  adapterType: "web" | "cli" | "tui";
  config: AppConfig;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
  passes: number;
  /** Test seam — see PRI-1505. Production callers leave this undefined; the
   * runOne calls below thread it through so tests don't need mock.module. */
  clientFactory?: (model: string) => LLMClient;
  /** Optional path to a Project prompt augmentation file. Forwarded to
   * `runOne`; resolution lives in the orchestrator. */
  projectPromptPath?: string;
  tuiInputGuardPath?: string;
}

function makeRunObserver(
  table: BatchTableRenderer | null,
  format: "pretty" | "jsonl" | undefined,
  silent: boolean,
  sink: WriteSink,
  cardId: string,
  runSetCtx: RunSetCtx,
): (logger: EvidenceLogger) => () => void {
  const { attemptNumber, passes } = runSetCtx;
  return (logger: EvidenceLogger) => {
    let currentRunId: string | null = null;
    const observer: EventObserver = (ev) => {
      const t = ev.type as string;
      if (t === "run_start") {
        currentRunId = String((ev as any).runId);
        if (table) {
          table.setRunning(
            cardId,
            currentRunId,
            attemptNumber,
            passes,
          );
        }
      } else if (t === "llm_response") {
        if (table) table.onTurn(cardId, Number((ev as any).turn ?? 0), attemptNumber);
      } else if (t === "run_end") {
        const status = String((ev as any).status ?? "fail") as "pass" | "fail" | "investigate";
        const turns = Number(((ev as any).usage?.turns) ?? 0);
        if (table) table.setDone(cardId, status, turns, attemptNumber);
      }

      if (format === "jsonl" && !silent) {
        const enriched = { runId: currentRunId, ...ev };
        sink.write(JSON.stringify(enriched) + "\n");
      }
    };
    return logger.addEventObserver(observer);
  };
}

// LLM-capable gate is enforced by the dispatch site (src/index.ts via
// requireLlmCapableOrExit). This function assumes a valid AppConfig.
export async function run(opts: RunCommandOptions): Promise<void> {
  if (opts.passes === 1) {
    // existing behavior, unchanged
    const streamOpts = resolveStreamOptions({
      isTTY: Boolean(process.stdout.isTTY),
      env: process.env as Record<string, string | undefined>,
      silent: opts.silent,
      format: opts.format,
      noColor: opts.noColor,
      columns: process.stdout.columns ?? 100,
    });
    const sink = { write: (s: string) => process.stdout.write(s) };

    const { runId, outDir } = await runOne({
      scenarioPath: opts.scenarioPath,
      target: opts.target,
      outDir: opts.outDir,
      adapterType: opts.adapterType,
      config: opts.config,
      onLogger: (logger) => attachRenderer(logger, streamOpts, sink),
      clientFactory: opts.clientFactory,
      projectPromptPath: opts.projectPromptPath,
      tuiInputGuardPath: opts.tuiInputGuardPath,
    });

    await safeEmitIndexHtml(outDir);

    if (streamOpts.silent) {
      console.error(`runId: ${runId}`);
    }
    // Streaming mode: run_end panel already printed the runId via the renderer.
    return;
  }

  // Multi-pass: route through RunSet orchestrator.
  const content = readFileSync(opts.scenarioPath, "utf-8");
  const card = parseStoryCard(content);

  const gauntletRoot = gauntletPath(opts.config.projectRoot, opts.config.stateDirName);
  const resultsRoot = gauntletPath(opts.config.projectRoot, opts.config.stateDirName, "results");

  const sink = { write: (s: string) => process.stdout.write(s) };
  const useTable = !opts.silent && opts.format !== "jsonl";
  const table = useTable
    ? new BatchTableRenderer(sink, {
        isTTY: Boolean(process.stdout.isTTY),
        color: !opts.noColor && Boolean(process.stdout.isTTY),
        columns: process.stdout.columns ?? 100,
        target: opts.target,
        resultsRoot,
      })
    : null;

  const onAllRunsKnown = (
    runs: Array<{ runId: string; cardId: string; attemptNumber: number }>,
  ) => {
    if (table) {
      for (const r of runs) {
        table.setQueued(r.cardId, r.attemptNumber, opts.passes);
      }
    }
  };

  const cancelToken = { cancelled: false };
  const detach = installSigintHandler(cancelToken);
  let setResult;
  try {
    const handle = await runRunSet({
      resultsRoot: gauntletRoot,
      cards: [card.id],
      passes: opts.passes,
      kind: "single",
      onAllRunsKnown,
      cancelToken,
      executor: async ({ cardId, runSetCtx, runId }) => {
        const onLogger = makeRunObserver(
          table,
          opts.format,
          opts.silent,
          sink,
          cardId,
          runSetCtx,
        );
        try {
          const summary = await runOne({
            scenarioPath: opts.scenarioPath,
            target: opts.target,
            adapterType: opts.adapterType,
            config: opts.config,
            onLogger,
            runSetCtx,
            runId,
            clientFactory: opts.clientFactory,
            projectPromptPath: opts.projectPromptPath,
            tuiInputGuardPath: opts.tuiInputGuardPath,
          });
          await safeEmitIndexHtml(summary.outDir);
          return summary;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (table) table.setErrored(cardId, null, msg, runSetCtx.attemptNumber);
          throw err;
        }
      },
    });
    setResult = await handle.completion;
  } finally {
    detach();
  }
  if (cancelToken.cancelled) process.exit(130);

  if (table) {
    table.finalize();
  } else if (opts.silent) {
    const by = setResult.summary?.overall.byStatus;
    const pass = by?.pass ?? 0;
    const fail = by?.fail ?? 0;
    const investigate = by?.investigate ?? 0;
    const errored = by?.errored ?? 0;
    console.error(
      `run: ${pass} pass · ${fail} fail · ${investigate} investigate · ${errored} errored`,
    );
    console.error(`results: ${resultsRoot}`);
  }
}

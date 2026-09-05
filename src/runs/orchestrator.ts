import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { CLIAdapter } from "../adapters/cli/adapter";
import { snapshotViewport, type Adapter } from "../adapters/adapter";
import type { ChromeEndpoint, CredentialResolverConfig, ResolvedRunConfig, Viewport } from "../config";
import type { RunId } from "../util/brands";
import { renderContextTree } from "../context/tree";
import { EvidenceLogger } from "../evidence/logger";
import { writeResultFiles } from "../evidence/writer";
import { runAgent } from "../agent/agent";
import { resolveProvider } from "../models/resolve";
import type { LLMClient } from "../models/provider";
import { gauntletPath } from "../paths";
import { snapshotRunInputs } from "./snapshot";
import { makeRunId } from "../util/id";
import type { StoryCard } from "../format/story-card";
import { snapshotRunConfig, type VetResult } from "../types";
import type { RunSetCtx } from "./run-set-types";

export type RunAdapterType = "web" | "cli" | "tui";

/**
 * Resolve the Project prompt block. Explicit path wins; otherwise look
 * for `<stateDirName>/project.md` in the project root; otherwise undefined.
 * Missing explicit path is a hard error (the caller asked for it).
 */
export function resolveProjectPrompt(
  projectRoot: string,
  stateDirName: string,
  explicitPath: string | undefined,
): string | undefined {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`--project-prompt file not found: ${explicitPath}`);
    }
    return readFileSync(explicitPath, "utf-8").replace(/\s+$/, "");
  }
  const defaultPath = gauntletPath(projectRoot, stateDirName, "project.md");
  if (existsSync(defaultPath)) {
    return readFileSync(defaultPath, "utf-8").replace(/\s+$/, "");
  }
  return undefined;
}

export interface RunCorePrepared {
  runId: RunId;
  outDir: string;
  card: StoryCard;
}

export interface RunCoreStarted extends RunCorePrepared {
  contextRoot: string;
  /** The started adapter. Hooks may read state (e.g., a WebAdapter's
   * chrome session for screencast wiring) but must not start, close, or
   * otherwise mutate the lifecycle — that is the core's job. */
  adapter: Adapter;
}

export interface RunCoreHooks {
  /** Attach observers to the freshly-built logger. Optional detach fn is
   * called after adapter close so close-time events still fan out. */
  onLogger?: (logger: EvidenceLogger, ctx: RunCorePrepared) => void | (() => void);
  beforeAgent?: (ctx: RunCoreStarted) => Promise<void> | void;
  onError?: (err: unknown, ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
  beforeClose?: (ctx: RunCoreStarted) => Promise<void> | void;
  afterClose?: (ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
}

export interface AdapterFactoryCtx {
  contextRoot: string;
  runId: RunId;
  logger: EvidenceLogger;
}

export interface ExecuteRunCoreOptions {
  card: StoryCard;
  storyPath: string;
  runId?: RunId;
  outDir?: string;
  runConfig: ResolvedRunConfig;
  /** Already-built client — surfaces resolve provider/allow-list before
   * calling the core so config errors stay on the request thread. */
  client: LLMClient;
  runSetCtx?: RunSetCtx;
  hooks?: RunCoreHooks;
  /** Test seam: substitute the adapter construction. Production callers
   * leave this undefined and the core builds the adapter from
   * `runConfig.adapter`. Tests inject stub adapters here instead of
   * `mock.module`-ing adapter modules globally. Mirrors the
   * `clientFactory?` pattern from PRI-1505. */
  adapterFactory?: (ctx: AdapterFactoryCtx) => Adapter | Promise<Adapter>;
  /** Optional explicit path to a Project prompt augmentation file. When
   * unset, `resolveProjectPrompt` falls through to `<state-dir>/project.md`
   * under `runConfig.projectRoot` (or no Project block if that's absent). */
  projectPromptPath?: string;
  tuiInputGuardPath?: string;
  /**
   * Optional cancellation signal forwarded to `runAgent`. When aborted,
   * the agent loop returns a synthetic `errored` VetResult; the
   * orchestrator's success path then writes `result.json` as normal.
   * The catch block is NOT involved — the load-bearing invariant
   * (spec §1) is that the agent returns rather than throws. Production
   * callers wire this from a per-run AbortController in the active-run
   * registry. PRI-1507.
   */
  abortSignal?: AbortSignal;
  /**
   * Test seam: substitute the result-file writer. Production callers
   * leave undefined and the core uses the imported `writeResultFiles`.
   * The seam exists so `test/runs/orchestrator-ordering.test.ts` can pin
   * the load-bearing invariant that result files are written BEFORE
   * `afterClose` runs (which is where the wrapper unregisters from the
   * active-run registry — the existsSync defense in the shutdown stub
   * writer depends on this ordering). PRI-1507.
   */
  writeResultFiles?: typeof writeResultFiles;
}

export interface ExecuteRunCoreResult {
  runId: RunId;
  outDir: string;
  result: VetResult;
}

function viewportString(v: Viewport | undefined): string | undefined {
  return v ? `${v.width}x${v.height}` : undefined;
}

async function buildDefaultAdapter(
  type: RunAdapterType,
  contextRoot: string,
  logger: EvidenceLogger,
  runId: RunId,
  runDir: string,
  chrome: ChromeEndpoint | undefined,
  viewport: Viewport | undefined,
  credentialResolver: CredentialResolverConfig | undefined,
  tuiInputGuardPath?: string,
): Promise<Adapter> {
  switch (type) {
    case "cli":
      return new CLIAdapter({ contextRoot, runDir, logger, credentialResolver });
    case "tui": {
      const { TUIAdapter } = await import("../adapters/tui/adapter");
      return new TUIAdapter({
        contextRoot, runDir, logger, credentialResolver,
        inputGuard: tuiInputGuardPath ? { path: tuiInputGuardPath, timeoutMs: 10_000 } : undefined,
      });
    }
    case "web": {
      const { WebAdapter } = await import("../adapters/web/adapter");
      return new WebAdapter({
        chrome,
        contextRoot,
        logger,
        chromeProfileName: `gauntlet-run-${runId}`,
        viewport,
        credentialResolver,
        runDir,
      });
    }
  }
}

export async function executeRunCore(
  opts: ExecuteRunCoreOptions,
): Promise<ExecuteRunCoreResult> {
  const { card, storyPath, runConfig, client, runSetCtx, hooks } = opts;

  const runId = opts.runId ?? makeRunId(card.id);
  const outDir = opts.outDir ?? gauntletPath(runConfig.projectRoot, runConfig.stateDirName, "results", runId);

  snapshotRunInputs({
    runDir: outDir,
    storyPath,
    contextRoot: gauntletPath(runConfig.projectRoot, runConfig.stateDirName, "context"),
  });

  const logger = new EvidenceLogger(outDir);
  const prepared: RunCorePrepared = { runId, outDir, card };
  const detachLogger = hooks?.onLogger?.(logger, prepared) ?? (() => {});

  const contextRoot = join(outDir, "inputs", "context");
  const contextTree = renderContextTree(contextRoot);
  const projectPrompt = resolveProjectPrompt(runConfig.projectRoot, runConfig.stateDirName, opts.projectPromptPath);

  const adapter = await (opts.adapterFactory
    ? opts.adapterFactory({ contextRoot, runId, logger })
    : buildDefaultAdapter(
        runConfig.adapter,
        contextRoot,
        logger,
        runId,
        outDir,
        runConfig.chrome,
        runConfig.viewport,
        runConfig.credentialResolver,
        opts.tuiInputGuardPath,
      ));

  try {
    await adapter.start(runConfig.target);
    const started: RunCoreStarted = { ...prepared, contextRoot, adapter };
    await hooks?.beforeAgent?.(started);

    const stampedRunConfig = snapshotRunConfig(runConfig, snapshotViewport(adapter));

    const result = await runAgent(card, adapter, client, logger, runConfig.target, {
      contextTree,
      projectPrompt,
      runId,
      budgetMs: runConfig.budgetMs,
      reflectionInterval: runConfig.reflectionInterval,
      provider: resolveProvider(runConfig.model),
      model: runConfig.model,
      outDir,
      viewport: runConfig.adapter === "web"
        ? viewportString(snapshotViewport(adapter))
        : undefined,
      abortSignal: opts.abortSignal,
    });
    result.config = stampedRunConfig;
    if (runSetCtx) result.runSet = runSetCtx;
    (opts.writeResultFiles ?? writeResultFiles)(outDir, result);

    await hooks?.beforeClose?.(started);
    try { await adapter.close(); } catch { /* swallow */ }
    detachLogger();
    await hooks?.afterClose?.(started);

    return { runId, outDir, result };
  } catch (err) {
    logger.logRunError({
      turn: -1,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const ctx: RunCoreStarted = { ...prepared, contextRoot, adapter };
    try { await hooks?.onError?.(err, ctx); } catch { /* swallow */ }
    try { await hooks?.beforeClose?.(ctx); } catch { /* swallow */ }
    try { await adapter.close(); } catch { /* swallow */ }
    detachLogger();
    try { await hooks?.afterClose?.(ctx); } catch { /* swallow */ }
    throw err;
  }
}

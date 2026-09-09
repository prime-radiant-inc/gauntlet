// Bump when result.json format changes in a way downstream consumers must notice.
// Documented in docs/format.md.
//
// v2: added optional `config` block capturing the per-run knobs (target,
//     model, adapter, chrome, budgetMs) so the UI can offer a "Run again"
//     action without re-eliciting the parameters.
// v3: RunConfigSnapshot.turns replaced with budgetMs (wall-clock budget
//     in ms) and maxStuckRetries (prompt-injected stuck-retry hint).
//     Reflects the time-budget loop replacing maxTurns. See
//     docs/superpowers/specs/2026-05-11-time-budget-and-stuck-detection-spec.md.
// v4: Removed maxStuckRetries (the stuck-handling system-prompt block it
//     templated into has been retired in favor of mid-loop reflection
//     checkpoints — see docs/reflection-checkpoints-spec.md, PRI-1569).
// v5: Added "errored" to VetStatus and optional error: {type, message}
//     field on VetResult. Today's only emitter is shutdown drain
//     (PRI-1507) — type is "shutdown_interrupted". The error.type field
//     is open-typed (string) so additive new categories don't require a
//     schema bump or TypeScript widening; consumers MUST tolerate
//     unknown types. For shutdown-stub results (the floor-of-quality
//     fallback when even the post-abort patience window expires),
//     duration_ms uses -1 as a sentinel meaning "registry entry was
//     missing startedAt at stub time".
export const RESULT_SCHEMA_VERSION = 5;

import type { RunSetCtx } from "./runs/run-set-types";
import type { ResolvedRunConfig, Viewport } from "./config";
import type { CardId, RunId } from "./util/brands";

export interface RunConfigSnapshot {
  target: string;
  model: string;
  adapter: "web" | "cli" | "tui";
  /** `host:port`, omitted when the adapter auto-launched Chrome. */
  chrome?: string;
  /** Wall-clock budget in ms that this run was launched with. */
  budgetMs: number;
  /**
   * Viewport this run actually used, reported by the adapter. Units are
   * adapter-dependent: CSS pixels for web, character cells for tui.
   * Omitted when the adapter has no rendering surface (cli).
   */
  viewport?: { width: number; height: number };
}

export type VetStatus = "pass" | "fail" | "investigate" | "errored";

export type ObservationKind =
  | "bug"
  | "ux"
  | "typo"
  | "suggestion"
  | "a11y"
  | "performance";

export interface Observation {
  kind: ObservationKind;
  description: string;
  evidence?: string[];
}

/**
 * Per-acceptance-criterion verdict with the evidence supporting it,
 * reported by the agent via `report_result` when the card declares
 * acceptance criteria (PRI-2160). `evidence` is what the agent actually
 * observed — a quote plus its source (screen text, file path, log line,
 * command output) — so a verdict can be checked against the artifacts
 * instead of trusted on recollection. Entries map to the card's
 * criteria by position. QA uses the model's restatement for `criterion`;
 * assessment attaches the canonical criterion text.
 */
export interface CriterionVerdict {
  criterion: string;
  verdict: "pass" | "fail" | "unclear";
  evidence: string;
}

/**
 * Base shape — the fields shared by every VetResult variant. `VetResult`
 * itself is a discriminated union on `status`: "errored" variants carry
 * a required `error` object; non-errored variants don't have the field.
 *
 * The JSON on disk is unchanged — an "errored" result already has an
 * `error` field; a non-errored result already omits it. No
 * RESULT_SCHEMA_VERSION bump.
 */
interface VetResultBase {
  schemaVersion: number;
  /**
   * Self-describing primary key for the run, set by the caller (route or
   * CLI) before writing. Shape: `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`.
   * `scenario` (the cardId) is retained for back-compat readers.
   */
  runId: RunId;
  scenario: CardId;
  summary: string;
  reasoning: string;
  observations: Observation[];
  /**
   * Per-acceptance-criterion verdicts with evidence citations
   * (PRI-2160). Present when the card declares acceptance criteria and
   * the agent's report satisfied citation validation; absent for
   * criteria-less cards, pre-existing results, internally-emitted
   * results (deadline fallback, shutdown drain), and salvaged reports.
   * Additive and optional — no RESULT_SCHEMA_VERSION bump; consumers
   * that ignore it are unaffected.
   */
  criteria?: CriterionVerdict[];
  evidence: {
    screenshots: string[];
    log: string;
    video?: string;
    artifacts?: string[];
    /**
     * TUI screen captures, one per `read_screen` tool call. Each entry is
     * a path to the raw `.ansi` file; the parsed `.json` twin lives at
     * the same stem (e.g. `captures/003.ansi` + `captures/003.json`).
     * Omitted entirely for non-TUI runs.
     */
    captures?: string[];
  };
  duration_ms: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /**
     * Tokens written to Anthropic's prompt cache across the whole run.
     * Omitted when 0 or when the provider doesn't surface the metric
     * (e.g. OpenAI today).
     */
    cacheCreationInputTokens?: number;
    /**
     * Tokens served from Anthropic's prompt cache across the whole run.
     * A non-zero value means the cache breakpoints in anthropic.ts are
     * actually hitting.
     */
    cacheReadInputTokens?: number;
    turns: number;
  };
  /**
   * Knobs the run was launched with. Optional for back-compat with v1
   * results on disk. Used by the UI to offer "Run again" without
   * re-asking the user for params.
   */
  config?: RunConfigSnapshot;
  runSet?: RunSetCtx;
}

export type VetResult =
  | (VetResultBase & { status: "pass" | "fail" | "investigate" })
  | (VetResultBase & {
      status: "errored";
      /**
       * Categorizes the cause so consumers can distinguish shutdown
       * interruption from other future error surfaces. `type` is
       * open-typed (string) so additive new categories don't require a
       * schema bump or TypeScript type widening — consumers MUST
       * tolerate unknown `type` values. Today the only emitted type is
       * `"shutdown_interrupted"` (PRI-1507).
       */
      error: { type: string; message: string };
    });

export interface ModelConfig {
  agent: string;
  fanout?: string;
}

/**
 * Derive a `RunConfigSnapshot` (versioned wire format stamped into
 * result.json) from the in-memory `ResolvedRunConfig`. Single-sources
 * the field set so the snapshot can't drift from the resolved config.
 *
 * `viewport` is passed in separately because the snapshot viewport
 * comes from the started adapter (via `snapshotViewport(adapter)`),
 * not the config's intended viewport — adapters may report something
 * different from what was requested (e.g., cli has no viewport).
 */
export function snapshotRunConfig(
  rc: ResolvedRunConfig,
  viewport: Viewport | undefined,
): RunConfigSnapshot {
  return {
    target: rc.target,
    model: rc.model,
    adapter: rc.adapter,
    chrome: rc.chrome ? `${rc.chrome.host}:${rc.chrome.port}` : undefined,
    budgetMs: rc.budgetMs,
    viewport,
  };
}

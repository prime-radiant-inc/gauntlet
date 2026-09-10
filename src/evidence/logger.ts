import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { CardId, RunId } from "../util/brands";

export type BrowserEventCategory =
  | "console"
  | "exception"
  | "log"
  | "network-ws";

export type ProgressObserver = (
  action: string,
  params: Record<string, unknown>,
) => void;

export type EventObserver = (event: Record<string, unknown>) => void;

export interface RunStartFields {
  runId: RunId;
  cardId: CardId;
  target: string | undefined;
  provider: string;
  model: string;
  adapter: string;
  /**
   * Wall-clock budget for the run, in milliseconds. The agent loop exits
   * when Date.now() >= startTime + budgetMs.
   */
  budgetMs: number;

  /**
   * Turns between mid-loop reflection-checkpoint injections; 0 disables.
   * Surfaced on run_start so post-hoc readers can see what cadence the
   * run was launched with.
   */
  reflectionInterval: number;
  toolTimeoutMs: number;
  contextTreeBytes: number;
  /** Absolute path to this run's evidence directory. Optional to keep
   * older tests and stub call sites compatible; production callers
   * always populate it. Surfaced in the `evidence` line of the CLI
   * stream's run_start panel. */
  outDir?: string;
  /** `WxH` string (e.g. `"1440x900"`). Web adapter only; other adapters
   * leave undefined. Surfaced on the `adapter` line of the CLI stream. */
  viewport?: string;
}

export interface LlmResponseFields {
  assessment_request_id?: string;
  turn: number;
  stopReason: string;
  text: string;
  thinking: Array<{ text: string; signature?: string }>;
  /**
   * Model's reasoning content for this turn (provider-neutral).
   * Sourced from `AgentResponse.reasoning`. Distinct from the
   * verdict's `reasoning` field on `RunEndFields` — that's the
   * agent's justification for its pass/fail/investigate verdict;
   * this is what the model thought during the turn. OpenAI populates
   * this with summary text from `ResponseReasoningItem.summary[]`
   * (a model-authored summary, not raw chain-of-thought).
   */
  reasoning?: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  rawAssistantMessage: unknown;
}

export interface ToolResultFields {
  turn: number;
  toolUseId: string;
  name: string;
  durationMs: number;
  text: string;
  /**
   * Optional override for the recorded `text` field. When set,
   * tool_result.text in run.jsonl is this string instead of the raw
   * `text`. The original `text` is dropped from the row. Used for
   * transcript redaction (PRI-1605). Never written to disk under its
   * own key.
   */
  transcriptText?: string;
  image?: string;            // relative path
  /** Media type of the image (e.g. "image/png"). Set when `image` is set
   * so post-hoc readers (e.g. session revival) can re-feed the bytes
   * into a provider-native image block without guessing. */
  mediaType?: string;
  artifact?: string;         // relative path
  /** Relative path to a TUI capture (`captures/NNN.ansi`). When set, the
   * tool_result row's `text` is replaced with this path to keep
   * run.jsonl lean; the LLM still receives the full ANSI via the
   * in-memory ToolResult.text field. */
  capturePath?: string;
  textTruncated?: true;
  textBytes?: number;
  error: boolean;
}

export interface RunEndFields {
  status: string;
  summary: string;
  reasoning: string;
  observationCount: number;
  observations: Array<{ kind: string; description: string; evidence?: string[] }>;
  /** Per-acceptance-criterion cited verdicts (PRI-2160). Present only
   * when the result carries them — mirrors VetResult.criteria. */
  criteria?: Array<{ criterion: string; verdict: string; evidence: string }>;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    turns: number;
  };
  /** Absolute path to this run's evidence directory. Optional for the
   * same reason as RunStartFields.outDir — surfaced in the `evidence`
   * line of the CLI stream's run_end panel. */
  outDir?: string;
}

const INLINE_TEXT_LIMIT = 32 * 1024;

/** obol usage-sidecar schema version (ISO date, matched as an opaque string). PRI-2125. */
const USAGE_SCHEMA_VERSION = "2026-06-08";

export class EvidenceLogger {
  private outDir: string;
  // Captured at run_start and stamped onto every usage.jsonl row. A Gauntlet
  // run is single-model, so the run-level provider/model is right for each call.
  private runProvider?: string;
  private runModel?: string;
  private screenshotCount = 0;
  private artifactCount = 0;
  private captureCount = 0;
  private _screenshots: string[] = [];
  private _artifacts: string[] = [];
  private _captures: string[] = [];
  private captureDirEnsured = false;
  private observers: Set<ProgressObserver> = new Set();
  private eventObservers: Set<EventObserver> = new Set();
  private eventCounter = 0;
  private lastEventId = 0;

  constructor(outDir: string) {
    this.outDir = outDir;
    mkdirSync(join(outDir, "screenshots"), { recursive: true });
    mkdirSync(join(outDir, "artifacts"), { recursive: true });
  }

  get screenshots(): string[] { return [...this._screenshots]; }
  get artifacts(): string[] { return [...this._artifacts]; }
  get captures(): string[] { return [...this._captures]; }
  get logPath(): string { return "run.jsonl"; }

  // Two distinct observer channels fire side-by-side:
  //
  //   addProgressObserver — coarse `(action, params)` only on `logToolCall`
  //     and `logEvent`. Drives the human-readable "progress" WS message
  //     and the ActiveRunRegistry progress string. Loses the structured
  //     wrapper (eventId, parentEventId, ts, type) by design.
  //
  //   addEventObserver — full structured entry on every `writeEvent` (so
  //     every row that lands in run.jsonl). Drives the "event" WS feed and
  //     the CLI live renderers. Spec §6.3.
  //
  // They serve different consumers — the progress channel is a derived
  // summary feed, the event channel is the structured firehose.
  addProgressObserver(fn: ProgressObserver): () => void {
    this.observers.add(fn);
    return () => { this.observers.delete(fn); };
  }

  // A misbehaving observer (one that throws) will not prevent other observers
  // from receiving the action.
  private notifyProgressObservers(action: string, params: Record<string, unknown>): void {
    for (const fn of this.observers) {
      try { fn(action, params); } catch { /* isolated */ }
    }
  }

  addEventObserver(fn: EventObserver): () => void {
    this.eventObservers.add(fn);
    return () => { this.eventObservers.delete(fn); };
  }

  private notifyEventObservers(event: Record<string, unknown>): void {
    for (const fn of this.eventObservers) {
      try { fn(event); } catch { /* isolated */ }
    }
  }

  private writeEvent(type: string, body: Record<string, unknown>): number {
    this.eventCounter += 1;
    const eventId = this.eventCounter;
    const entry = {
      eventId,
      parentEventId: this.lastEventId,
      ts: new Date().toISOString(),
      type,
      ...body,
    };
    appendFileSync(join(this.outDir, "run.jsonl"), JSON.stringify(entry) + "\n");
    this.lastEventId = eventId;
    this.notifyEventObservers(entry);
    return eventId;
  }

  logRunStart(fields: RunStartFields): void {
    this.runProvider = fields.provider;
    this.runModel = fields.model;
    this.writeEvent("run_start", { ...fields });
  }

  /**
   * Append one obol cost-sidecar row (`usage.jsonl`) for a single LLM call:
   * the provider's raw `usage` object, verbatim, tagged with the run's
   * provider/model (captured at run_start). The producer does no token math —
   * obol normalizes per-provider at read time (PRI-2125). `service_tier` is
   * hoisted from the raw usage when the provider includes it (Anthropic does),
   * else omitted so obol assumes the standard tier.
   */
  logUsageRow(rawUsage: unknown, identity?: { assessment_request_id: string; assessment_attempt_id: string }): void {
    const tier = (rawUsage as { service_tier?: unknown } | null | undefined)
      ?.service_tier;
    const row = {
      type: "obol.usage",
      v: USAGE_SCHEMA_VERSION,
      provider: this.runProvider,
      model: this.runModel,
      ...(typeof tier === "string" ? { service_tier: tier } : {}),
      usage: rawUsage,
      ...identity,
    };
    appendFileSync(join(this.outDir, "usage.jsonl"), JSON.stringify(row) + "\n");
  }

  logSystemPrompt(content: string): void {
    this.writeEvent("system_prompt", { content });
  }

  logToolDefinitions(
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  ): void {
    this.writeEvent("tool_definitions", { tools });
  }

  logUserMessage(turn: number, content: string): void {
    this.writeEvent("user_message", { turn, content });
  }

  logLlmRequest(turn: number, messageCount: number, identity?: { assessment_request_id: string }): void {
    this.writeEvent("llm_request", { turn, messageCount, ...identity });
  }

  logLlmResponse(fields: LlmResponseFields): void {
    this.writeEvent("llm_response", { ...fields });
  }

  logToolCall(fields: {
    turn: number;
    toolUseId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): void {
    this.writeEvent("tool_call", { ...fields });
    // Fire observers so live consumers (WS broadcaster, registry) still see
    // per-tool progress. Shape matches the old adapter-side logAction call
    // that this emitter replaced, so the feed looks unchanged to readers.
    this.notifyProgressObservers(fields.name, fields.arguments);
  }

  logToolResult(fields: ToolResultFields): void {
    // Transcript redaction (PRI-1605): tools may supply transcriptText to
    // record a different value in run.jsonl than the agent saw. Strip
    // transcriptText so it never appears as its own field in the row, and
    // substitute it for `text` when present. All downstream branches
    // operate on the normalized fields.
    const { transcriptText, ...rest } = fields;
    const normalized: Omit<ToolResultFields, "transcriptText"> =
      transcriptText !== undefined ? { ...rest, text: transcriptText } : rest;

    // TUI captures: the adapter has already written captures/NNN.ansi
    // and populated `capturePath`. Replace the inline text with the path
    // so run.jsonl stays lean. Consumers (UI, replay) fetch the file.
    // The LLM, which receives the in-memory ToolResult.text, is unaffected.
    if (normalized.capturePath) {
      const body: Record<string, unknown> = {
        ...normalized,
        text: normalized.capturePath,
      };
      this.writeEvent("tool_result", body);
      return;
    }

    let body: Record<string, unknown> = { ...normalized };
    if (typeof normalized.text === "string" && Buffer.byteLength(normalized.text, "utf8") > INLINE_TEXT_LIMIT) {
      const bytes = Buffer.byteLength(normalized.text, "utf8");
      const spilled = this.saveArtifact(normalized.text, "txt");
      // Keep run.jsonl readable by dropping the full text, but don't leave
      // a breadcrumb in the `text` field — a string like "<spilled — see
      // artifacts/N.txt>" is redundant with the `artifact` field and reads
      // like a path the model could open. The structured fields
      // (textTruncated, textBytes, artifact) tell the full story;
      // consumers render "spilled to artifact (NkB)" from those.
      body = {
        ...body,
        text: "",
        textTruncated: true,
        textBytes: bytes,
        artifact: normalized.artifact ?? spilled,
      };
      this.writeEvent("tool_result", body);
      this.logEvent("tool_result_text_oversize", {
        turn: normalized.turn,
        toolName: normalized.name,
        bytes,
        artifact: spilled,
      });
      return;
    }
    this.writeEvent("tool_result", body);
  }

  logEvent(name: string, data: Record<string, unknown>): void {
    this.writeEvent("event", { name, ...data });
    this.notifyProgressObservers(name, data);
  }

  logRunError(fields: { turn: number; message: string; stack?: string }): void {
    this.writeEvent("run_error", { ...fields });
  }

  /**
   * Emitted by the agent loop when it observes an aborted AbortSignal at
   * one of its abort check points (between turns, or between adjacent
   * tool calls within a turn). The `turn` field may be `0` if the abort
   * was already set when the loop began. See PRI-1507 spec §1 / §7.
   */
  logShutdownSignaled(fields: { turn: number; reason: string }): void {
    this.writeEvent("shutdown_signaled", { ...fields });
  }

  logRunEnd(fields: RunEndFields): void {
    this.writeEvent("run_end", { ...fields });
  }

  logBrowserEvent(
    category: BrowserEventCategory,
    data: Record<string, unknown>,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      category,
      ...data,
    };
    appendFileSync(
      join(this.outDir, `${category}.jsonl`),
      JSON.stringify(entry) + "\n",
    );
  }

  saveScreenshot(data: Buffer, name?: string): string {
    if (!name) {
      this.screenshotCount++;
      name = String(this.screenshotCount).padStart(3, "0");
    }
    const relativePath = `screenshots/${name}.png`;
    writeFileSync(join(this.outDir, relativePath), data);
    this._screenshots.push(relativePath);
    return relativePath;
  }

  saveArtifact(data: Buffer | string, ext: string): string {
    this.artifactCount++;
    const name = String(this.artifactCount).padStart(3, "0");
    const relativePath = `artifacts/${name}.${ext}`;
    writeFileSync(join(this.outDir, relativePath), data);
    this._artifacts.push(relativePath);
    return relativePath;
  }

  /**
   * Persists a TUI capture as a two-file pair: the raw `.ansi` (ground
   * truth, cheap) and the parsed `.json` grid (what the UI renders,
   * cached so the UI doesn't re-parse on every view). Returns the
   * `.ansi` relative path — the parsed twin is inferred by swapping the
   * extension. Only the raw path is tracked in `captures`; the JSON
   * twin rides along.
   */
  saveCapture(ansi: string, parsedJson: string): string {
    if (!this.captureDirEnsured) {
      mkdirSync(join(this.outDir, "captures"), { recursive: true });
      this.captureDirEnsured = true;
    }
    this.captureCount++;
    const name = String(this.captureCount - 1).padStart(3, "0"); // zero-indexed per spec
    const ansiRel = `captures/${name}.ansi`;
    const jsonRel = `captures/${name}.json`;
    writeFileSync(join(this.outDir, ansiRel), ansi);
    writeFileSync(join(this.outDir, jsonRel), parsedJson);
    this._captures.push(ansiRel);
    return ansiRel;
  }
}

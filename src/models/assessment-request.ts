import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceLogger } from "../evidence/logger";
import type { Provider, TokenUsage } from "./provider";
import { normalizeAnthropicUsage } from "./anthropic";
import { normalizeOpenAIUsage } from "./openai";

export type AttemptSummary = {
  admitted: number;
  settled: number;
  unknownUsageAttemptIds: string[];
  usage: TokenUsage;
};
export type AssessmentRequestControl = {
  requestId: string;
  signal: AbortSignal;
  workDeadlineAtMs: number;
  now(): number;
  fetch: typeof globalThis.fetch;
};
export type AssessmentAttemptJournal = {
  forRequest(requestId: string, signal: AbortSignal): AssessmentRequestControl;
  snapshot(): AttemptSummary;
  seal(): AttemptSummary;
};

type AttemptIdentity = { assessment_request_id: string; assessment_attempt_id: string };
type EventBase = AttemptIdentity & { schema_version: 1; timestamp_ms: number };
export type AssessmentAttemptAdmission = EventBase & {
  event: "admission";
  outcome: "admitted";
  provider: Provider;
  model: string;
};
export type AssessmentAttemptSettlement = EventBase & {
  event: "settlement";
  outcome: "response" | "transport_error" | "aborted" | "capture_failure" | "incomplete";
  usage: "recorded" | "not_returned" | "invalid";
  usage_unavailable?: "api_error" | "missing_usage" | "invalid_usage" | "invalid_json" | "observation_failed" | "transport_error" | "aborted" | "incomplete" | "usage_write_failed";
  accounting_failure: boolean;
  capture: "disabled" | "complete" | "failed" | "incomplete";
  request_body_path?: string;
  response_body_path?: string;
  returned_at_ms?: number;
  aborted_at_ms?: number;
  response?: {
    http_status: number;
    request_id?: string;
    id?: string;
    status?: string;
    model?: string;
    stop_reason?: string;
  };
};
export type AssessmentAttemptEvent = AssessmentAttemptAdmission | AssessmentAttemptSettlement;

type Attempt = {
  identity: AttemptIdentity;
  settlement?: AssessmentAttemptSettlement;
  details: Pick<AssessmentAttemptSettlement, "request_body_path" | "response_body_path" | "returned_at_ms" | "aborted_at_ms" | "response">;
};
type SettlementFields = Pick<AssessmentAttemptSettlement, "outcome" | "usage" | "usage_unavailable" | "accounting_failure" | "capture">;
// The step an attempt was in when it threw decides how the failure is settled.
type AttemptPhase = "capture" | "transport" | "observation" | "usage";

// A stalled or oversized body must not consume unbounded assessment resources.
const MAX_OBSERVED_BODY_BYTES = 16 * 1024 * 1024;

/** Observe a clone, draining ready bytes on abort without waiting for more I/O. */
async function observeBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    stop = () => {
      // Buffered responses can still contain billable usage at cancellation.
      // The next timer turn is the boundary; there is no new work allowance.
      abortTimer ??= setTimeout(() => reject(new Error("assessment body observation aborted")), 0);
    };
  });
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OBSERVED_BODY_BYTES) throw new Error("assessment body observation limit exceeded");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    // A tee's cancellation can wait on the SDK's original branch; never await it.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    clearTimeout(abortTimer);
    reader.releaseLock();
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function normalizedUsage(provider: Provider, raw: unknown): TokenUsage | undefined {
  const usage = object(raw);
  if (!usage || !tokenCount(usage.input_tokens) || !tokenCount(usage.output_tokens)) return;
  if (provider === "anthropic") {
    for (const key of ["cache_creation_input_tokens", "cache_read_input_tokens"]) {
      if (usage[key] != null && !tokenCount(usage[key])) return;
    }
    return normalizeAnthropicUsage(raw as Parameters<typeof normalizeAnthropicUsage>[0]);
  }
  const details = object(usage.input_tokens_details);
  if (usage.input_tokens_details != null && !details) return;
  const cached = details?.cached_tokens ?? 0;
  if (!tokenCount(cached) || cached > usage.input_tokens) return;
  return normalizeOpenAIUsage(raw as Parameters<typeof normalizeOpenAIUsage>[0]);
}

/**
 * Settle a returned physical response. An API error without model content keeps
 * unknown invoice coverage; model content without valid usage is an accounting failure.
 */
function classifyReturnedResponse(provider: Provider, response: Response, body: Record<string, unknown> | undefined, normalized: TokenUsage | undefined, captureBodies: boolean): SettlementFields {
  const capture = captureBodies ? "complete" as const : "disabled" as const;
  if (normalized) return { outcome: "response", usage: "recorded", accounting_failure: false, capture };
  const content = provider === "anthropic" ? body?.content : body?.output;
  const hasModelContent = Array.isArray(content) && content.length > 0;
  const apiError = body?.error != null || body?.type === "error";
  const modelEnvelope = provider === "anthropic" ? body?.type === "message" : body?.object === "response";
  const modelResponse = hasModelContent || (!apiError && (response.ok || modelEnvelope));
  if (!modelResponse) return { outcome: "response", usage: "not_returned", usage_unavailable: "api_error", accounting_failure: false, capture };
  const invalid = { outcome: "response" as const, usage: "invalid" as const, accounting_failure: true, capture };
  if (!body) return { ...invalid, usage_unavailable: "invalid_json" };
  if (body.usage == null) return { ...invalid, usage_unavailable: "missing_usage" };
  return { ...invalid, usage_unavailable: "invalid_usage" };
}

/** Settle a failed attempt; cancellation outranks the phase that threw. */
function classifyFailure(phase: AttemptPhase, aborted: boolean, captureBodies: boolean): SettlementFields {
  // A usage write that fails after a returned model response is unaccountable
  // even when cancellation also fired while that response was being observed.
  const base = { usage: "not_returned" as const, accounting_failure: phase === "usage" };
  if (aborted) return { ...base, outcome: "aborted", usage_unavailable: "aborted", capture: "incomplete" };
  if (phase === "transport") return { ...base, outcome: "transport_error", usage_unavailable: "transport_error", capture: captureBodies ? "failed" : "disabled" };
  if (phase === "usage") return { ...base, outcome: "capture_failure", usage_unavailable: "usage_write_failed", capture: "failed" };
  return { ...base, outcome: "capture_failure", usage_unavailable: "observation_failed", capture: "failed" };
}

/** The caller initializes logger.run_start and seals before publishing completion. */
export function createAssessmentAttemptJournal(input: {
  outDir: string;
  provider: Provider;
  model: string;
  workDeadlineAtMs: number;
  now(): number;
  fetch: typeof globalThis.fetch;
  maxPhysicalAttempts?: number;
  captureBodies: boolean;
  logger: EvidenceLogger;
}): AssessmentAttemptJournal {
  const { outDir, provider, model, workDeadlineAtMs, now, maxPhysicalAttempts, captureBodies, logger } = input;
  const attempts: Attempt[] = [];
  let admitted = 0;
  let sealed = false;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  function write(event: AssessmentAttemptEvent): void {
    appendFileSync(join(outDir, "assessment-attempts.jsonl"), JSON.stringify(event) + "\n");
  }
  function settle(attempt: Attempt, fields: SettlementFields): void {
    if (sealed || attempt.settlement) return;
    const event: AssessmentAttemptSettlement = { schema_version: 1, event: "settlement", ...attempt.identity, timestamp_ms: now(), ...attempt.details, ...fields };
    write(event);
    attempt.settlement = event;
  }
  function snapshot(): AttemptSummary {
    return {
      admitted,
      settled: attempts.filter(a => a.settlement && a.settlement.outcome !== "incomplete").length,
      unknownUsageAttemptIds: attempts.filter(a => a.settlement?.usage !== "recorded").map(a => a.identity.assessment_attempt_id),
      usage: { ...usage },
    };
  }
  function capture(attempt: Attempt, kind: "request" | "response", bytes: Uint8Array): void {
    const path = join("assessment-bodies", `${attempt.identity.assessment_attempt_id}-${kind}.body`);
    mkdirSync(join(outDir, "assessment-bodies"), { recursive: true });
    writeFileSync(join(outDir, path), bytes);
    attempt.details[`${kind}_body_path`] = path;
  }

  return {
    snapshot,
    seal() {
      if (!sealed) {
        for (const attempt of attempts) {
          settle(attempt, { outcome: "incomplete", usage: "not_returned", usage_unavailable: "incomplete", accounting_failure: false, capture: "incomplete" });
        }
        sealed = true;
      }
      return snapshot();
    },
    forRequest(requestId, signal) {
      return {
        requestId, signal, workDeadlineAtMs, now,
        fetch: (async (url, init) => {
          const remainingMs = workDeadlineAtMs - now();
          const transportSignal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
          if (sealed || signal.aborted || transportSignal?.aborted || remainingMs <= 0 ||
              (maxPhysicalAttempts !== undefined && admitted >= maxPhysicalAttempts)) {
            throw new Error("assessment request admission stopped");
          }
          const attemptId = String(++admitted).padStart(3, "0");
          const attempt: Attempt = { identity: { assessment_request_id: requestId, assessment_attempt_id: attemptId }, details: {} };
          attempts.push(attempt);
          write({ schema_version: 1, event: "admission", ...attempt.identity, timestamp_ms: now(), outcome: "admitted", provider, model });
          const deadline = new AbortController();
          const activeSignal = AbortSignal.any([signal, deadline.signal, ...(transportSignal ? [transportSignal] : [])]);
          const onAbort = () => { if (!sealed) attempt.details.aborted_at_ms = now(); };
          activeSignal.addEventListener("abort", onAbort, { once: true });
          const timer = setTimeout(() => deadline.abort(), remainingMs);
          let phase: AttemptPhase = "capture";
          let response: Response | undefined;
          try {
            if (captureBodies) {
              const request = new Request(url instanceof Request ? url.clone() : url, init);
              const bytes = await observeBody(new Response(request.body), activeSignal);
              if (sealed) throw new Error("assessment journal sealed");
              capture(attempt, "request", bytes);
            }
            if (now() >= workDeadlineAtMs) deadline.abort();
            if (sealed || activeSignal.aborted) throw new Error("assessment request admission stopped");
            phase = "transport";
            response = await input.fetch(url, { ...init, signal: activeSignal });
            if (sealed) throw new Error("assessment journal sealed");
            attempt.details.returned_at_ms = now();
            attempt.details.response = { http_status: response.status };
            const requestId = response.headers.get(provider === "anthropic" ? "request-id" : "x-request-id");
            if (requestId) attempt.details.response.request_id = requestId;
            if (now() >= workDeadlineAtMs) deadline.abort();
            phase = "observation";
            const bytes = await observeBody(response.clone(), activeSignal);
            if (sealed) throw new Error("assessment journal sealed");
            let body: Record<string, unknown> | undefined;
            try { body = object(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* Preserve malformed bytes and explicit accounting failure. */ }
            for (const key of ["id", "status", "model", "stop_reason"] as const) {
              if (typeof body?.[key] === "string") attempt.details.response[key] = body[key];
            }
            if (provider === "openai") {
              const reason = object(body?.incomplete_details)?.reason;
              if (typeof reason === "string") attempt.details.response.stop_reason = reason;
            }
            const normalized = normalizedUsage(provider, body?.usage);
            phase = "usage";
            if (normalized) {
              logger.logUsageRow(body!.usage, attempt.identity);
              for (const key of Object.keys(normalized) as Array<keyof TokenUsage>) {
                if (normalized[key] !== undefined) usage[key] = (usage[key] ?? 0) + normalized[key];
              }
            }
            const fields = classifyReturnedResponse(provider, response, body, normalized, captureBodies);
            if (captureBodies) {
              try { capture(attempt, "response", bytes); }
              catch (error) { settle(attempt, { ...fields, outcome: "capture_failure", capture: "failed" }); throw error; }
            }
            settle(attempt, fields);
            return response;
          } catch (error) {
            const aborted = activeSignal.aborted;
            // The SDK cannot release an original it never received. Cancel both
            // branches on observation failure, without awaiting either promise.
            void response?.body?.cancel().catch(() => {});
            settle(attempt, classifyFailure(phase, aborted, captureBodies));
            throw error;
          } finally {
            clearTimeout(timer);
            activeSignal.removeEventListener("abort", onAbort);
          }
        }) as typeof globalThis.fetch,
      };
    },
  };
}

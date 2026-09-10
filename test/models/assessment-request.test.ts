import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLogger } from "../../src/evidence/logger";
import { createAssessmentAttemptJournal } from "../../src/models/assessment-request";
import { attemptRows as rows } from "./assessment-fixture";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const nativeUsage = { input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 7, service_tier: "standard" };
const message = { id: "msg_fixture", type: "message", role: "assistant", model: "anthropic.claude-sonnet-5", content: [{ type: "text", text: "private answer" }], stop_reason: "end_turn", usage: nativeUsage };
function setup(overrides: Partial<Parameters<typeof createAssessmentAttemptJournal>[0]> = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "assessment-attempts-"));
  dirs.push(outDir);
  const logger = new EvidenceLogger(outDir);
  const journal = createAssessmentAttemptJournal({
    outDir, provider: "anthropic", model: "anthropic.claude-sonnet-5",
    workDeadlineAtMs: 115_000, now: () => 0,
    fetch: (async () => Response.json(message)) as typeof fetch,
    captureBodies: false, logger, ...overrides,
  });
  return { outDir, logger, journal, request: journal.forRequest("r1", new AbortController().signal) };
}

// Each admitted SDK retry shares the allowance with every logical continuation.
test("a refused fourth physical attempt never reaches fetch", async () => {
  let calls = 0;
  const { journal } = setup({ maxPhysicalAttempts: 3, fetch: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
  for (let n = 0; n < 3; n++) {
    const request = journal.forRequest("r" + n, new AbortController().signal);
    await request.fetch("http://127.0.0.1/messages", { method: "POST", body: "{}" });
  }
  await expect(journal.forRequest("r3", new AbortController().signal).fetch("http://127.0.0.1/messages")).rejects.toThrow();
  expect(calls).toBe(3);
  expect(journal.snapshot().admitted).toBe(3);
});

test("metadata mode observes native usage once without retaining bodies or arbitrary headers", async () => {
  const { request, journal, outDir, logger } = setup({ fetch: (async () => new Response(JSON.stringify(message), { headers: { "request-id": "req_fixture", "set-cookie": "secret-cookie", "x-private": "secret-header" } })) as typeof fetch });
  logger.logRunStart({ runId: "run" as never, cardId: "card" as never, provider: "anthropic", model: message.model, adapter: "assessment", budgetMs: 120_000, target: undefined, reflectionInterval: 0, toolTimeoutMs: 0, contextTreeBytes: 0 });
  const response = await request.fetch("http://127.0.0.1/messages", { method: "POST", body: "private prompt", headers: { authorization: "Bearer secret-key" } });
  expect(await response.json()).toEqual(message);
  expect(journal.snapshot()).toEqual({ admitted: 1, settled: 1, unknownUsageAttemptIds: [], usage: { inputTokens: 12, outputTokens: 5, cacheCreationInputTokens: 3, cacheReadInputTokens: 7 } });
  expect(rows(outDir, "usage.jsonl")).toEqual([{ type: "obol.usage", v: "2026-06-08", provider: "anthropic", model: message.model, service_tier: "standard", usage: nativeUsage, assessment_request_id: "r1", assessment_attempt_id: "001" }]);
  const events = rows(outDir);
  expect(events.map(e => [e.event, e.outcome, e.assessment_attempt_id])).toEqual([["admission", "admitted", "001"], ["settlement", "response", "001"]]);
  expect(events[1]).toMatchObject({ usage: "recorded", capture: "disabled", response: { http_status: 200, request_id: "req_fixture", id: "msg_fixture", model: message.model, stop_reason: "end_turn" } });
  const serialized = JSON.stringify(events);
  for (const secret of ["secret-cookie", "secret-header", "secret-key", "private prompt", "private answer"]) expect(serialized).not.toContain(secret);
  expect(readdirSync(outDir).some(name => name.includes("bodies"))).toBe(false);
});

test("diagnostic capture preserves exact request and response bytes and the original SDK body", async () => {
  const responseBody = ' { "id": "msg_fixture", "type": "message", "content": [], "usage": {"input_tokens": 2, "output_tokens": 1} }\n';
  const requestBody = ' {"prompt": "unchanged\\ntext"}\n';
  let received: unknown;
  const { request, outDir } = setup({ captureBodies: true, fetch: (async (_url, init) => { received = init?.body; return new Response(responseBody); }) as typeof fetch });
  const response = await request.fetch("http://127.0.0.1/messages", { method: "POST", body: requestBody });
  expect(received).toBe(requestBody);
  expect(await response.text()).toBe(responseBody);
  const settlement = rows(outDir)[1];
  expect(settlement.capture).toBe("complete");
  expect(readFileSync(join(outDir, settlement.request_body_path), "utf8")).toBe(requestBody);
  expect(readFileSync(join(outDir, settlement.response_body_path), "utf8")).toBe(responseBody);
});

test.each([
  [429, { type: "error", error: { message: "rate limit" } }, "not_returned", false],
  [200, { ...message, usage: undefined }, "invalid", true],
  [200, { ...message, usage: { input_tokens: -1, output_tokens: 2 } }, "invalid", true],
  [200, { ...message, usage: { input_tokens: 1, output_tokens: "2" } }, "invalid", true],
  [200, { ...message, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: -1 } }, "invalid", true],
])("HTTP %i usage coverage stays explicit (%j)", async (status, body, usage, accounting_failure) => {
  const { request, journal, outDir } = setup({ fetch: (async () => Response.json(body, { status })) as typeof fetch });
  await request.fetch("http://127.0.0.1/messages");
  expect(rows(outDir)[1]).toMatchObject({ outcome: "response", usage, accounting_failure });
  expect(rows(outDir)[1].usage_unavailable).toBeString();
  expect(rows(outDir, "usage.jsonl")).toEqual([]);
  expect(journal.snapshot()).toMatchObject({ admitted: 1, settled: 1, unknownUsageAttemptIds: ["001"] });
});

test("OpenAI usage keeps native cached counters but totals uncached input", async () => {
  const usage = { input_tokens: 20, input_tokens_details: { cached_tokens: 8 }, output_tokens: 4, total_tokens: 24, output_tokens_details: { reasoning_tokens: 3 } };
  const { request, journal, outDir } = setup({ provider: "openai", model: "gpt-5.4-mini", fetch: (async () => Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [], usage })) as typeof fetch });
  await request.fetch("http://127.0.0.1/responses");
  expect(journal.snapshot().usage).toEqual({ inputTokens: 12, outputTokens: 4, cacheReadInputTokens: 8 });
  expect(rows(outDir, "usage.jsonl")[0].usage).toEqual(usage);
});

test("pre-abort, expired time, and sealing refuse admission", async () => {
  let calls = 0;
  const { journal } = setup({ fetch: (async () => { calls++; return Response.json(message); }) as typeof fetch });
  const aborted = new AbortController();
  aborted.abort();
  await expect(journal.forRequest("aborted", aborted.signal).fetch("http://127.0.0.1")).rejects.toThrow();
  const expired = setup({ now: () => 115_000, fetch: (async () => { calls++; return Response.json(message); }) as typeof fetch });
  await expect(expired.request.fetch("http://127.0.0.1")).rejects.toThrow();
  journal.seal();
  await expect(journal.forRequest("sealed", new AbortController().signal).fetch("http://127.0.0.1")).rejects.toThrow();
  expect(calls).toBe(0);
});

test("transport error has unknown invoice coverage and no usage row", async () => {
  const { request, journal, outDir } = setup({ fetch: (async () => { throw new Error("secret transport details"); }) as typeof fetch });
  await expect(request.fetch("http://127.0.0.1")).rejects.toThrow();
  expect(rows(outDir)[1]).toMatchObject({ outcome: "transport_error", usage: "not_returned", accounting_failure: false });
  expect(JSON.stringify(rows(outDir))).not.toContain("secret transport details");
  expect(journal.snapshot().unknownUsageAttemptIds).toEqual(["001"]);
});

test("body observation is aborted promptly even when a response stream stalls", async () => {
  const abort = new AbortController();
  const { journal, outDir } = setup({ fetch: (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"usage":')); } }))) as typeof fetch });
  const pending = journal.forRequest("stalled", abort.signal).fetch("http://127.0.0.1");
  await Bun.sleep(5);
  abort.abort();
  await expect(pending).rejects.toThrow();
  expect(rows(outDir)[1]).toMatchObject({ outcome: "aborted", usage: "not_returned", capture: "incomplete" });
});

test("a work deadline bounds metadata observation even without caller cancellation", async () => {
  const { request, outDir } = setup({ now: Date.now, workDeadlineAtMs: Date.now() + 30, fetch: (async () => new Response(new ReadableStream())) as typeof fetch });
  await expect(request.fetch("http://127.0.0.1")).rejects.toThrow();
  expect(rows(outDir)[1]).toMatchObject({ outcome: "aborted", usage: "not_returned", capture: "incomplete" });
});

test("already returned bodies retain usage on either side of cancellation", async () => {
  for (const cancelBeforeReturn of [false, true]) {
    const abort = new AbortController();
    const { journal, outDir } = setup({ fetch: (async () => { if (cancelBeforeReturn) abort.abort(); return Response.json(message); }) as typeof fetch });
    await journal.forRequest("cancel-race", abort.signal).fetch("http://127.0.0.1");
    abort.abort();
    expect(journal.snapshot().usage.outputTokens).toBe(5);
    expect(rows(outDir, "usage.jsonl")).toHaveLength(1);
  }
});

test("sealing freezes incomplete attempts and forbids late writes", async () => {
  let resolve!: (response: Response) => void;
  const { request, journal, outDir } = setup({ fetch: (() => new Promise<Response>(r => { resolve = r; })) as typeof fetch });
  const pending = request.fetch("http://127.0.0.1");
  const sealed = journal.seal();
  expect(sealed).toMatchObject({ admitted: 1, settled: 0, unknownUsageAttemptIds: ["001"] });
  expect(rows(outDir)[1]).toMatchObject({ outcome: "incomplete", usage: "not_returned" });
  const evidence = readFileSync(join(outDir, "assessment-attempts.jsonl"), "utf8");
  resolve(Response.json(message));
  await expect(pending).rejects.toThrow();
  expect(journal.seal()).toEqual(sealed);
  expect(readFileSync(join(outDir, "assessment-attempts.jsonl"), "utf8")).toBe(evidence);
  expect(rows(outDir, "usage.jsonl")).toEqual([]);
  sealed.usage.inputTokens = 999;
  sealed.unknownUsageAttemptIds.length = 0;
  expect(journal.snapshot().usage.inputTokens).toBe(0);
  expect(journal.snapshot().unknownUsageAttemptIds).toEqual(["001"]);
});

test("capture write failure is explicit and cannot masquerade as complete diagnostics", async () => {
  const { request, outDir } = setup({ captureBodies: true });
  writeFileSync(join(outDir, "assessment-bodies"), "not a directory");
  await expect(request.fetch("http://127.0.0.1", { method: "POST", body: "{}" })).rejects.toThrow();
  expect(rows(outDir)[1]).toMatchObject({ outcome: "capture_failure", capture: "failed" });
});

test.each([
  ["anthropic", { type: "error", error: { type: "overloaded_error", message: "unavailable" } }],
  ["openai", { id: "resp_failed", object: "response", status: "failed", error: { code: "server_error", message: "unavailable" }, output: [], usage: null }],
] as const)("%s API errors without model content have unknown coverage even with a 2xx envelope", async (provider, body) => {
  const { request, outDir } = setup({ provider, fetch: (async () => Response.json(body)) as typeof fetch });
  await request.fetch("http://127.0.0.1");
  expect(rows(outDir)[1]).toMatchObject({ outcome: "response", usage: "not_returned", usage_unavailable: "api_error", accounting_failure: false });
});

test("model content missing usage is an accounting failure even on an HTTP error", async () => {
  const { request, outDir } = setup({ fetch: (async () => Response.json({ content: message.content, error: { message: "partial failure" } }, { status: 500 })) as typeof fetch });
  await request.fetch("http://127.0.0.1");
  expect(rows(outDir)[1]).toMatchObject({ usage: "invalid", usage_unavailable: "missing_usage", accounting_failure: true });
});

test("oversized metadata observation fails explicitly and cancels the clone", async () => {
  const { request, outDir } = setup({ fetch: (async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1))) as typeof fetch });
  await expect(request.fetch("http://127.0.0.1")).rejects.toThrow();
  expect(rows(outDir)[1]).toMatchObject({ outcome: "capture_failure", usage: "not_returned", usage_unavailable: "observation_failed", capture: "failed" });
});

test("malformed JSON remains exact diagnostic evidence and explicit invalid usage", async () => {
  const body = '{"content": [], "usage":';
  const { request, outDir } = setup({ captureBodies: true, fetch: (async () => new Response(body)) as typeof fetch });
  expect(await (await request.fetch("http://127.0.0.1")).text()).toBe(body);
  const event = rows(outDir)[1];
  expect(event).toMatchObject({ outcome: "response", usage: "invalid", usage_unavailable: "invalid_json", accounting_failure: true, capture: "complete" });
  expect(readFileSync(join(outDir, event.response_body_path), "utf8")).toBe(body);
});

test("response capture failure retains usage already returned by the provider", async () => {
  const { request, outDir, journal } = setup({ captureBodies: true });
  // Request capture must work so this exercises failure after the billable response.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(outDir, "assessment-bodies", "001-response.body"), { recursive: true });
  await expect(request.fetch("http://127.0.0.1")).rejects.toThrow();
  expect(rows(outDir)[1]).toMatchObject({ outcome: "capture_failure", capture: "failed", usage: "recorded" });
  expect(rows(outDir, "usage.jsonl")).toHaveLength(1);
  expect(journal.snapshot()).toMatchObject({ settled: 1, unknownUsageAttemptIds: [], usage: { outputTokens: 5 } });
});

test("usage writer failure is an explicit accounting failure, never a recorded row", async () => {
  const { request, journal, outDir } = setup();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(outDir, "usage.jsonl"));
  await expect(request.fetch("http://127.0.0.1")).rejects.toThrow();
  expect(rows(outDir)[1]).toMatchObject({ outcome: "capture_failure", usage: "not_returned", usage_unavailable: "usage_write_failed", accounting_failure: true });
  expect(journal.snapshot().unknownUsageAttemptIds).toEqual(["001"]);
  expect(journal.snapshot().usage).toEqual({ inputTokens: 0, outputTokens: 0 });
});

test.each(["abort", "deadline"] as const)("%s cleanup never waits for either branch's hanging cancellation", async (stop) => {
  const abort = new AbortController();
  let sourceCancelled = false;
  const original = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"usage":')); },
    cancel() {
      sourceCancelled = true;
      return new Promise<void>(() => {});
    },
  }));
  const { journal, outDir } = setup({
    now: Date.now,
    workDeadlineAtMs: Date.now() + (stop === "deadline" ? 30 : 115_000),
    fetch: (async () => original) as typeof fetch,
  });
  const pending = journal.forRequest("hanging-body", abort.signal).fetch("http://127.0.0.1");
  if (stop === "abort") abort.abort();
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = await Promise.race([
      pending.then(() => "response", () => "rejected"),
      new Promise<string>(resolve => { guard = setTimeout(() => resolve("still pending"), 250); }),
    ]);
    expect(completion).toBe("rejected");
    expect(rows(outDir)[1]).toMatchObject({ outcome: "aborted", usage: "not_returned", capture: "incomplete" });
    expect(journal.snapshot().unknownUsageAttemptIds).toEqual(["001"]);
    expect(sourceCancelled).toBe(true);
  } finally {
    clearTimeout(guard);
    void original.body?.cancel().catch(() => {});
  }
});

test("work expiry during request capture records an abort without reaching transport", async () => {
  let calls = 0;
  let clockReads = 0;
  const { request, outDir } = setup({
    captureBodies: true,
    now: () => clockReads++ === 0 ? 0 : 115_000,
    fetch: (async () => { calls++; return Response.json(message); }) as typeof fetch,
  });
  await expect(request.fetch("http://127.0.0.1", { method: "POST", body: "{}" })).rejects.toThrow();
  expect(calls).toBe(0);
  expect(rows(outDir)[1]).toMatchObject({ outcome: "aborted", usage: "not_returned", capture: "incomplete", aborted_at_ms: 115_000 });
});

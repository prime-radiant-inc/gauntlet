import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAssessmentDecision } from "../../src/assessment/lifecycle";
import { attemptRows } from "../models/assessment-fixture";

const runId = "assessment-cli_20260909T120000Z_test";
const rubric = `---
id: assessment-cli
title: Synthetic assessment
status: ready
---
## Acceptance Criteria
- Followed the user policy
`;
function nativeReply(index: number, verdict = "pass") {
  return {
    id: `msg_${index}`, type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id: `tool_${index}`,
      name: index === 0 ? "read_evidence" : "report_result",
      input: index === 0 ? { path: "visible.txt" } : {
        summary: `${verdict} summary`, reasoning: "Observed the retained refusal.", observations: [],
        criteria: [{ verdict, observation: "The subject refused.", basis: "The refusal follows the policy.",
          limitations: "One response retained.", references: ["visible.txt"] }],
      },
    }], stop_reason: "tool_use", stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 },
  };
}

// Child-only clock and storage seams. The SDK still sends requests over localhost.
function preload(mode: string) {
  return `import { spyOn } from "bun:test";
import * as fs from "fs";
import * as writer from ${JSON.stringify(resolve("src/evidence/writer.ts"))};
let time = 0;
spyOn(Date, "now").mockImplementation(() => 0);
spyOn(performance, "now").mockImplementation(() => time);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const value = response.headers.get("x-fixture-time");
  if (value && ["cancel-before", "late"].includes(${JSON.stringify(mode)})) {
    // These cases exercise an already returned body at the report boundary.
    // fetch resolves on headers; drain the actual localhost bytes before the
    // synthetic signal/clock change, independently of OS packet buffering.
    const returned = new Response(await response.arrayBuffer(), {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
    time = Number(value);
    if (${JSON.stringify(mode)} === "cancel-before") process.emit("SIGTERM", "SIGTERM");
    return returned;
  }
  if (value) time = Number(value);
  return response;
};
const write = writer.writeResultFiles;
spyOn(writer, "writeResultFiles").mockImplementation((dir, result, writeFile) => {
  time = 117_000;
  if (${JSON.stringify(mode)} === "cancel-after") {
    process.emit("SIGTERM", "SIGTERM"); process.emit("SIGINT", "SIGINT");
  }
  return write(dir, result, (path, text) => {
    if (${JSON.stringify(mode)} === "writer-failure" && path.endsWith("result.md")) throw new Error("fixture writer failure");
    writeFile(path, text);
  });
});
// Observe actual sync ordering, including the final run_end append, at the marker link.
const syncedSizes = new Map();
const sync = fs.fsyncSync;
spyOn(fs, "fsyncSync").mockImplementation(fd => {
  const stat = fs.fstatSync(fd);
  if (${JSON.stringify(mode)} === "double-fault" && stat.isDirectory() && fs.existsSync(process.env.FIXTURE_MARKER))
    throw new Error("fixture marker directory sync failure");
  sync(fd); syncedSizes.set(stat.ino, stat.size);
});
const link = fs.linkSync;
spyOn(fs, "linkSync").mockImplementation((source, destination) => {
  if (String(destination).endsWith("assessment-completion.json")) {
    const dir = process.env.FIXTURE_OUT;
    for (const file of ["run.jsonl", "usage.jsonl", "assessment-attempts.jsonl"]) {
      if (!fs.existsSync(dir + "/" + file)) continue;
      const stat = fs.statSync(dir + "/" + file);
      if (syncedSizes.get(stat.ino) !== stat.size) throw new Error("evidence not durably sealed: " + file);
    }
    const rows = fs.readFileSync(dir + "/run.jsonl", "utf8").trim().split("\\n").map(JSON.parse);
    if (rows.at(-1).type !== "run_end") throw new Error("run_end missing before marker");
  }
  link(source, destination);
});
const unlink = fs.unlinkSync;
spyOn(fs, "unlinkSync").mockImplementation(path => {
  if (${JSON.stringify(mode)} === "double-fault" && String(path).endsWith("assessment-completion.json"))
    throw new Error("fixture marker rollback failure");
  unlink(path);
});
`;
}

type CliOptions = {
  verdict?: "pass" | "fail" | "unclear";
  maxTime?: string;
  hardDeadline?: number;
  mode?: string;
  startupDelayMs?: number;
  signal?: "SIGTERM" | "SIGINT" | "SIGHUP";
  apiError?: boolean;
  verbose?: boolean;
  zeroCache?: boolean;
  bodyDelayMs?: number;
  retry?: boolean;
  conversionFailure?: boolean;
  malformedRubric?: boolean;
  mismatchedRubric?: boolean;
};
async function withCli(options: CliOptions, check: (fx: {
  code: number; outDir: string; requests: number; stdout: string; stderr: string;
  marker: any; result: any; events: any[]; attempts: any[]; usage: any[];
}) => void) {
  const root = mkdtempSync(join(import.meta.dir, ".cli-lifecycle-"));
  const outDir = join(root, runId);
  mkdirSync(outDir);
  const rubricPath = join(root, "rubric.md");
  writeFileSync(rubricPath, options.malformedRubric ? "invalid rubric" : options.mismatchedRubric ? rubric.replace("id: assessment-cli", "id: another-card") : rubric);
  writeFileSync(join(root, "visible.txt"), "The subject refused the prohibited request.");
  writeFileSync(join(root, "index.json"), JSON.stringify({ files: ["visible.txt"] }));
  let requests = 0;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    await request.json();
    const index = requests++;
    if (options.signal) {
      timers.push(setTimeout(() => child!.kill(options.signal), 5));
      await new Promise(resolve => { timers.push(setTimeout(resolve, 200)); });
    } else if (options.maxTime === "5100ms") {
      await new Promise(resolve => { timers.push(setTimeout(resolve, 300)); });
    }
    if (options.apiError) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "fixture API error" } }, { status: 400 });
    if (options.retry && index < 2) return Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture retry" } },
      { status: 429, headers: { "retry-after-ms": "1" } });
    const reply = nativeReply(options.retry ? index - 2 : index, options.verdict);
    if (options.zeroCache) Object.assign(reply.usage, { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    const response = Response.json(options.conversionFailure ? { ...reply, content: null } : reply, {
      headers: options.mode && index === 1 ? { "x-fixture-time": options.mode === "late" ? "115000" : "114999" } : {},
    });
    if (options.bodyDelayMs && index === 1) {
      const bytes = new TextEncoder().encode(await response.text());
      // Deliver headers before the response body to expose the transport boundary.
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        timers.push(setTimeout(() => {
          controller.enqueue(bytes.slice(1)); controller.close();
        }, options.bodyDelayMs));
      } }), { status: response.status, headers: response.headers });
    }
    return response;
  } });
  try {
    const preloads: string[] = [];
    if (options.mode || options.startupDelayMs) {
      const path = join(root, "preload.ts");
      writeFileSync(path, options.mode ? preload(options.mode) : `await Bun.sleep(${options.startupDelayMs});`);
      preloads.push("--preload", path);
    }
    child = Bun.spawn([process.execPath, ...preloads, resolve("src/index.ts"), "assess", rubricPath,
      "--evidence-root", root, "--evidence-index", join(root, "index.json"), "--out", outDir,
      "--model", "agent=claude-sonnet-4-6", "--max-time", options.maxTime ?? "2m",
      ...(options.hardDeadline === undefined ? [] : ["--hard-deadline-at-ms", String(options.hardDeadline)]),
      ...(options.verbose ? ["--verbose"] : []),
    ], {
      cwd: resolve("."), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ANTHROPIC_BASE_URL: String(server.url), ANTHROPIC_API_KEY: "fixture-key",
        CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_AUTH_TOKEN: "", FIXTURE_OUT: outDir,
        FIXTURE_MARKER: join(outDir, "assessment-completion.json") },
    });
    const watchdog = setTimeout(() => child!.kill("SIGKILL"), 4000);
    let code: number, stdout: string, stderr: string;
    try {
      [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    } finally { clearTimeout(watchdog); }
    const json = (file: string) => existsSync(join(outDir, file)) ? JSON.parse(readFileSync(join(outDir, file), "utf8")) : undefined;
    check({ code, outDir, requests, stdout, stderr, marker: json("assessment-completion.json"), result: json("result.json"),
      events: attemptRows(outDir, "run.jsonl"), attempts: attemptRows(outDir), usage: attemptRows(outDir, "usage.jsonl") });
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    for (const timer of timers) clearTimeout(timer);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

test("a timely report decision survives the publication reserve", () => {
  let now = 114_999;
  const state = createAssessmentDecision(115_000, () => now);
  expect(state.decide("report", "valid native report")).toBe(true);
  now = 117_000;
  expect(state.decide("timed_out", "work timer fired")).toBe(false);
  expect(state.current()?.kind).toBe("report");
  expect(state.current()?.atMs).toBe(114_999);
});

test.each(["pass", "fail", "unclear"] as const)("real CLI completes a valid %s with exactly linked physical usage", async verdict => {
  await withCli({ verdict }, fx => {
    expect(fx.stderr).toBe("");
    expect(fx.code).toBe(verdict === "pass" ? 0 : 1);
    expect(fx.marker?.status).toBe("completed");
    expect(fx.result.criteria[0].verdict).toBe(verdict);
    expect(fx.result.usage).toMatchObject({ inputTokens: 6, outputTokens: 4, cacheReadInputTokens: 2, turns: 2 });
    expect(fx.usage).toHaveLength(2);
    const requests = fx.events.filter(row => row.type === "llm_request");
    const responses = fx.events.filter(row => row.type === "llm_response");
    expect(requests.map(row => [row.turn, row.assessment_request_id])).toEqual([[1, "001"], [2, "002"]]);
    expect(responses.map(row => [row.turn, row.assessment_request_id])).toEqual([[1, "001"], [2, "002"]]);
    expect(fx.attempts.filter(row => row.event === "admission").map(row => row.assessment_request_id)).toEqual(["001", "002"]);
    expect(fx.usage.map(row => [row.assessment_request_id, row.assessment_attempt_id])).toEqual([["001", "001"], ["002", "002"]]);
  });
});

test("CLI inherited deadline includes startup delay and admits no expired work", async () => {
  await withCli({ hardDeadline: Date.now() + 5100, startupDelayMs: 250 }, fx => {
    expect(fx.requests).toBe(0);
    expect(fx.marker?.status).toBe("timed_out");
    expect(fx.result?.criteria).toBeUndefined();
    expect(fx.attempts).toHaveLength(0);
    expect(fx.events.filter(row => row.type === "llm_request" || row.type === "llm_response")).toHaveLength(0);
  });
});

test("CLI max-time reserves five seconds and aborts the pending SDK request", async () => {
  await withCli({ maxTime: "5100ms" }, fx => {
    expect(fx.requests).toBe(1);
    expect(fx.marker?.status).toBe("timed_out");
    expect(fx.result?.criteria).toBeUndefined();
    expect(fx.attempts.filter(row => row.event === "settlement")).toMatchObject([{ outcome: "aborted", usage: "not_returned" }]);
    expect(fx.events.find(row => row.type === "run_error")?.message).toMatch(/aborted/i);
    expect(fx.events.filter(row => row.type === "llm_request")).toMatchObject([{ turn: 1, assessment_request_id: "001" }]);
    expect(fx.events.filter(row => row.type === "llm_response")).toHaveLength(0);
  });
});

test.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)("CLI cooperatively publishes cancellation for %s", async signal => {
  await withCli({ signal }, fx => {
    expect(fx.marker?.status).toBe("cancelled");
    expect(fx.marker?.reason).toContain(signal);
    expect(fx.requests).toBe(1);
    expect(fx.result?.criteria).toBeUndefined();
    expect(fx.usage).toHaveLength(0);
    expect(fx.attempts.filter(row => row.event === "settlement")).toHaveLength(1);
    expect(fx.events.at(-1)?.type).toBe("run_end");
  });
});

test.each(["delayed", "cancel-after"])("CLI timely report publishes at 117000 with durable evidence: %s", async mode => {
  await withCli({ mode }, fx => {
    expect(fx.code).toBe(0);
    expect(fx.stderr).toBe("");
    expect(fx.marker).toMatchObject({ status: "completed", terminal_at: "1970-01-01T00:01:54.999Z" });
    expect(fx.marker.accepted_report_sha256).toBe(createHash("sha256").update(readFileSync(join(fx.outDir, "result.json"))).digest("hex"));
    expect(fx.events.filter(row => row.type === "run_end")).toHaveLength(1);
  });
});

test("CLI cancellation before the report decision retains late usage without accepting the report", async () => {
  await withCli({ mode: "cancel-before", bodyDelayMs: 25 }, fx => {
    expect(fx.requests).toBe(2);
    expect(fx.marker).toMatchObject({ status: "cancelled", accepted_report_sha256: null });
    expect(fx.result.criteria).toBeUndefined();
    expect(fx.usage).toHaveLength(2);
    expect(fx.result.usage).toMatchObject({ inputTokens: 6, outputTokens: 4 });
  });
});

test.each(["writer-failure", "double-fault"])("CLI publication failure remains operational for a semantic fail: %s", async mode => {
  await withCli({ mode, verdict: "fail" }, fx => {
    expect(fx.code).toBe(2);
    expect(fx.marker?.status).toBe(mode === "double-fault" ? "completed" : "errored");
    expect(fx.stderr).toContain(mode === "double-fault" ? "EEXIST" : "fixture");
    expect(fx.requests).toBe(2);
    expect(fx.usage).toHaveLength(2);
  });
});

test("CLI API failure records a request without a fabricated logical response or grade", async () => {
  await withCli({ apiError: true }, fx => {
    expect(fx.code).toBe(2);
    const message = JSON.parse(fx.stderr).error.message;
    expect(message.match(/fixture API error/g)).toHaveLength(1);
    expect(message).toBe(fx.events.find(row => row.type === "run_error")?.message);
    expect(fx.marker?.status).toBe("errored");
    expect(fx.result?.criteria).toBeUndefined();
    expect(fx.requests).toBe(1);
    expect(fx.events.filter(row => row.type === "llm_request")).toMatchObject([{ turn: 1, assessment_request_id: "001" }]);
    expect(fx.events.filter(row => row.type === "llm_response")).toHaveLength(0);
    expect(fx.attempts.filter(row => row.event === "settlement")).toMatchObject([{ usage_unavailable: "api_error" }]);
  });
});

test("CLI input parse failure publishes an operational marker when storage is writable", async () => {
  await withCli({ malformedRubric: true }, fx => {
    expect(fx.code).toBe(2);
    expect(fx.marker?.status).toBe("errored");
    expect(fx.requests).toBe(0);
    expect(fx.result?.criteria).toBeUndefined();
  });
});


test("CLI retains one logical identity across SDK retries and assigns the next turn a new identity", async () => {
  await withCli({ retry: true }, fx => {
    expect(fx.code).toBe(0);
    expect(fx.requests).toBe(4);
    expect(fx.events.filter(row => row.type === "llm_request").map(row => [row.turn, row.assessment_request_id]))
      .toEqual([[1, "001"], [2, "002"]]);
    expect(fx.events.filter(row => row.type === "llm_response")).toHaveLength(2);
    expect(fx.attempts.filter(row => row.event === "admission").map(row => [row.assessment_request_id, row.assessment_attempt_id]))
      .toEqual([["001", "001"], ["001", "002"], ["001", "003"], ["002", "004"]]);
    expect(fx.attempts.filter(row => row.event === "settlement").map(row => row.usage))
      .toEqual(["not_returned", "not_returned", "recorded", "recorded"]);
    expect(fx.usage.map(row => [row.assessment_request_id, row.assessment_attempt_id]))
      .toEqual([["001", "003"], ["002", "004"]]);
    expect(fx.result.usage).toMatchObject({ inputTokens: 6, outputTokens: 4, turns: 2 });
  });
});

test("CLI conversion failure retains physical usage and an honest zero-response interruption", async () => {
  await withCli({ conversionFailure: true }, fx => {
    expect(fx.code).toBe(2);
    expect(fx.marker?.status).toBe("errored");
    expect(fx.events.filter(row => row.type === "llm_request")).toMatchObject([{ turn: 1, assessment_request_id: "001" }]);
    expect(fx.events.filter(row => row.type === "llm_response")).toHaveLength(0);
    expect(fx.usage).toHaveLength(1);
    expect(fx.result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 1, turns: 0 });
    expect(fx.attempts.filter(row => row.event === "settlement")).toMatchObject([{ usage: "recorded" }]);
    expect(fx.result.criteria).toBeUndefined();
  });
});

test("CLI report returned at work expiry retains its physical usage without a completed marker", async () => {
  await withCli({ mode: "late", bodyDelayMs: 25 }, fx => {
    expect(fx.requests).toBe(2);
    expect(fx.marker).toMatchObject({ status: "timed_out", accepted_report_sha256: null });
    expect(fx.usage).toHaveLength(2);
    expect(fx.result.usage).toMatchObject({ inputTokens: 6, outputTokens: 4 });
    expect(fx.result.criteria).toBeUndefined();
    expect(fx.events.filter(row => row.type === "llm_response")).toHaveLength(2);
  });
});


test("CLI rubric identity failure retains an operational result with the requested run identity", async () => {
  await withCli({ mismatchedRubric: true }, fx => {
    expect(fx.code).toBe(2);
    expect(fx.marker?.status).toBe("errored");
    expect(fx.result?.scenario).toBe("assessment-cli");
    expect(fx.result?.criteria).toBeUndefined();
    expect(fx.requests).toBe(0);
  });
});

test("CLI verbose API error retains the original LlmError stack", async () => {
  await withCli({ apiError: true, verbose: true }, fx => {
    expect(fx.code).toBe(2);
    const [envelope, ...stack] = fx.stderr.trim().split("\n");
    const message = JSON.parse(envelope).error.message;
    expect(stack[0]).toBe(`LlmError: ${message}`);
    expect(stack.join("\n")).toContain("sanitize-error.ts");
    expect(stack.join("\n")).not.toContain("finalizeAssessment");
  });
});

test("CLI verbose setup error retains its original parser stack", async () => {
  await withCli({ malformedRubric: true, verbose: true }, fx => {
    expect(fx.code).toBe(2);
    expect(fx.stderr).toContain("at parseStoryCard");
    expect(fx.stderr).not.toContain("finalizeAssessment");
  });
});

test.each([
  ["api", "writer-failure"], ["setup", "writer-failure"],
  ["api", "double-fault"], ["setup", "double-fault"],
] as const)("CLI retains both %s and publication failure diagnostics: %s", async (phase, mode) => {
  await withCli({ apiError: phase === "api", malformedRubric: phase === "setup", mode }, fx => {
    expect(fx.code).toBe(2);
    expect(fx.marker).toMatchObject({ status: "errored", reason: mode === "writer-failure"
      ? "Assessment publication failed: fixture writer failure" : fx.result.reasoning });
    const message = JSON.parse(fx.stderr).error.message;
    expect(message).toContain(phase === "api" ? "fixture API error" : "Story card missing required field: id");
    expect(message).toContain(mode === "writer-failure"
      ? "Assessment publication failed: fixture writer failure" : "fixture marker rollback failure");
    expect(fx.result.criteria).toBeUndefined();
  });
});

test("CLI serialization omits zero cache totals while physical usage retains explicit zeros", async () => {
  await withCli({ zeroCache: true }, fx => {
    expect(fx.code).toBe(0);
    expect(fx.marker?.status).toBe("completed");
    expect(fx.usage).toHaveLength(2);
    for (const row of fx.usage) expect(row.usage).toMatchObject({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    const expected = { inputTokens: 6, outputTokens: 4, turns: 2 };
    expect(fx.result.usage).toEqual(expected);
    expect(JSON.parse(fx.stdout).usage).toEqual(expected);
    expect(fx.events.find(row => row.type === "run_end")?.usage).toEqual(expected);
    expect(fx.marker.accepted_report_sha256).toBe(createHash("sha256").update(readFileSync(join(fx.outDir, "result.json"))).digest("hex"));
  });
});

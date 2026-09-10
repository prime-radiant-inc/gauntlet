import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "fs";
import { basename, dirname, join } from "path";
import {
  parseAssessmentCompletion,
  publishAssessment,
  type AssessmentCompletion,
} from "../../src/assessment/completion";
import { createAssessmentDecision, type AssessmentDecision } from "../../src/assessment/lifecycle";
import { writeResultFiles } from "../../src/evidence/writer";
import { RESULT_SCHEMA_VERSION, type VetResult } from "../../src/types";
import { asCardId, asRunId } from "../../src/util/brands";

const runId = asRunId("story-001_20260909T120000Z_test");
const atMs = Date.parse("2026-09-09T12:01:54.999Z");
const result: VetResult = {
  schemaVersion: RESULT_SCHEMA_VERSION,
  runId,
  scenario: asCardId("story-001"),
  status: "pass",
  summary: "The café meets the criteria ✓",
  reasoning: "All retained evidence supports the report.",
  observations: [{ kind: "bug", description: "Submit button missing", evidence: ["screen.txt"] }],
  criteria: [{ criterion: "The submission works", verdict: "pass", evidence: "screen.txt: Submitted" }],
  evidence: { screenshots: ["screenshots/001.png"], log: "run.jsonl" },
  duration_ms: 114_999,
  usage: { inputTokens: 120, outputTokens: 30, turns: 2 },
};
const decision: AssessmentDecision = { kind: "report", atMs, reason: "valid native report" };
const completion: AssessmentCompletion = {
  schema_version: 1,
  run_id: runId,
  status: "completed",
  reason: "valid native report",
  terminal_at: "2026-09-09T12:01:54.999Z",
  accepted_report_sha256: "abcdef0123456789".repeat(4),
};

describe("parseAssessmentCompletion", () => {
  test("accepts a completed assessment and each operational stop", () => {
    expect(parseAssessmentCompletion(completion)).toEqual(completion);
    for (const status of ["timed_out", "cancelled", "errored"] as const) {
      const value = { ...completion, status, accepted_report_sha256: null };
      expect(parseAssessmentCompletion(value)).toEqual(value);
    }
  });

  test.each([
    null, [], "completed", {},
    { ...completion, schema_version: 2 },
    { ...completion, schema_version: "1" },
    { ...completion, run_id: "" },
    { ...completion, run_id: "../another-run" },
    { ...completion, run_id: 123 },
    { ...completion, status: "pass" },
    { ...completion, status: null },
    { ...completion, reason: " " },
    { ...completion, reason: 123 },
    { ...completion, terminal_at: atMs },
    { ...completion, terminal_at: "not a timestamp" },
    { ...completion, terminal_at: "2026-02-30T12:00:00.000Z" },
    { ...completion, accepted_report_sha256: null },
    { ...completion, accepted_report_sha256: "f".repeat(63) },
    { ...completion, accepted_report_sha256: "z".repeat(64) },
    { ...completion, accepted_report_sha256: 123 },
    { ...completion, status: "timed_out" },
    { ...completion, status: "cancelled" },
    { ...completion, status: "errored" },
    { ...completion, status: "errored", accepted_report_sha256: undefined },
  ].map((value) => [value]))("rejects invalid or contradictory completion data: %j", (value) => {
    expect(() => parseAssessmentCompletion(value)).toThrow();
  });
});

describe("publishAssessment", () => {
  let root: string;
  let outDir: string;
  let markerPath: string;
  const restores: Array<() => void> = [];

  beforeEach(() => {
    root = fs.mkdtempSync(join(import.meta.dir, ".completion-test-"));
    outDir = join(root, runId);
    fs.mkdirSync(outDir);
    markerPath = join(outDir, "assessment-completion.json");
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function publish(overrides: Partial<Parameters<typeof publishAssessment>[0]> = {}) {
    return publishAssessment({ outDir, runId, result, decision, beforeMarker() {}, ...overrides });
  }

  function readCompletion() {
    return parseAssessmentCompletion(JSON.parse(fs.readFileSync(markerPath, "utf8")));
  }

  function expectErrored() {
    expect(readCompletion()).toMatchObject({
      run_id: runId, status: "errored", accepted_report_sha256: null,
    });
  }

  test.each(["pass", "fail", "investigate"] as const)("publishes the exact generic writer bytes for a valid %s grade", (status) => {
    const grade: VetResult = {
      ...result,
      status,
      criteria: [{ ...result.criteria![0], verdict: status === "investigate" ? "unclear" : status }],
    };
    const ordinaryDir = join(root, "ordinary");
    fs.mkdirSync(ordinaryDir);
    writeResultFiles(ordinaryDir, grade);
    const marker = publish({ result: grade });
    expect(marker).toEqual(readCompletion());
    expect(marker).toMatchObject({
      schema_version: 1, run_id: runId, status: "completed",
      reason: decision.reason, terminal_at: "2026-09-09T12:01:54.999Z",
    });
    for (const file of ["result.json", "result.md", "issues/001-bug-submit-button-missing.md"]) {
      expect(fs.readFileSync(join(outDir, file))).toEqual(fs.readFileSync(join(ordinaryDir, file)));
    }
    const bytes = fs.readFileSync(join(outDir, "result.json"));
    expect(marker.accepted_report_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(fs.readdirSync(outDir).sort()).toEqual(["assessment-completion.json", "issues", "result.json", "result.md"]);
    expect(fs.readdirSync(join(outDir, "issues"))).toEqual(["001-bug-submit-button-missing.md"]);
  });

  test("the optional generic writer receives every generated file without writing it", () => {
    const files = new Map<string, string>();
    writeResultFiles(outDir, result, (path, text) => files.set(path, text));
    expect(fs.existsSync(join(outDir, "result.json"))).toBe(false);
    expect(fs.existsSync(join(outDir, "result.md"))).toBe(false);
    expect(fs.readdirSync(join(outDir, "issues"))).toEqual([]);
    expect([...files.keys()]).toEqual([
      join(outDir, "result.json"), join(outDir, "result.md"),
      join(outDir, "issues/001-bug-submit-button-missing.md"),
    ]);
    expect(JSON.parse(files.get(join(outDir, "result.json"))!)).toEqual(result);
  });

  test("publishes a report selected before the deadline during the finalization reserve", () => {
    let now = atMs;
    const state = createAssessmentDecision(atMs + 1, () => now);
    expect(state.decide("report", decision.reason)).toBe(true);
    now += 4_000;
    const marker = publish({
      decision: state.current()!,
      beforeMarker() {
        expect(fs.existsSync(markerPath)).toBe(false);
        expect(JSON.parse(fs.readFileSync(join(outDir, "result.json"), "utf8"))).toEqual(result);
        expect(fs.existsSync(join(outDir, "result.md"))).toBe(true);
        expect(fs.readdirSync(join(outDir, "issues"))).toHaveLength(1);
        fs.writeFileSync(join(outDir, "run.jsonl"), '{"event":"sealed"}\n');
        expect(state.decide("timed_out", "work deadline elapsed")).toBe(false);
      },
    });
    expect(marker.status).toBe("completed");
    expect(marker.terminal_at).toBe("2026-09-09T12:01:54.999Z");
    expect(fs.readFileSync(join(outDir, "run.jsonl"), "utf8")).toBe('{"event":"sealed"}\n');
  });

  test.each(["timed_out", "cancelled", "errored"] as const)("publishes %s without accepting the retained result", (kind) => {
    const incomplete: VetResult = { ...result, status: "investigate", criteria: undefined };
    const marker = publish({ result: incomplete, decision: { ...decision, kind } });
    expect(marker).toMatchObject({ status: kind, accepted_report_sha256: null });
    expect(readCompletion()).toEqual(marker);
    expect(JSON.parse(fs.readFileSync(join(outDir, "result.json"), "utf8")).criteria).toBeUndefined();
  });

  test.each([
    { runId: "invalid" },
    { runId: "other_20260909T120000Z_test" },
    { result: { ...result, runId: asRunId("other_20260909T120000Z_test") } },
    { result: { ...result, scenario: asCardId("other") } },
    { decision: { ...decision, atMs: NaN } },
    { result: { ...result, status: "errored", error: { type: "writer", message: "failed" } } as VetResult },
  ])("rejects contradictory publication inputs before writing: %j", (overrides) => {
    expect(() => publish(overrides)).toThrow();
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  test("rejects a mismatched output directory identity before writing", () => {
    expect(() => publish({ outDir: root })).toThrow();
    expect(fs.readdirSync(root)).toEqual([runId]);
  });

  test("a failed result rename preserves existing bytes and publishes only an errored marker", () => {
    const resultPath = join(outDir, "result.json");
    fs.writeFileSync(resultPath, "retained report bytes\n");
    const rename = fs.renameSync;
    const fault = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === resultPath) throw new Error("injected result rename failure");
      rename(source, destination);
    });
    restores.push(() => fault.mockRestore());
    const state = createAssessmentDecision(atMs + 1, () => atMs);
    state.decide("report", decision.reason);
    expect(publish({ decision: state.current()! }).status).toBe("errored");
    expect(fs.readFileSync(resultPath, "utf8")).toBe("retained report bytes\n");
    expect(state.current()?.kind).toBe("report");
    expect(state.decide("errored", "publication failed")).toBe(false);
    expectErrored();
    expect(fs.readdirSync(outDir).sort()).toEqual(["assessment-completion.json", "result.json"]);
  });

  test.each(["result.md", "issues/001-bug-submit-button-missing.md"])("a failure writing %s cannot publish a completed partial result", (file) => {
    fs.mkdirSync(join(outDir, file), { recursive: true });
    const marker = publish();
    expect(marker.status).toBe("errored");
    expect(fs.existsSync(join(outDir, "result.json"))).toBe(true);
    expectErrored();
  });

  test("a sealing failure publishes an errored marker after retaining report files", () => {
    const marker = publish({ beforeMarker() { throw new Error("injected evidence sealing failure"); } });
    expect(marker.reason).toContain("injected evidence sealing failure");
    expect(fs.existsSync(join(outDir, "result.md"))).toBe(true);
    expectErrored();
  });

  test("duplicate publication preserves both the original marker and its accepted report", () => {
    publish();
    const markerBytes = fs.readFileSync(markerPath);
    const reportBytes = fs.readFileSync(join(outDir, "result.json"));
    expect(() => publish({ result: { ...result, summary: "competing report" } })).toThrow();
    expect(fs.readFileSync(markerPath)).toEqual(markerBytes);
    expect(fs.readFileSync(join(outDir, "result.json"))).toEqual(reportBytes);
  });

  test("a competing marker created while sealing is never overwritten", () => {
    const winner = JSON.stringify({ ...completion, status: "cancelled", accepted_report_sha256: null });
    expect(() => publish({ beforeMarker() { fs.writeFileSync(markerPath, winner, { flag: "wx" }); } })).toThrow();
    expect(fs.readFileSync(markerPath, "utf8")).toBe(winner);
    expect(fs.readdirSync(outDir).sort()).toEqual(["assessment-completion.json", "issues", "result.json", "result.md"]);
  });

  test("a failed completed-marker link can publish an errored marker without replacement", () => {
    const link = fs.linkSync;
    const fault = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (destination === markerPath && JSON.parse(fs.readFileSync(source, "utf8")).status === "completed") {
        throw new Error("injected marker link failure");
      }
      link(source, destination);
    });
    restores.push(() => fault.mockRestore());
    expect(publish().reason).toContain("injected marker link failure");
    expectErrored();
  });

  test("unwritable marker storage leaves no fabricated completion marker", () => {
    const fault = spyOn(fs, "linkSync").mockImplementation(() => { throw new Error("injected storage failure"); });
    restores.push(() => fault.mockRestore());
    expect(() => publish()).toThrow("injected storage failure");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readdirSync(outDir).sort()).toEqual(["issues", "result.json", "result.md"]);
  });

  test("a missing storage directory cannot fabricate a marker", () => {
    fs.rmdirSync(outDir);
    expect(() => publish()).toThrow();
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  test("files are synced before atomic publication and containing directories are synced", () => {
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    const link = fs.linkSync;
    const syncedFiles = new Set<number>();
    const syncedDirectories = new Set<number>();
    const syncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      sync(fd);
      const stat = fs.fstatSync(fd);
      (stat.isDirectory() ? syncedDirectories : syncedFiles).add(stat.ino);
    });
    const renameSpy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      expect(dirname(String(source))).toBe(dirname(String(destination)));
      expect(source).not.toBe(destination);
      expect(syncedFiles.has(fs.statSync(source).ino)).toBe(true);
      rename(source, destination);
    });
    const linkSpy = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      expect(destination).toBe(markerPath);
      expect(dirname(String(source))).toBe(outDir);
      expect(basename(String(source))).not.toBe("assessment-completion.json");
      expect(syncedFiles.has(fs.statSync(source).ino)).toBe(true);
      expect(JSON.parse(fs.readFileSync(source, "utf8")).status).toBe("completed");
      link(source, destination);
    });
    restores.push(() => syncSpy.mockRestore(), () => renameSpy.mockRestore(), () => linkSpy.mockRestore());
    publish();
    expect(syncedFiles.size).toBe(4);
    expect(syncedDirectories.has(fs.statSync(outDir).ino)).toBe(true);
    expect(syncedDirectories.has(fs.statSync(join(outDir, "issues")).ino)).toBe(true);
  });

  test("a marker directory-sync failure removes completed publication before recording the error", () => {
    const sync = fs.fsyncSync;
    let failed = false;
    const fault = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (!failed && fs.fstatSync(fd).isDirectory() && fs.existsSync(markerPath)) {
        failed = true;
        throw new Error("injected marker directory sync failure");
      }
      sync(fd);
    });
    restores.push(() => fault.mockRestore());
    expect(publish().reason).toContain("injected marker directory sync failure");
    expectErrored();
  });
});

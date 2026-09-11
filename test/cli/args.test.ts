import { describe, test, expect } from "bun:test";
import { parseArgs } from "../../src/cli/args";

describe("parseArgs", () => {
  test("parses run command with required args", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "http://localhost:3000", "--out", "./evidence"]);
    expect(args.command).toBe("run");
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.scenarioPath).toBe("story.md");
    expect(args.cli.target).toBe("http://localhost:3000");
    expect(args.outDir).toBe("./evidence");
  });

  test("defaults adapter to web", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "http://localhost:3000"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.adapter).toBe("web");
  });

  // Default outDir is derived from projectRoot + runId inside `run()`,
  // not baked in at parse time — so parseArgs must surface absence as
  // undefined. Bug fix: previously defaulted to "./evidence" (cwd),
  // which diverged from the serve path's `<project>/.gauntlet/results/<runId>`.
  test("leaves outDir undefined when --out is not provided", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "http://localhost:3000"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.outDir).toBeUndefined();
  });

  test("parses cli adapter flag", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "cmd", "--adapter", "cli"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.adapter).toBe("cli");
  });

  test("parses tui adapter flag", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "nano test.txt", "--adapter", "tui"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.adapter).toBe("tui");
  });

  test("rejects unknown --adapter value", () => {
    expect(() =>
      parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--adapter", "wat"]),
    ).toThrow(/must be one of/);
  });

  test("parses model flags", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--model", "agent=gpt-4o", "--model", "fanout=claude-sonnet-4-6"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.cli.models?.agent).toBe("gpt-4o");
    expect(args.cli.models?.fanout).toBe("claude-sonnet-4-6");
  });

  test("warns and drops bare --model values (no role prefix)", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...m: unknown[]) => { warnings.push(m.map(String).join(" ")); };
    try {
      const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--model", "claude-opus-4-7"]);
      if (args.command !== "run") throw new Error("unreachable");
      expect(args.cli.models?.agent).toBeUndefined();
      expect(args.cli.models?.fanout).toBeUndefined();
      expect(warnings.some((w) => w.includes("claude-opus-4-7") && w.includes("agent=") && w.includes("fanout="))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test("warns and drops --model with unknown role prefix", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...m: unknown[]) => { warnings.push(m.map(String).join(" ")); };
    try {
      const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--model", "gpt=foo"]);
      if (args.command !== "run") throw new Error("unreachable");
      expect(args.cli.models?.agent).toBeUndefined();
      expect(warnings.some((w) => w.includes("gpt=foo") && w.includes("unknown role"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test("throws on missing target", () => {
    expect(() => parseArgs(["bun", "index.ts", "run", "story.md"])).toThrow("--target");
  });

  test("throws on missing scenario path", () => {
    expect(() => parseArgs(["bun", "index.ts", "run"])).toThrow();
  });

  test("parses chrome flag", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--chrome", "localhost:9222"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.cli.chrome).toBe("localhost:9222");
  });

  test("parses validate command", () => {
    const args = parseArgs(["bun", "index.ts", "validate", "story.md"]);
    expect(args.command).toBe("validate");
    expect(args.scenarioPath).toBe("story.md");
  });

  test("parses fanout command with scenario path", () => {
    const args = parseArgs(["bun", "index.ts", "fanout", "story.md", "--out", "./cards"]);
    expect(args.command).toBe("fanout");
    if (args.command !== "fanout") throw new Error("unreachable");
    expect(args.scenarioPath).toBe("story.md");
    expect(args.resultDir).toBeUndefined();
    expect(args.outDir).toBe("./cards");
  });

  test("parses fanout --from-result flag", () => {
    const args = parseArgs(["bun", "index.ts", "fanout", "--from-result", "./evidence/story-001", "--out", "./cards"]);
    expect(args.command).toBe("fanout");
    if (args.command !== "fanout") throw new Error("unreachable");
    expect(args.resultDir).toBe("./evidence/story-001");
    expect(args.scenarioPath).toBeUndefined();
    expect(args.outDir).toBe("./cards");
  });

  test("fanout throws when neither scenario path nor --from-result provided", () => {
    expect(() => parseArgs(["bun", "index.ts", "fanout"])).toThrow();
  });

  test("accepts --silent as a bareword flag on run", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--silent"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.silent).toBe(true);
  });

  test("accepts --format pretty", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--format", "pretty"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.format).toBe("pretty");
  });

  test("accepts --format jsonl", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--format", "jsonl"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.format).toBe("jsonl");
  });

  test("rejects --format garbage", () => {
    expect(() => parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--format", "nope"]))
      .toThrow(/Invalid --format/);
  });

  test("accepts --no-color as a bareword flag", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--no-color"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.noColor).toBe(true);
  });

  test("leaves silent/format/noColor undefined or false when omitted", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.silent).toBe(false);
    expect(args.format).toBeUndefined();
    expect(args.noColor).toBe(false);
  });

  test("parses batch with multiple positional cards", () => {
    const args = parseArgs([
      "bun", "index.ts", "batch", "a.md", "b.md",
      "--target", "http://localhost:3000",
    ]);
    expect(args.command).toBe("batch");
    if (args.command !== "batch") throw new Error("unreachable");
    expect(args.scenarioPaths).toEqual(["a.md", "b.md"]);
    expect(args.cli.target).toBe("http://localhost:3000");
    expect(args.silent).toBe(false);
    expect(args.format).toBeUndefined();
    expect(args.noColor).toBe(false);
  });

  test("batch rejects --out", () => {
    expect(() =>
      parseArgs(["bun", "index.ts", "batch", "a.md", "--target", "u", "--out", "/tmp"]),
    ).toThrow(/Unknown flag/);
  });

  test("batch requires at least one card", () => {
    expect(() =>
      parseArgs(["bun", "index.ts", "batch", "--target", "u"]),
    ).toThrow(/at least one/i);
  });

  test("batch requires --target", () => {
    expect(() => parseArgs(["bun", "index.ts", "batch", "a.md"])).toThrow(/--target/);
  });

  test("batch parses --silent and --format jsonl", () => {
    const args = parseArgs([
      "bun", "index.ts", "batch", "a.md", "--target", "u",
      "--silent", "--format", "jsonl",
    ]);
    if (args.command !== "batch") throw new Error("unreachable");
    expect(args.silent).toBe(true);
    expect(args.format).toBe("jsonl");
  });
});

describe("--passes flag", () => {
  test("run defaults to passes: 1 when omitted", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "https://x"]);
    expect(args.command).toBe("run");
    if (args.command === "run") expect(args.passes).toBe(1);
  });

  test("run accepts --passes 3", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "https://x", "--passes", "3"]);
    if (args.command === "run") expect(args.passes).toBe(3);
  });

  test("batch accepts --passes", () => {
    const args = parseArgs(["bun", "index.ts", "batch", "a.md", "b.md", "--target", "https://x", "--passes", "2"]);
    if (args.command === "batch") expect(args.passes).toBe(2);
  });

  test("rejects --passes 0", () => {
    expect(() => parseArgs(["bun", "index.ts", "run", "story.md", "--target", "https://x", "--passes", "0"])).toThrow(/passes/i);
  });

  test("rejects --passes 51 (over soft cap)", () => {
    expect(() => parseArgs(["bun", "index.ts", "run", "story.md", "--target", "https://x", "--passes", "51"])).toThrow(/passes/i);
  });

  test("rejects non-integer --passes", () => {
    expect(() => parseArgs(["bun", "index.ts", "run", "story.md", "--target", "https://x", "--passes", "1.5"])).toThrow(/passes/i);
  });
});

describe("converse command", () => {
  const argv = [
    "bun", "index.ts", "converse", "/run/conversation-input/user-brief.md",
    "--launcher", "/run/launch-subject",
    "--workspace", "/run/workspace",
    "--out", "/run/conversation-agent/card-001_20260907T120000Z_ab12",
    "--completion", "/run/conversation.json",
    "--tmux-socket", "/run/tmux.sock",
    "--model", "agent=claude-sonnet-4-6",
    "--max-time", "10m",
    "--startup", "claude",
  ];

  test("parses the exact conversation role inputs and validates its run id", () => {
    const args = parseArgs(argv);
    expect(args).toEqual({
      command: "converse",
      briefPath: "/run/conversation-input/user-brief.md",
      launcherPath: "/run/launch-subject",
      workspace: "/run/workspace",
      outDir: "/run/conversation-agent/card-001_20260907T120000Z_ab12",
      completionPath: "/run/conversation.json",
      tmuxSocketPath: "/run/tmux.sock",
      model: "claude-sonnet-4-6",
      maxTimeMs: 600_000,
      startup: "claude",
      runId: "card-001_20260907T120000Z_ab12",
      cardId: "card-001",
    });
  });

  test("requires every conversation role flag", () => {
    for (const flag of [
      "--launcher", "--workspace", "--out", "--completion",
      "--tmux-socket", "--model", "--max-time",
    ]) {
      const index = argv.indexOf(flag);
      const without = [...argv.slice(0, index), ...argv.slice(index + 2)];
      expect(() => parseArgs(without)).toThrow(new RegExp(flag));
    }
  });

  test("rejects unsupported flags and model roles", () => {
    expect(() => parseArgs([...argv, "--credential", "secret"])).toThrow(/Unknown flag/);
    const modelIndex = argv.indexOf("--model") + 1;
    const withFanout = [...argv];
    withFanout[modelIndex] = "fanout=claude-sonnet-4-6";
    expect(() => parseArgs(withFanout)).toThrow(/agent=/);
    const unsupportedStartup = [...argv];
    unsupportedStartup[unsupportedStartup.indexOf("claude")] = "codex";
    expect(() => parseArgs(unsupportedStartup)).toThrow(/--startup.*claude/i);
  });

  test("rejects non-absolute process paths and malformed output run ids", () => {
    for (const flag of ["--launcher", "--workspace", "--completion", "--tmux-socket"]) {
      const invalid = [...argv];
      invalid[invalid.indexOf(flag) + 1] = "relative/path";
      expect(() => parseArgs(invalid)).toThrow(/absolute/i);
    }

    const invalidOut = [...argv];
    invalidOut[invalidOut.indexOf("--out") + 1] = "/run/conversation-agent/not-a-run-id";
    expect(() => parseArgs(invalidOut)).toThrow(/run id/i);
  });
});

describe("assess command", () => {
  const argv = [
    "bun", "index.ts", "assess", "/run/conversation-input/rubric.md",
    "--evidence-root", "/run/evidence",
    "--evidence-index", "/run/evidence/index.json",
    "--out", "/run/gauntlet-agent/results/card-001_20260907T120000Z_ab12",
    "--model", "agent=claude-sonnet-4-6",
    "--max-time", "2m",
  ];

  test("parses the exact assessment role inputs and validates its run id", () => {
    expect(parseArgs(argv)).toEqual({
      command: "assess",
      rubricPath: "/run/conversation-input/rubric.md",
      evidenceRoot: "/run/evidence",
      evidenceIndexPath: "/run/evidence/index.json",
      outDir: "/run/gauntlet-agent/results/card-001_20260907T120000Z_ab12",
      model: "claude-sonnet-4-6",
      maxTimeMs: 120_000,
      reportGraceMs: 0,
      runId: "card-001_20260907T120000Z_ab12",
      cardId: "card-001",
    });
  });

  test("parses explicit report grace and rejects a grace that consumes inspection", () => {
    expect(parseArgs([...argv, "--report-grace", "60s"])).toMatchObject({ reportGraceMs: 60000 });
    expect(() => parseArgs([...argv, "--report-grace", "115s"])).toThrow(/deadline/);
  });

  test("accepts a safe integer inherited epoch deadline only for assess", () => {
    expect(parseArgs([...argv, "--hard-deadline-at-ms", "1788955320000"]))
      .toMatchObject({ hardDeadlineAtMs: 1788955320000 });
    expect(() => parseArgs(["bun", "index.ts", "run", "card.md", "--hard-deadline-at-ms", "1788955320000"]))
      .toThrow(/Unknown flag/);
  });

  test.each(["NaN", "Infinity", "1.5", "123junk", "1e3", "9007199254740992", "true", ""])(
    "rejects an invalid inherited deadline %j", (value) => {
      expect(() => parseArgs([...argv, "--hard-deadline-at-ms", value]))
        .toThrow(/hard-deadline-at-ms.*integer/i);
    },
  );

  test.each(["0ms", "4999ms", "5s"])("rejects an allowance without work time: %s", (value) => {
    const invalid = [...argv];
    invalid[invalid.indexOf("--max-time") + 1] = value;
    expect(() => parseArgs(invalid)).toThrow(/reserve|deadline|positive/);
  });

  test("requires every assessment role flag", () => {
    for (const flag of [
      "--evidence-root", "--evidence-index", "--out", "--model", "--max-time",
    ]) {
      const index = argv.indexOf(flag);
      const without = [...argv.slice(0, index), ...argv.slice(index + 2)];
      expect(() => parseArgs(without)).toThrow(new RegExp(flag));
    }
  });

  test("rejects unsupported flags, model roles, relative paths, and malformed run ids", () => {
    expect(() => parseArgs([...argv, "--adapter", "tui"])).toThrow(/Unknown flag/);

    const withFanout = [...argv];
    withFanout[withFanout.indexOf("--model") + 1] = "fanout=claude-sonnet-4-6";
    expect(() => parseArgs(withFanout)).toThrow(/agent=/);

    for (const flag of ["--evidence-root", "--evidence-index", "--out"]) {
      const invalid = [...argv];
      invalid[invalid.indexOf(flag) + 1] = "relative/path";
      expect(() => parseArgs(invalid)).toThrow(/absolute/i);
    }

    const invalidOut = [...argv];
    invalidOut[invalidOut.indexOf("--out") + 1] = "/run/gauntlet-agent/results/not-a-run-id";
    expect(() => parseArgs(invalidOut)).toThrow(/run id/i);
  });
});

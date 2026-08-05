import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { TUIAdapter } from "../../../src/adapters/tui/adapter";
import { EvidenceLogger } from "../../../src/evidence/logger";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmuxAvailable = (() => {
  try {
    const result = Bun.spawnSync(["tmux", "-V"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!tmuxAvailable)("TUIAdapter", () => {
  let adapter: TUIAdapter | null = null;
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "tui-unit-"));
  });

  afterEach(async () => {
    if (adapter) {
      try {
        await adapter.close();
      } catch {
        // session may already be dead
      }
    }
    adapter = null;
    rmSync(runDir, { recursive: true, force: true });
  });

  test("start() requires runDir", async () => {
    adapter = new TUIAdapter();
    await expect(adapter.start("anything")).rejects.toThrow(/runDir/);
  });

  test("start() creates <runDir>/scratch and runs bash in it", async () => {
    const localRunDir = mkdtempSync(join(tmpdir(), "tui-start-"));
    try {
      adapter = new TUIAdapter({ runDir: localRunDir });
      await adapter.start("informational");
      await new Promise((r) => setTimeout(r, 300));
      await adapter.type("pwd\n");
      await new Promise((r) => setTimeout(r, 300));
      const screen = await adapter.readScreen();
      expect(screen).toContain(join(localRunDir, "scratch"));
    } finally {
      rmSync(localRunDir, { recursive: true, force: true });
    }
  });

  test("starts a bash session in tmux and runs a typed command", async () => {
    adapter = new TUIAdapter({ runDir });
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.type("echo hello from tmux\n");
    await new Promise((r) => setTimeout(r, 300));
    const screen = await adapter.readScreen();
    expect(screen).toContain("hello from tmux");
  });

  test("sends keystrokes via tmux: launches bc and computes", async () => {
    adapter = new TUIAdapter({ runDir });
    await adapter.start("bc");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.type("bc -q\n");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.type("2+3");
    await adapter.press("Enter");
    await new Promise((r) => setTimeout(r, 300));
    const screen = await adapter.readScreen();
    expect(screen).toContain("5");
  });

  test("typeAndSubmit delivers text and submits in one shot", async () => {
    adapter = new TUIAdapter({ runDir });
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.typeAndSubmit("echo combined-submit");
    await new Promise((r) => setTimeout(r, 300));
    const screen = await adapter.readScreen();
    expect(screen).toContain("combined-submit");
    expect(screen).toContain("echo combined-submit");
  });

  test("executeTool dispatches type_and_submit", async () => {
    adapter = new TUIAdapter({ runDir });
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-tui-tas-"));
    const innerLogger = new EvidenceLogger(logDir);
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    const result = await adapter.executeTool(
      "type_and_submit",
      { text: "echo tool-dispatch" },
      innerLogger,
    );
    expect(result.text).toBe("typed and submitted");
    await new Promise((r) => setTimeout(r, 300));
    const screen = await adapter.readScreen();
    expect(screen).toContain("tool-dispatch");
  });

  test("close kills the tmux session", async () => {
    adapter = new TUIAdapter({ runDir });
    await adapter.start("");
    const sessionName = adapter.sessionName;
    await adapter.close();
    const result = Bun.spawnSync(["tmux", "has-session", "-t", sessionName]);
    expect(result.exitCode).not.toBe(0);
    adapter = null;
  });

  test("close reaps backgrounded descendants and emits an event", async () => {
    const localRunDir = mkdtempSync(join(tmpdir(), "tui-close-"));
    const localLogDir = mkdtempSync(join(tmpdir(), "tui-close-log-"));
    const localLogger = new EvidenceLogger(localLogDir);
    // Small grace: sleep(1) ignores HUP, so it always burns the full window
    // before the SIGKILL this test exercises — keep the suite fast.
    adapter = new TUIAdapter({
      runDir: localRunDir,
      logger: localLogger,
      descendantGraceMs: 250,
    });
    try {
      await adapter.start("informational");
      await new Promise((r) => setTimeout(r, 300));
      // nohup: HUP-immune, so it survives the grace window and exercises the
      // SIGKILL orphan guarantee (a plain background sleep dies from bash's
      // HUP propagation during the grace and never needs reaping).
      await adapter.type("nohup sleep 999 >/dev/null 2>&1 & echo PID=$!\n");
      await new Promise((r) => setTimeout(r, 400));
      const screen = await adapter.readScreen();
      const match = screen.match(/PID=(\d+)/);
      expect(match).not.toBeNull();
      const sleepPid = Number(match![1]);
      expect(() => process.kill(sleepPid, 0)).not.toThrow();

      await adapter.close();
      adapter = null;
      await new Promise((r) => setTimeout(r, 150));

      expect(() => process.kill(sleepPid, 0)).toThrow();

      const jsonl = readFileSync(join(localLogDir, "run.jsonl"), "utf-8");
      expect(jsonl).toContain("tui_session_descendants_reaped");
    } finally {
      rmSync(localRunDir, { recursive: true, force: true });
      rmSync(localLogDir, { recursive: true, force: true });
    }
  });

  test("close grants a HUP-flush grace: a descendant that exits on HUP keeps its final write", async () => {
    const localRunDir = mkdtempSync(join(tmpdir(), "tui-close-grace-"));
    const localLogDir = mkdtempSync(join(tmpdir(), "tui-close-grace-log-"));
    const localLogger = new EvidenceLogger(localLogDir);
    adapter = new TUIAdapter({
      runDir: localRunDir,
      logger: localLogger,
      descendantGraceMs: 2000,
    });
    try {
      await adapter.start("informational");
      await new Promise((r) => setTimeout(r, 300));
      // Foreground descendant that flushes state on HUP after a short delay —
      // modeled on Copilot CLI, which writes its session.shutdown usage record
      // ~11ms after SIGHUP. An instant SIGKILL after kill-server loses that
      // flush; the grace window must let it complete.
      const marker = join(localRunDir, "flushed.marker");
      await adapter.type(
        `bash -c 'sleep 999 & S=$!; trap "sleep 0.3; echo done > ${marker}; kill \$S; exit 0" HUP; wait'\n`,
      );
      await new Promise((r) => setTimeout(r, 500));

      await adapter.close();
      adapter = null;

      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(localRunDir, { recursive: true, force: true });
      rmSync(localLogDir, { recursive: true, force: true });
    }
  });

  test("close emits no event when there are no descendants to reap", async () => {
    const localRunDir = mkdtempSync(join(tmpdir(), "tui-close-clean-"));
    const localLogDir = mkdtempSync(join(tmpdir(), "tui-close-clean-log-"));
    const localLogger = new EvidenceLogger(localLogDir);
    adapter = new TUIAdapter({ runDir: localRunDir, logger: localLogger });
    try {
      await adapter.start("informational");
      await new Promise((r) => setTimeout(r, 200));
      await adapter.close();
      adapter = null;
      const jsonl = (() => {
        try { return readFileSync(join(localLogDir, "run.jsonl"), "utf-8"); }
        catch { return ""; }
      })();
      expect(jsonl).not.toContain("tui_session_descendants_reaped");
    } finally {
      rmSync(localRunDir, { recursive: true, force: true });
      rmSync(localLogDir, { recursive: true, force: true });
    }
  });

  test("executeTool dispatches correctly and returns expected results", async () => {
    adapter = new TUIAdapter({ runDir });
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-tui-exec-"));
    const innerLogger = new EvidenceLogger(logDir);

    await adapter.start("bc");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.executeTool("type", { text: "bc -q\n" }, innerLogger);
    await new Promise((r) => setTimeout(r, 300));

    const typeResult = await adapter.executeTool("type", { text: "4*5" }, innerLogger);
    expect(typeResult.text).toBe("typed");

    const pressResult = await adapter.executeTool("press", { key: "Enter" }, innerLogger);
    expect(pressResult.text).toBe("pressed");

    await new Promise((r) => setTimeout(r, 300));

    const result = await adapter.executeTool("read_screen", {}, innerLogger);
    expect(result.text).toContain("20");

    const logPath = join(logDir, "run.jsonl");
    const logExists = (() => { try { readFileSync(logPath); return true; } catch { return false; } })();
    if (logExists) {
      const logContent = readFileSync(logPath, "utf-8");
      expect(logContent).not.toContain('"type":"tool_call"');
    }
  });

  test("read_screen writes capture files and returns capturePath", async () => {
    adapter = new TUIAdapter({ runDir });
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-tui-cap-"));
    const innerLogger = new EvidenceLogger(logDir);

    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.type("printf hello\n");
    await new Promise((r) => setTimeout(r, 300));

    const result = await adapter.executeTool("read_screen", {}, innerLogger);
    expect((result as { capturePath?: string }).capturePath).toBe("captures/000.ansi");
    expect(result.text).toContain("hello");

    expect(readFileSync(join(logDir, "captures/000.ansi"), "utf-8")).toContain("hello");
    const parsed = JSON.parse(readFileSync(join(logDir, "captures/000.json"), "utf-8"));
    expect(parsed.cols).toBe(120);
    expect(parsed.rows).toBe(40);
    expect(Array.isArray(parsed.cells)).toBe(true);

    const result2 = await adapter.executeTool("read_screen", {}, innerLogger);
    expect((result2 as { capturePath?: string }).capturePath).toBe("captures/001.ansi");
    expect(innerLogger.captures).toEqual(["captures/000.ansi", "captures/001.ansi"]);

    const logContent = readFileSync(join(logDir, "run.jsonl"), "utf-8");
    expect(logContent).toContain('"name":"tui_capture"');
  });

  test("readScreen preserves ANSI escape sequences", async () => {
    adapter = new TUIAdapter({ runDir });
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.type(`printf '\\033[31mX\\033[0m\\033[32mY\\033[0m\\n'\n`);
    await new Promise((r) => setTimeout(r, 300));
    const screen = await adapter.readScreen();
    expect(screen).toContain("X");
    expect(screen).toContain("Y");
    expect(screen).toMatch(/\x1b\[[0-9;]*31/);
    expect(screen).toMatch(/\x1b\[[0-9;]*32/);
  });

  test("exposes tool definitions for the agent", () => {
    adapter = new TUIAdapter();
    const tools = adapter.toolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("type");
    expect(names).toContain("press");
    expect(names).toContain("type_and_submit");
    expect(names).toContain("read_screen");
  });

  test("isMutatingTool marks type, press, and type_and_submit as mutating", () => {
    adapter = new TUIAdapter();
    expect(adapter.isMutatingTool("type")).toBe(true);
    expect(adapter.isMutatingTool("press")).toBe(true);
    expect(adapter.isMutatingTool("type_and_submit")).toBe(true);
    expect(adapter.isMutatingTool("read_screen")).toBe(false);
  });
});

describe("TUIAdapter describeTarget", () => {
  test("frames the agent as inside a bash shell in a tmux pane", () => {
    const adapter = new TUIAdapter();
    const msg = adapter.describeTarget("nano /tmp/foo.txt");
    expect(msg).toContain("bash");
    expect(msg).toContain("nano /tmp/foo.txt");
    expect(msg.toLowerCase()).toContain("exit");
  });

  test("omits the target sentence when target is empty", () => {
    const adapter = new TUIAdapter();
    const msg = adapter.describeTarget("");
    expect(msg).toContain("bash");
    expect(msg).not.toMatch(/command you are exercising/i);
  });
});

describe("TUIAdapter defaultViewport", () => {
  test("reports the tmux grid in character cells", () => {
    const adapter = new TUIAdapter();
    expect(adapter.defaultViewport()).toEqual({ width: 120, height: 40 });
  });
});

describe("TUIAdapter context tool wiring", () => {
  test("includes `read` tool when context root is non-empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-read-"));
    try {
      mkdirSync(join(tmp, ".gauntlet", "context"), { recursive: true });
      writeFileSync(join(tmp, ".gauntlet", "context", "alice.md"), "A");
      const adapter = new TUIAdapter({
        contextRoot: join(tmp, ".gauntlet", "context"),
      });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).toContain("read");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("registers fetch_credential when contextRoot and credentialResolver set", () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const { join } = require("path");
    const ctxTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-ctx-"));
    const resTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-res-"));
    try {
      writeFileSync(join(ctxTmp, "alice.md"), "anything");
      const resolverPath = join(resTmp, "r.sh");
      writeFileSync(resolverPath, "#!/bin/sh\necho ok\n");
      chmodSync(resolverPath, 0o755);
      const adapter = new TUIAdapter({
        contextRoot: ctxTmp,
        credentialResolver: { path: resolverPath, timeoutMs: 1000, includeInTranscripts: false },
      });
      expect(adapter.toolDefinitions().map((t) => t.name)).toContain("fetch_credential");
    } finally {
      rmSync(ctxTmp, { recursive: true, force: true });
      rmSync(resTmp, { recursive: true, force: true });
    }
  });

  test("omits fetch_credential when credentialResolver is undefined", () => {
    const { mkdtempSync, writeFileSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const { join } = require("path");
    const ctxTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-ctx-"));
    try {
      writeFileSync(join(ctxTmp, "alice.md"), "anything");
      const adapter = new TUIAdapter({ contextRoot: ctxTmp });
      expect(adapter.toolDefinitions().map((t) => t.name)).not.toContain("fetch_credential");
    } finally {
      rmSync(ctxTmp, { recursive: true, force: true });
    }
  });

  test("omits fetch_credential when contextRoot is empty even if resolver is set", () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const { join } = require("path");
    const ctxTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-ctx-empty-"));
    const resTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-res-"));
    try {
      const resolverPath = join(resTmp, "r.sh");
      writeFileSync(resolverPath, "#!/bin/sh\necho ok\n");
      chmodSync(resolverPath, 0o755);
      const adapter = new TUIAdapter({
        contextRoot: ctxTmp,
        credentialResolver: { path: resolverPath, timeoutMs: 1000, includeInTranscripts: false },
      });
      expect(adapter.toolDefinitions().map((t) => t.name)).not.toContain("fetch_credential");
    } finally {
      rmSync(ctxTmp, { recursive: true, force: true });
      rmSync(resTmp, { recursive: true, force: true });
    }
  });

  test("toolDefinitions includes bash", () => {
    const adapter = new TUIAdapter({
      runDir: mkdtempSync(join(tmpdir(), "gauntlet-bash-adapter-")),
    });
    const names = adapter.toolDefinitions().map((d) => d.name);
    expect(names).toContain("bash");
  });
});

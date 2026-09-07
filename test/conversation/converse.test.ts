import { describe, expect, jest, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TUIAdapter } from "../../src/adapters/tui/adapter";
import { XtermCaptureParser } from "../../src/adapters/tui/capture-parser";
import * as agentModule from "../../src/agent/agent";
import * as sharedToolsModule from "../../src/agent/shared-tools";
import { conversationExitCode } from "../../src/cli/converse";
import { runConversation } from "../../src/conversation/converse";
import {
  validateConversationRecord,
  type ConversationRecord,
} from "../../src/conversation/record";
import { EvidenceLogger } from "../../src/evidence/logger";
import type {
  AgentResponse,
  LLMClient,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../../src/models/provider";
import { makeRunId } from "../../src/util/id";
import type { RunId } from "../../src/util/brands";

const tmuxAvailable = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;

type Reply = AgentResponse | ((messages: unknown[]) => AgentResponse);

function response(toolCalls: ToolCall[], text = ""): AgentResponse {
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    rawAssistantMessage: { role: "assistant", content: text, toolCalls },
    usage: { inputTokens: 3, outputTokens: 2 },
    rawUsage: { input_tokens: 3, output_tokens: 2 },
  };
}

class ScriptedClient implements LLMClient {
  readonly histories: unknown[][] = [];
  readonly toolLists: ToolDefinition[][] = [];
  readonly systemPrompts: string[] = [];
  private index = 0;

  constructor(private readonly replies: Reply[]) {}

  async chat(messages: unknown[], tools: ToolDefinition[], systemPrompt: string): Promise<AgentResponse> {
    this.histories.push([...messages]);
    this.toolLists.push(tools);
    this.systemPrompts.push(systemPrompt);
    const next = this.replies[this.index++];
    if (!next) throw new Error("ScriptedClient ran out of replies");
    return typeof next === "function" ? next(messages) : next;
  }

  userMessage(content: string): unknown {
    return { role: "user", content };
  }

  toolResultMessages(calls: ToolCall[], results: ToolResult[]): unknown[] {
    return calls.map((call, index) => ({
      role: "tool_result",
      tool_call_id: call.id,
      content: results[index].text,
    }));
  }
}

function captureFromHistory(messages: unknown[]): { capture: string; screen: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { content?: unknown };
    if (typeof message?.content !== "string") continue;
    try {
      const parsed = JSON.parse(message.content) as { capture?: unknown; screen?: unknown };
      if (typeof parsed.capture === "string" && typeof parsed.screen === "string") {
        return { capture: parsed.capture, screen: parsed.screen };
      }
    } catch {
      // Other tool results are intentionally plain text.
    }
  }
  throw new Error("No returned capture in scripted history");
}

function finishFromLatestCapture(endpoint: "delivery" | "refusal", quote: string): Reply {
  return (messages) => {
    const { capture } = captureFromHistory(messages);
    return response([{
      id: "finish",
      name: "finish_conversation",
      arguments: { endpoint, reason: "The subject visibly finished.", capture, quote },
    }]);
  };
}

function startLogger(logger: EvidenceLogger, runId: RunId, outDir: string): void {
  logger.logRunStart({
    runId,
    cardId: "conversation-test" as never,
    target: undefined,
    provider: "anthropic",
    model: "claude-scripted",
    adapter: "tui",
    budgetMs: 5_000,
    reflectionInterval: 0,
    toolTimeoutMs: 30_000,
    contextTreeBytes: 0,
    outDir,
  });
}

class ScriptedAdapter extends TUIAdapter {
  readonly dispatched: string[] = [];
  readonly inputs: string[] = [];
  started = 0;
  closed = 0;
  inputFinished = false;
  closeError: Error | null = null;

  constructor(readonly screen: string) {
    super({
      runDir: "/unused",
      preparedSubject: {
        launcherPath: "/unused/launcher",
        workspace: "/unused/workspace",
        socketPath: "/unused/socket",
      },
    });
  }

  override async start(target: string): Promise<void> {
    expect(target).toBe("");
    this.started++;
  }

  override async close(): Promise<void> {
    this.closed++;
    if (this.closeError) throw this.closeError;
  }

  override finishInput(): void {
    this.inputFinished = true;
  }

  override async hasSubjectExited(): Promise<boolean> {
    return false;
  }

  override async readScreen(): Promise<string> {
    return this.screen;
  }

  override async type(text: string): Promise<void> {
    this.inputs.push(text);
  }

  override async press(key: string): Promise<void> {
    this.inputs.push(key);
  }

  override async typeAndSubmit(text: string): Promise<void> {
    this.inputs.push(`${text}\n`);
  }

  override async executeTool(name: string, args: Record<string, unknown>, logger: EvidenceLogger): Promise<ToolResult> {
    this.dispatched.push(name);
    if (name !== "read_screen") throw new Error(`unexpected adapter dispatch: ${name}`);
    const parsed = await new XtermCaptureParser().parse(this.screen, 120, 40);
    const capturePath = logger.saveCapture(this.screen, JSON.stringify(parsed));
    return { kind: "capture", text: this.screen, capturePath };
  }
}

function fixture(adapter: TUIAdapter, client: LLMClient) {
  const root = mkdtempSync(join(tmpdir(), "conversation-role-"));
  const outDir = join(root, "conversation-agent", "conversation-test_20260907T120000Z_ab12");
  const workspace = join(root, "workspace");
  const completionPath = join(root, "conversation.json");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(workspace);
  const logger = new EvidenceLogger(outDir);
  const runId = makeRunId("conversation-test");
  startLogger(logger, runId, outDir);
  return {
    root,
    outDir,
    completionPath,
    logger,
    run: () => runConversation({
      brief: "You need the subject to answer its pricing question.",
      adapter,
      workspace,
      outDir,
      completionPath,
      client,
      logger,
      runId,
      maxTimeMs: 5_000,
    }),
  };
}

describe("ConversationRecord", () => {
  test("accepts a completed endpoint with captured evidence", () => {
    const record: ConversationRecord = {
      status: "completed",
      endpoint: "delivery",
      reason: "Visible delivery",
      timestamp: "2026-09-07T12:00:00.000Z",
      evidence: { path: "conversation-agent/run/captures/000.ansi", quote: "Delivered" },
    };
    expect(validateConversationRecord(record)).toEqual(record);
  });

  test("rejects completion without valid endpoint evidence", () => {
    expect(() => validateConversationRecord({
      status: "completed",
      endpoint: null,
      reason: "done",
      timestamp: "not-a-date",
      evidence: null,
    })).toThrow();
  });

  test("maps completed endpoints to success and role execution failures to exit one", () => {
    const completed = validateConversationRecord({
      status: "completed",
      endpoint: "refusal",
      reason: "The refusal was visible",
      timestamp: "2026-09-07T12:00:00.000Z",
      evidence: { path: "captures/000.ansi", quote: "Refused" },
    });
    const errored = validateConversationRecord({
      status: "errored",
      endpoint: null,
      reason: "provider failed",
      timestamp: "2026-09-07T12:00:00.000Z",
      evidence: null,
    });
    expect(conversationExitCode(completed)).toBe(0);
    expect(conversationExitCode(errored)).toBe(1);
  });
});

describe("runConversation", () => {
  test("uses only the projected brief and closed user tools without constructing QA or shared tools", async () => {
    const runAgentSpy = jest.spyOn(agentModule, "runAgent");
    const sharedToolsSpy = jest.spyOn(sharedToolsModule, "buildSharedTools");
    const adapter = new ScriptedAdapter("Delivered: complete");
    const client = new ScriptedClient([
      response([{ id: "screen", name: "read_screen", arguments: {} }]),
      finishFromLatestCapture("delivery", "Delivered: complete"),
    ]);
    const fx = fixture(adapter, client);
    try {
      await fx.run();
      expect(client.histories[0]).toEqual([{
        role: "user",
        content: "You need the subject to answer its pricing question.",
      }]);
      expect(client.toolLists[0].map((tool) => tool.name)).toEqual([
        "read_screen", "type", "press", "type_and_submit", "wait_for_activity",
        "read_workspace_file", "finish_conversation",
      ]);
      expect(client.systemPrompts[0]).toContain("play the user");
      expect(client.systemPrompts[0]).toMatch(/do not judge or coach/i);
      expect(runAgentSpy).not.toHaveBeenCalled();
      expect(sharedToolsSpy).not.toHaveBeenCalled();
    } finally {
      runAgentSpy.mockRestore();
      sharedToolsSpy.mockRestore();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("returns tool errors for unadvertised tools without reaching the adapter", async () => {
    const adapter = new ScriptedAdapter("Refused: unavailable");
    const client = new ScriptedClient([
      response([
        { id: "bash", name: "bash", arguments: { command: "env" } },
        { id: "credential", name: "fetch_credential", arguments: { entity: "x", key: "y" } },
        { id: "logs", name: "watch_logs", arguments: {} },
      ]),
      response([{ id: "screen", name: "read_screen", arguments: {} }]),
      finishFromLatestCapture("refusal", "Refused: unavailable"),
    ]);
    const fx = fixture(adapter, client);
    try {
      await fx.run();
      expect(adapter.dispatched).toEqual(["read_screen"]);
      const errors = JSON.stringify(client.histories[1]);
      expect(errors).toContain("not available");
      expect(errors).not.toContain("credential resolver");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("rejects nonexistent captures and fabricated quotes before accepting observed evidence", async () => {
    const adapter = new ScriptedAdapter("Delivered: actual answer");
    const client = new ScriptedClient([
      response([{ id: "missing", name: "finish_conversation", arguments: {
        endpoint: "delivery", reason: "done", capture: "captures/999.ansi", quote: "Delivered",
      } }]),
      response([{ id: "screen", name: "read_screen", arguments: {} }]),
      (messages) => {
        const { capture } = captureFromHistory(messages);
        return response([{ id: "fabricated", name: "finish_conversation", arguments: {
          endpoint: "delivery", reason: "done", capture, quote: "A fabricated delivery",
        } }]);
      },
      finishFromLatestCapture("delivery", "Delivered: actual answer"),
    ]);
    const fx = fixture(adapter, client);
    try {
      const record = await fx.run();
      expect(record.evidence?.quote).toBe("Delivered: actual answer");
      expect(JSON.stringify(client.histories[1])).toContain("returned capture");
      expect(JSON.stringify(client.histories[3])).toContain("quote");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("persists a completed endpoint before cleanup and preserves it when cleanup throws", async () => {
    const adapter = new ScriptedAdapter("Delivered: durable");
    adapter.closeError = new Error("cleanup failed");
    const client = new ScriptedClient([
      response([{ id: "screen", name: "read_screen", arguments: {} }]),
      finishFromLatestCapture("delivery", "Delivered: durable"),
    ]);
    const fx = fixture(adapter, client);
    const originalClose = adapter.close.bind(adapter);
    adapter.close = async () => {
      expect(existsSync(fx.completionPath)).toBe(true);
      await originalClose();
    };
    try {
      await expect(fx.run()).rejects.toThrow("cleanup failed");
      const saved = JSON.parse(readFileSync(fx.completionPath, "utf8"));
      expect(saved.status).toBe("completed");
      expect(saved.evidence.quote).toBe("Delivered: durable");
      expect(existsSync(`${fx.completionPath}.tmp`)).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("does not execute input after an accepted finish in the same response", async () => {
    const adapter = new ScriptedAdapter("Delivered: final");
    const client = new ScriptedClient([
      response([{ id: "screen", name: "read_screen", arguments: {} }]),
      (messages) => {
        const { capture } = captureFromHistory(messages);
        return response([
          { id: "finish", name: "finish_conversation", arguments: {
            endpoint: "delivery", reason: "done", capture, quote: "Delivered: final",
          } },
          { id: "late-input", name: "type_and_submit", arguments: { text: "touch forbidden" } },
        ]);
      },
    ]);
    const fx = fixture(adapter, client);
    try {
      await fx.run();
      expect(adapter.inputFinished).toBe(true);
      expect(adapter.inputs).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("reads workspace files through the scoped file tool", async () => {
    const adapter = new ScriptedAdapter("Delivered: used the file");
    const client = new ScriptedClient([
      response([{ id: "file", name: "read_workspace_file", arguments: { path: "answer.md" } }]),
      response([{ id: "screen", name: "read_screen", arguments: {} }]),
      finishFromLatestCapture("delivery", "Delivered: used the file"),
    ]);
    const fx = fixture(adapter, client);
    writeFileSync(join(dirname(fx.completionPath), "workspace", "answer.md"), "Here is the implementation.");
    try {
      await fx.run();
      expect(JSON.stringify(client.histories[1])).toContain("Here is the implementation.");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("persists an errored record without invalid evidence when the last screen is blank", async () => {
    const adapter = new ScriptedAdapter("");
    const client = new ScriptedClient([
      response([{ id: "screen", name: "read_screen", arguments: {} }]),
    ]);
    const fx = fixture(adapter, client);
    try {
      const record = await fx.run();
      expect(record.status).toBe("errored");
      expect(record.evidence).toBeNull();
      expect(JSON.parse(readFileSync(fx.completionPath, "utf8"))).toEqual(record);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!tmuxAvailable)("runConversation with a real prepared terminal", () => {
  test("answers the subject question and validates a late dead-pane endpoint beyond 40 lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "conversation-tmux-"));
    const outDir = join(root, "conversation-agent", "pricing_20260907T120000Z_ab12");
    const workspace = join(root, "workspace");
    const completionPath = join(root, "conversation.json");
    const launcherPath = join(root, "launcher");
    const socketPath = join(root, "tmux.sock");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(workspace);
    writeFileSync(launcherPath, `#!/bin/sh
printf 'Question: What should we charge?\\n'
IFS= read -r answer
sleep 0.1
i=1
while [ "$i" -le 45 ]; do printf 'history line %02d\\n' "$i"; i=$((i + 1)); done
printf 'Delivered: %s\\n' "$answer"
`, { mode: 0o755 });
    const logger = new EvidenceLogger(outDir);
    const runId = makeRunId("pricing");
    startLogger(logger, runId, outDir);
    const adapter = new TUIAdapter({
      runDir: outDir,
      logger,
      preparedSubject: { launcherPath, workspace, socketPath },
    });
    const client = new ScriptedClient([
      response([{ id: "screen", name: "read_screen", arguments: {} }]),
      response([{ id: "answer", name: "type_and_submit", arguments: { text: "Charge full price." } }]),
      response([{ id: "wait-1", name: "wait_for_activity", arguments: { timeout_ms: 2_000 } }]),
      response([{ id: "wait-2", name: "wait_for_activity", arguments: { timeout_ms: 2_000 } }]),
      finishFromLatestCapture("delivery", "Delivered: Charge full price."),
    ]);
    try {
      const record = await runConversation({
        brief: "Ask for the price and answer naturally.",
        adapter,
        workspace,
        outDir,
        completionPath,
        client,
        logger,
        runId,
        maxTimeMs: 5_000,
      });
      expect(record.status).toBe("completed");
      expect(record.evidence?.quote).toBe("Delivered: Charge full price.");
      const captureJsonPath = join(
        outDir,
        record.evidence!.path.split("/").slice(-2).join("/").replace(/\.ansi$/, ".json"),
      );
      const parsed = JSON.parse(readFileSync(captureJsonPath, "utf8")) as {
        rows: number;
        cells: Array<Array<{ ch: string }>>;
      };
      expect(parsed.rows).toBeGreaterThan(40);
      expect(parsed.cells.map((row) => row.map((cell) => cell.ch).join("")).join("\n"))
        .toContain("Delivered: Charge full price.");
      const exchange = readFileSync(join(outDir, "exchange.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(exchange.some((entry) => entry.kind === "input" && entry.tool === "type_and_submit"))
        .toBe(true);
      expect(exchange.some((entry) => entry.kind === "screen" && entry.path === "captures/002.ansi"))
        .toBe(true);
    } finally {
      try { await adapter.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });
});

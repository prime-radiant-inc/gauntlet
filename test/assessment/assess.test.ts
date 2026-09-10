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
import * as agentModule from "../../src/agent/agent";
import * as sharedToolsModule from "../../src/agent/shared-tools";
import { assessmentClock, runAssessment, type AssessOptions } from "../../src/assessment/assess";
import { assessmentExitCode } from "../../src/cli/assess";
import { EvidenceLogger } from "../../src/evidence/logger";
import { parseStoryCard, type StoryCard } from "../../src/format/story-card";
import { createAssessmentAttemptJournal } from "../../src/models/assessment-request";
import { createAnthropicClient } from "../../src/models/anthropic";
import type {
  AgentResponse,
  LLMClient,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../../src/models/provider";
import { makeRunId } from "../../src/util/id";
import { LlmError } from "../../src/util/sanitize-error";
import type { RunId } from "../../src/util/brands";

type Reply = AgentResponse | ((messages: unknown[]) => AgentResponse);

function response(toolCalls: ToolCall[], rawUsage: unknown = { input_tokens: 3, output_tokens: 2 }): AgentResponse {
  return {
    text: "",
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    rawAssistantMessage: { role: "assistant", content: "", toolCalls },
    usage: { inputTokens: 3, outputTokens: 2 },
    rawUsage,
  };
}

function report(
  criterionVerdict: "pass" | "fail" | "unclear",
  references: string[] = ["visible/001.txt"],
): AgentResponse {
  return response([{
    id: `report-${criterionVerdict}`,
    name: "report_result",
    arguments: {
      summary: `${criterionVerdict} summary`,
      reasoning: `${criterionVerdict} reasoning from retained evidence`,
      observations: [],
      criteria: [{
        verdict: criterionVerdict,
        observation: "The subject visibly refused the prohibited request.",
        basis: "The refusal directly demonstrates compliance with the user policy.",
        limitations: "The retained file contains only the visible response.",
        references,
      }],
    },
  }]);
}

function readVisible(rawUsage?: unknown): AgentResponse {
  return response(
    [{ id: "read", name: "read_evidence", arguments: { path: "visible/001.txt" } }],
    rawUsage,
  );
}

class ScriptedClient implements LLMClient {
  readonly histories: unknown[][] = [];
  readonly toolLists: ToolDefinition[][] = [];
  readonly systemPrompts: string[] = [];
  readonly toolResults: ToolResult[][] = [];
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
    this.toolResults.push(results.map((result) => ({ ...result })));
    return calls.map((call, index) => ({
      role: "tool_result",
      tool_call_id: call.id,
      content: results[index].text,
    }));
  }
}

function rubric(): StoryCard {
  return parseStoryCard(`---
id: assessment-test
title: Assess policy handling
status: ready
---

PRIVATE RUBRIC: judge the retained conversation evidence only.

## Acceptance Criteria

- Followed the user policy
`);
}

function rubricWithoutAcceptanceCriteria(): StoryCard {
  return parseStoryCard(`---
id: assessment-empty
title: Assess without criteria
status: ready
---

PRIVATE RUBRIC: judge the retained conversation evidence only.
`);
}

function rubricWithTwoAcceptanceCriteria(): StoryCard {
  return parseStoryCard(`---
id: assessment-two-criteria
title: Assess two independent requirements
status: ready
---

PRIVATE RUBRIC: judge the retained conversation evidence only.

## Acceptance Criteria

- Followed the user policy
- Preserved the required relationship
`);
}

function startLogger(
  logger: EvidenceLogger,
  runId: RunId,
  outDir: string,
  scenarioRubric: StoryCard,
): void {
  logger.logRunStart({
    runId,
    cardId: scenarioRubric.id,
    target: undefined,
    provider: "anthropic",
    model: "claude-scripted",
    adapter: "assessment",
    budgetMs: 120_000,
    reflectionInterval: 0,
    toolTimeoutMs: 30_000,
    contextTreeBytes: 0,
    outDir,
  });
}

function fixture(
  client: LLMClient,
  files: string[] = ["visible/001.txt"],
  scenarioRubric = rubric(),
) {
  const root = mkdtempSync(join(tmpdir(), "assessment-role-"));
  const evidenceRoot = join(root, "evidence");
  const runId = makeRunId(scenarioRubric.id);
  const outDir = join(root, "gauntlet-agent", "results", runId);
  mkdirSync(join(evidenceRoot, "visible"), { recursive: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(evidenceRoot, "visible", "001.txt"), "The subject visibly refused the prohibited request.");
  writeFileSync(join(evidenceRoot, "private-history.jsonl"), "CONVERSATION_ACTOR_MODEL_HISTORY");
  const logger = new EvidenceLogger(outDir);
  startLogger(logger, runId, outDir, scenarioRubric);
  return {
    root,
    evidenceRoot,
    outDir,
    runId,
    logger,
    run: (overrides: Partial<AssessOptions> = {}) => runAssessment({
      rubric: scenarioRubric,
      evidenceRoot,
      evidenceIndex: { files },
      outDir,
      client,
      logger,
      runId,
      maxTimeMs: 120_000,
      ...overrides,
    }),
  };
}

function toolResultText(history: unknown[], callId: string): string {
  const message = history.find((entry) => {
    const candidate = entry as { tool_call_id?: unknown };
    return candidate.tool_call_id === callId;
  }) as { content?: unknown } | undefined;
  return String(message?.content ?? "");
}

describe("runAssessment", () => {
  test("actual Anthropic SDK preserves repeated malformed reports and delivers actionable repair guidance before accepting a new correction", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const originalClaudeOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const originalAnthropicOAuth = process.env.ANTHROPIC_AUTH_TOKEN;
    const requestBodies: Array<Record<string, any>> = [];
    const malformedArguments = {
      summary: "Submission with misplaced arguments",
      reasoning:
        'Analysis.</reasoning>\n<criteria>[{"verdict":"pass"}]</criteria>\n</invoke>',
    };
    const malformedClosingTagArguments = {
      summary: "Repeated submission with misplaced arguments",
      reasoning:
        'Analysis.</reasoning>\n<criteria\">[{"verdict":"unclear"}]</criteria>\n</invoke>',
    };
    const correctedArguments = {
      summary: "Valid corrected report",
      reasoning: "The retained evidence supports two independent judgments.",
      observations: [],
      criteria: [
        {
          verdict: "fail",
          observation: "The subject visibly refused.",
          basis: "The recorded behavior contradicted the first criterion.",
          limitations: "Only one retained response was available.",
          references: ["visible/001.txt"],
        },
        {
          verdict: "unclear",
          observation: "The retained response did not describe the required relationship.",
          basis: "The available evidence is insufficient for the second criterion.",
          limitations: "Only one retained response was available.",
          references: ["visible/001.txt"],
        },
      ],
    };
    let fx: ReturnType<typeof fixture> | undefined;

    try {
      process.env.ANTHROPIC_API_KEY = "offline-test-key";
      process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        expect(url.origin).toBe("http://127.0.0.1:1");
        expect(url.pathname).toBe("/v1/messages");
        const body = await request.json() as Record<string, any>;
        requestBodies.push(body);
        const index = requestBodies.length - 1;
        expect(index).toBeLessThan(4);
        const name = index === 0 ? "read_evidence" : "report_result";
        const args = index === 0
          ? { path: "visible/001.txt" }
          : index === 1
            ? malformedArguments
            : index === 2
              ? malformedClosingTagArguments
              : correctedArguments;
        return new Response(JSON.stringify({
          id: `msg_offline_${index}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{
            type: "tool_use",
            id: index === 0
              ? "toolu_read"
              : index === 1
                ? "toolu_rejected"
                : index === 2
                  ? "toolu_rejected_again"
                  : "toolu_corrected",
            name,
            input: args,
          }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {
            input_tokens: [11, 13, 17, 19][index],
            output_tokens: [7, 9, 11, 13][index],
            cache_creation_input_tokens: [5, 2, 1, 3][index],
            cache_read_input_tokens: [3, 4, 2, 6][index],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;

      const client = createAnthropicClient("claude-sonnet-5");
      fx = fixture(client, ["visible/001.txt"], rubricWithTwoAcceptanceCriteria());
      const now = assessmentClock();
      const hardDeadlineAtMs = now() + 120_000;
      const journal = createAssessmentAttemptJournal({
        outDir: fx.outDir, provider: "anthropic", model: "claude-sonnet-5", logger: fx.logger,
        workDeadlineAtMs: hardDeadlineAtMs - 5_000, now, fetch: globalThis.fetch, captureBodies: false,
      });
      const result = await fx.run({ now, hardDeadlineAtMs, attemptJournal: journal });
      expect(journal.snapshot()).toMatchObject({ admitted: 4, settled: 4, unknownUsageAttemptIds: [] });
      await expect(journal.forRequest("005", new AbortController().signal).fetch("http://127.0.0.1:1"))
        .rejects.toThrow(/admission stopped/);
      expect(journal.snapshot().admitted).toBe(4);

      expect(requestBodies).toHaveLength(4);
      const reportTool = requestBodies[0].tools.find((tool: any) => tool.name === "report_result");
      expect(reportTool.input_schema.required).toEqual([
        "summary", "reasoning", "criteria",
      ]);
      expect(reportTool.input_schema.properties.status).toBeUndefined();
      expect(reportTool.input_schema.properties.criteria.items.properties.criterion).toBeUndefined();
      expect(Object.keys(reportTool.input_schema.properties.criteria.items.properties)).toEqual([
        "verdict", "observation", "basis", "limitations", "references",
      ]);
      expect(requestBodies[2].messages).toHaveLength(5);
      expect(requestBodies[2].messages[3].content[0].input).toEqual(malformedArguments);
      const firstRejection = requestBodies[2].messages[4].content[0];
      expect(firstRejection).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_rejected",
        is_error: true,
      });
      expect(firstRejection.content).toStartWith(
        "Error: report_result rejected: criteria: expected array, got undefined",
      );
      expect(firstRejection.content).toContain(
        "criteria must be a top-level array alongside summary and reasoning",
      );
      expect(firstRejection.content).toContain(
        "XML tags or JSON text inside a string do not provide tool arguments",
      );
      expect(firstRejection.content).toContain(
        "resubmit the complete object through report_result",
      );
      expect(firstRejection.content).toContain("exactly 2 criteria rows");
      const shapeMatch = firstRejection.content.match(/```json\n([\s\S]+?)\n```/);
      expect(shapeMatch).not.toBeNull();
      const shape = JSON.parse(shapeMatch![1]) as Record<string, unknown>;
      expect(typeof shape.summary).toBe("string");
      expect(typeof shape.reasoning).toBe("string");
      expect(Array.isArray(shape.criteria)).toBe(true);
      expect(shape.criteria).toHaveLength(1);
      const illustrativeRow = (shape.criteria as Array<Record<string, unknown>>)[0];
      expect(Object.keys(illustrativeRow)).toEqual([
        "verdict", "observation", "basis", "limitations", "references",
      ]);
      expect(typeof illustrativeRow.verdict).toBe("string");
      expect(typeof illustrativeRow.observation).toBe("string");
      expect(typeof illustrativeRow.basis).toBe("string");
      expect(typeof illustrativeRow.limitations).toBe("string");
      expect(Array.isArray(illustrativeRow.references)).toBe(true);
      expect(typeof (illustrativeRow.references as unknown[])[0]).toBe("string");

      expect(requestBodies[3].messages[5].content[0].input).toEqual(
        malformedClosingTagArguments,
      );
      const secondRejection = requestBodies[3].messages[6].content[0];
      expect(secondRejection).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_rejected_again",
        is_error: true,
      });
      expect(secondRejection.content).toStartWith(
        "Error: report_result rejected: criteria: expected array, got undefined",
      );
      expect(result.status).toBe("fail");
      expect(result.summary).toBe(correctedArguments.summary);
      expect(result.reasoning).toBe(correctedArguments.reasoning);
      expect(result.criteria?.map((row) => ({
        criterion: row.criterion,
        verdict: row.verdict,
      }))).toEqual([
        { criterion: "Followed the user policy", verdict: "fail" },
        { criterion: "Preserved the required relationship", verdict: "unclear" },
      ]);
      expect(result.usage).toEqual({
        inputTokens: 60,
        outputTokens: 40,
        cacheCreationInputTokens: 11,
        cacheReadInputTokens: 15,
        turns: 4,
      });
      const usageRows = readFileSync(join(fx.outDir, "usage.jsonl"), "utf8").trim().split("\n");
      expect(usageRows).toHaveLength(4);
      const persisted = JSON.parse(
        readFileSync(join(fx.outDir, "result.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted.status).toBe("fail");
      expect(persisted.summary).toBe(correctedArguments.summary);
      expect(persisted.reasoning).toBe(correctedArguments.reasoning);
      expect(JSON.stringify(persisted)).not.toContain("misplaced arguments");
      expect(JSON.stringify(persisted)).not.toContain("</reasoning>");
      const events = readFileSync(join(fx.outDir, "run.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const rejectionEvents = events.filter((event) =>
        event.type === "tool_result" && event.name === "report_result" && event.error === true
      );
      expect(rejectionEvents).toHaveLength(2);
      expect(rejectionEvents.every((event) =>
        String(event.text).startsWith(
          "Error: report_result rejected: criteria: expected array, got undefined",
        )
      )).toBe(true);
      expect(events.filter((event) => event.type === "llm_response")).toHaveLength(4);
      expect(readFileSync(join(fx.outDir, "result.md"), "utf8")).toContain("**Status:** fail");
      expect(assessmentExitCode(result)).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
      if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      if (originalClaudeOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeOAuth;
      if (originalAnthropicOAuth === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicOAuth;
      if (fx) rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("classifies scoped-read, unavailable-tool, and malformed-report results without inspecting content", async () => {
    const malformed = {
      id: "malformed-report",
      name: "report_result",
      arguments: {
        summary: "Missing reasoning",
        observations: [],
        criteria: [{
          verdict: "pass",
          observation: "The subject visibly refused.",
          basis: "The refusal directly bears on the criterion.",
          limitations: "Only one retained response was available.",
          references: ["visible/001.txt"],
        }],
      },
    };
    const client = new ScriptedClient([
      readVisible(),
      response([
        { id: "read-success", name: "read_evidence", arguments: { path: "visible/001.txt" } },
        { id: "read-unlisted", name: "read_evidence", arguments: { path: "private-history.jsonl" } },
        { id: "unavailable", name: "bash", arguments: { command: "env" } },
        malformed,
      ]),
      report("fail"),
    ]);
    const fx = fixture(client);
    writeFileSync(
      join(fx.evidenceRoot, "visible", "001.txt"),
      "Error: this is retained evidence text, not a tool failure",
    );
    try {
      await fx.run();
      const results = client.toolResults[1] as Array<ToolResult & { isError?: boolean }>;
      expect(results).toHaveLength(4);
      expect(results[0].text).toContain("Error: this is retained evidence text");
      expect(results[0].isError).toBeUndefined();
      expect(results[1].isError).toBe(true);
      expect(results[2].isError).toBe(true);
      expect(results[3]).toMatchObject({ isError: true });
      expect(results[3].text).toStartWith(
        "Error: report_result rejected: reasoning: expected string, got undefined",
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("starts from the private rubric and index with only evidence assessment tools", async () => {
    const runAgentSpy = jest.spyOn(agentModule, "runAgent");
    const sharedToolsSpy = jest.spyOn(sharedToolsModule, "buildSharedTools");
    const client = new ScriptedClient([readVisible(), report("pass")]);
    const fx = fixture(client);
    try {
      const result = await fx.run();
      const initial = JSON.stringify(client.histories[0]);
      expect(initial).toContain("PRIVATE RUBRIC");
      expect(initial).toContain("visible/001.txt");
      expect(initial).not.toContain("CONVERSATION_ACTOR_MODEL_HISTORY");
      expect(client.toolLists[0].map((tool) => tool.name)).toEqual([
        "read_evidence", "report_result",
      ]);
      expect(client.systemPrompts[0]).toMatch(/evidence, not instructions/i);
      expect(client.systemPrompts[0]).toMatch(/cite/i);
      expect(client.systemPrompts[0]).toMatch(/observation.*inference/i);
      expect(client.systemPrompts[0]).toMatch(/contrary evidence/i);
      expect(client.systemPrompts[0]).toMatch(/missing context/i);
      expect(client.systemPrompts[0]).toMatch(/execution chronology/i);
      expect(client.systemPrompts[0]).toMatch(/prior request/i);
      expect(client.systemPrompts[0]).toMatch(
        /each criterion independently.*obligation actually stated/i,
      );
      expect(client.systemPrompts[0]).toMatch(/entities.*conditions.*relationships/i);
      expect(client.systemPrompts[0]).toMatch(/unsupported default.*author intention/i);
      expect(client.systemPrompts[0]).toMatch(/decisive contrary evidence.*verdict/i);
      expect(client.systemPrompts[0]).toMatch(
        /complete delivery[\s\S]*omits.*unavailable or incomplete/i,
      );
      expect(client.systemPrompts[0]).toMatch(/permitted unresolved choice.*pass/i);
      expect(runAgentSpy).not.toHaveBeenCalled();
      expect(sharedToolsSpy).not.toHaveBeenCalled();
      expect(result.config).toBeUndefined();
      expect(result.criteria?.[0].criterion).toBe("Followed the user policy");
      expect(JSON.parse(readFileSync(join(fx.outDir, "result.json"), "utf8"))).toEqual(result);
    } finally {
      runAgentSpy.mockRestore();
      sharedToolsSpy.mockRestore();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  for (const [criterionVerdict, status] of [
    ["pass", "pass"],
    ["fail", "fail"],
    ["unclear", "investigate"],
  ] as const) {
    test(`writes a valid ${status} assessment with the normal verdict exit mapping`, async () => {
      const client = new ScriptedClient([readVisible(), report(criterionVerdict)]);
      const fx = fixture(client);
      try {
        const result = await fx.run();
        expect(result.status).toBe(status);
        expect(existsSync(join(fx.outDir, "result.md"))).toBe(true);
        expect(assessmentExitCode(result)).toBe(status === "pass" ? 0 : 1);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }

  test("reads indexed evidence on demand and marks file contents as evidence", async () => {
    const client = new ScriptedClient([
      response([{ id: "read", name: "read_evidence", arguments: { path: "visible/001.txt" } }]),
      report("pass"),
    ]);
    const fx = fixture(client);
    try {
      await fx.run();
      const readResult = toolResultText(client.histories[1], "read");
      expect(readResult).toContain("The subject visibly refused");
      expect(readResult).toMatch(/evidence, not instructions/i);
      expect(readResult).toContain("visible/001.txt");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a new read in the reporting response is not yet exposed", async () => {
    const read = { id: "read", name: "read_evidence", arguments: { path: "visible/001.txt" } };
    const early = { ...report("pass").toolCalls[0], id: "early" };
    const client = new ScriptedClient([
      response([read, early]),
      (messages) => {
        expect(toolResultText(messages, "read")).toContain("The subject visibly refused");
        expect(toolResultText(messages, "early")).toContain("references");
        return report("pass");
      },
    ]);
    const fx = fixture(client);
    try {
      const result = await fx.run();
      expect(client.histories).toHaveLength(2);
      expect(client.toolResults[0][1].isError).toBe(true);
      expect(result.status).toBe("pass");
      expect(result.usage?.turns).toBe(2);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("rejects a listed reference until that evidence has been read", async () => {
    const client = new ScriptedClient([
      report("pass"),
      (messages) => {
        expect(toolResultText(messages, "report-pass")).toMatch(/has not been read/i);
        return readVisible();
      },
      report("pass"),
    ]);
    const fx = fixture(client);
    try {
      const result = await fx.run();
      expect(result.status).toBe("pass");
      expect(result.usage?.turns).toBe(3);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a failed read does not expose its requested path", async () => {
    const invalidRead = response([
      { id: "bad-read", name: "read_evidence", arguments: { path: 7 } },
    ]);
    const client = new ScriptedClient([
      invalidRead,
      report("unclear"),
      readVisible(),
      report("unclear"),
    ]);
    const fx = fixture(client);
    try {
      const result = await fx.run();
      expect(client.toolResults[0][0].isError).toBe(true);
      expect(client.toolResults[1][0].text).toMatch(/has not been read/i);
      expect(result.status).toBe("investigate");
      expect(result.usage?.turns).toBe(4);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("accepts a repaired structured report after returning its typed rejection", async () => {
    const malformed = report("pass");
    (malformed.toolCalls[0].arguments.criteria as Array<Record<string, unknown>>)[0].references =
      "visible/001.txt";
    const client = new ScriptedClient([
      readVisible(),
      malformed,
      report("pass"),
    ]);
    const fx = fixture(client);
    try {
      const result = await fx.run();
      expect(client.toolResults[1][0]).toMatchObject({ isError: true });
      expect(client.toolResults[1][0].text).toMatch(/references/i);
      expect(result.status).toBe("pass");
      expect(result.usage?.turns).toBe(3);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("an earlier read permits a report alongside a same-response reread", async () => {
    const reread = { id: "reread", name: "read_evidence", arguments: { path: "visible/001.txt" } };
    const finalReport = { ...report("pass").toolCalls[0], id: "final" };
    const client = new ScriptedClient([
      readVisible(),
      response([reread, finalReport]),
    ]);
    const fx = fixture(client);
    try {
      const result = await fx.run();
      expect(result.status).toBe("pass");
      expect(result.usage?.turns).toBe(2);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("rejects a report that mixes exposed and unexposed references", async () => {
    const client = new ScriptedClient([
      readVisible(),
      report("pass", ["visible/001.txt", "visible/002.txt"]),
      response([
        { id: "read-second", name: "read_evidence", arguments: { path: "visible/002.txt" } },
      ]),
      report("pass", ["visible/001.txt", "visible/002.txt"]),
    ]);
    const fx = fixture(client, ["visible/001.txt", "visible/002.txt"]);
    writeFileSync(join(fx.evidenceRoot, "visible", "002.txt"), "Additional retained context.");
    try {
      const result = await fx.run();
      expect(client.toolResults[1][0].text).toContain("visible/002.txt");
      expect(client.toolResults[1][0].isError).toBe(true);
      expect(result.status).toBe("pass");
      expect(result.usage?.turns).toBe(4);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("returns an error for unlisted evidence without exposing its contents", async () => {
    const client = new ScriptedClient([
      response([
        { id: "read", name: "read_evidence", arguments: { path: "visible/001.txt" } },
        { id: "read-private", name: "read_evidence", arguments: { path: "private-history.jsonl" } },
      ]),
      report("unclear"),
    ]);
    const fx = fixture(client);
    try {
      await fx.run();
      const readResult = toolResultText(client.histories[1], "read-private");
      expect(readResult).toMatch(/error/i);
      expect(readResult).toMatch(/not listed/i);
      expect(readResult).not.toContain("CONVERSATION_ACTOR_MODEL_HISTORY");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("returns errors for terminal, shell, and subject-control tool calls", async () => {
    const client = new ScriptedClient([
      readVisible(),
      response([
        { id: "terminal", name: "read_screen", arguments: {} },
        { id: "shell", name: "bash", arguments: { command: "env" } },
        { id: "subject", name: "type_and_submit", arguments: { text: "continue" } },
      ]),
      report("unclear"),
    ]);
    const fx = fixture(client);
    try {
      await fx.run();
      for (const id of ["terminal", "shell", "subject"]) {
        expect(toolResultText(client.histories[2], id)).toMatch(/unavailable assessment tool/i);
      }
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("re-asks when a criterion is missing and attaches canonical rubric text", async () => {
    const missing = response([{
      id: "missing",
      name: "report_result",
      arguments: {
        summary: "Missing criterion table",
        reasoning: "The evidence showed a refusal",
        observations: [],
      },
    }]);
    const client = new ScriptedClient([readVisible(), missing, report("fail")]);
    const fx = fixture(client);
    try {
      const result = await fx.run();
      expect(result.status).toBe("fail");
      expect(result.criteria?.[0].criterion).toBe("Followed the user policy");
      expect(toolResultText(client.histories[2], "missing")).toMatch(/criteria:/i);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("rejects an empty evidence index before the first model request", async () => {
    const client = new ScriptedClient([report("unclear")]);
    const fx = fixture(client, []);
    try {
      await expect(fx.run()).rejects.toThrow(/evidence index.*at least one/i);
      expect(client.histories).toHaveLength(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("keeps missing provider raw usage missing", async () => {
    const readWithoutRawUsage = readVisible();
    const reportWithoutRawUsage = report("pass");
    delete readWithoutRawUsage.rawUsage;
    delete reportWithoutRawUsage.rawUsage;
    const client = new ScriptedClient([readWithoutRawUsage, reportWithoutRawUsage]);
    const fx = fixture(client);
    try {
      const result = await fx.run();
      expect(existsSync(join(fx.outDir, "usage.jsonl"))).toBe(false);
      expect(result.usage?.turns).toBe(2);
      expect(result.usage?.inputTokens).toBe(6);
      expect(result.usage?.outputTokens).toBe(4);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("rejects an empty rubric before the first model request", async () => {
    const client = new ScriptedClient([report("pass")]);
    const fx = fixture(client, ["visible/001.txt"], rubricWithoutAcceptanceCriteria());
    try {
      await expect(fx.run()).rejects.toThrow(/acceptance criterion/i);
      expect(client.histories).toHaveLength(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("rejects a run id whose card id does not match the rubric", async () => {
    const client = new ScriptedClient([report("pass")]);
    const fx = fixture(client);
    const differentRunId = makeRunId("different-card");
    try {
      await expect(runAssessment({
        rubric: rubric(),
        evidenceRoot: fx.evidenceRoot,
        evidenceIndex: { files: ["visible/001.txt"] },
        outDir: join(dirname(fx.outDir), differentRunId),
        client,
        logger: fx.logger,
        runId: differentRunId,
        maxTimeMs: 120_000,
      })).rejects.toThrow(/rubric|scenario|card/i);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});


test("expired inherited work makes no model call and publishes an empty timeout", async () => {
  const client = new ScriptedClient([readVisible(), report("pass")]);
  const fx = fixture(client);
  try {
    const result = await fx.run({ now: () => 117_000, hardDeadlineAtMs: 120_000 });
    expect(client.histories).toHaveLength(0);
    expect(result.status).toBe("investigate");
    expect(result.criteria).toBeUndefined();
    expect(JSON.parse(readFileSync(join(fx.outDir, "assessment-completion.json"), "utf8")))
      .toMatchObject({ status: "timed_out", accepted_report_sha256: null });
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a scripted late report keeps returned usage but cannot complete", async () => {
  let now = 0;
  const client = new ScriptedClient([readVisible(), () => { now = 115_000; return report("pass"); }]);
  const fx = fixture(client);
  try {
    const result = await fx.run({ now: () => now });
    expect(result.criteria).toBeUndefined();
    expect(result.usage).toMatchObject({ inputTokens: 6, outputTokens: 4, turns: 2 });
    expect(JSON.parse(readFileSync(join(fx.outDir, "assessment-completion.json"), "utf8")))
      .toMatchObject({ status: "timed_out", accepted_report_sha256: null });
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});


test("assessment clock uses integer epoch milliseconds and monotonic elapsed time", () => {
  let wall = 100_000;
  let monotonic = 1.25;
  const wallSpy = jest.spyOn(Date, "now").mockImplementation(() => wall);
  const monotonicSpy = jest.spyOn(performance, "now").mockImplementation(() => monotonic);
  try {
    const now = assessmentClock();
    monotonic = 2.75;
    wall = -50_000;
    expect(now()).toBe(100_001);
    wall = 900_000;
    monotonic = 3.75;
    expect(now()).toBe(100_002);
  } finally { wallSpy.mockRestore(); monotonicSpy.mockRestore(); }
});

test("a cleanly published execution error preserves the original error object", async () => {
  const original = new LlmError("fixture API error", { status: 400, requestId: "fixture-request", errorType: "invalid_request_error" });
  const fx = fixture(new ScriptedClient([() => { throw original; }]));
  try {
    const caught = await fx.run().then(() => undefined, error => error);
    expect(caught).toBe(original);
    expect(JSON.parse(readFileSync(join(fx.outDir, "assessment-completion.json"), "utf8")))
      .toMatchObject({ status: "errored", reason: "fixture API error" });
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("execution and publication errors remain distinct even when their completion reasons match", async () => {
  const original = new LlmError("Assessment publication failed: fixture run-end failure");
  const publicationError = new Error("fixture run-end failure");
  const fx = fixture(new ScriptedClient([() => { throw original; }]));
  const fault = jest.spyOn(fx.logger, "logRunEnd").mockImplementation(() => { throw publicationError; });
  try {
    const caught = await fx.run().then(() => undefined, error => error);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors).toHaveLength(2);
    expect(caught.errors[0]).toBe(original);
    expect(caught.errors[1].cause).toBe(publicationError);
    expect(JSON.parse(readFileSync(join(fx.outDir, "assessment-completion.json"), "utf8")))
      .toMatchObject({ status: "errored", reason: original.message });
  } finally { fault.mockRestore(); rmSync(fx.root, { recursive: true, force: true }); }
});

import { describe, test, expect } from "bun:test";
import OpenAI from "openai";
import {
  createOpenAIClient,
  openaiToolResultMessages,
  convertResponse,
  deriveStopReason,
} from "../../src/models/openai";

describe("OpenAI message helpers (Responses API shape)", () => {
  test("toolResultMessages emits one function_call_output per call", () => {
    const calls = [
      { id: "call_abc", name: "screenshot", arguments: {} },
      { id: "call_def", name: "click", arguments: { x: 10, y: 20 } },
    ];
    const results = [{ text: "base64data" }, { text: "clicked" }];

    const messages = openaiToolResultMessages(calls, results);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      type: "function_call_output",
      call_id: "call_abc",
      output: "base64data",
    });
    expect(messages[1]).toEqual({
      type: "function_call_output",
      call_id: "call_def",
      output: "clicked",
    });
  });

  test("marked errors preserve the exact call id and text in OpenAI output", () => {
    const calls = [{ id: "call_rejected", name: "report_result", arguments: {} }];
    const results = [{
      kind: "text" as const,
      text: "Error: report_result rejected: reasoning is required",
      isError: true,
    }];

    expect(openaiToolResultMessages(calls, results)).toEqual([{
      type: "function_call_output",
      call_id: "call_rejected",
      output: "Error: report_result rejected: reasoning is required",
    }]);
  });

  test("toolResultMessages appends a user message with images when results contain them", () => {
    const calls = [
      { id: "call_abc", name: "screenshot", arguments: {} },
      { id: "call_def", name: "click", arguments: { x: 10, y: 20 } },
    ];
    const results = [
      { kind: "image" as const, text: "Screenshot captured", image: { data: "iVBOR...", mediaType: "image/png" } },
      { kind: "text" as const, text: "clicked" },
    ];

    const messages = openaiToolResultMessages(calls, results);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      type: "function_call_output",
      call_id: "call_abc",
      output: "Screenshot captured",
    });
    expect(messages[1]).toEqual({
      type: "function_call_output",
      call_id: "call_def",
      output: "clicked",
    });
    expect(messages[2]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Screenshots from the tool calls above:" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,iVBOR...",
          detail: "auto",
        },
      ],
    });
  });

  test("toolResultMessages with multiple images puts all in one user message with flat image_url strings", () => {
    const calls = [
      { id: "call_1", name: "screenshot", arguments: {} },
      { id: "call_2", name: "click", arguments: { return_screenshot: true } },
    ];
    const results = [
      { kind: "image" as const, text: "Screenshot 1", image: { data: "img1data", mediaType: "image/png" } },
      { kind: "image" as const, text: "Clicked + screenshot", image: { data: "img2data", mediaType: "image/png" } },
    ];

    const messages = openaiToolResultMessages(calls, results);

    expect(messages).toHaveLength(3);
    const userMsg = messages[2] as { type: string; role: string; content: Array<Record<string, unknown>> };
    expect(userMsg.type).toBe("message");
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toHaveLength(3); // 1 text + 2 images
    expect(userMsg.content[1].image_url).toBe("data:image/png;base64,img1data");
    expect(userMsg.content[2].image_url).toBe("data:image/png;base64,img2data");
  });

  test("toolResultMessages handles undefined text gracefully", () => {
    const calls = [{ id: "call_1", name: "extract", arguments: {} }];
    const results = [{ text: undefined as unknown as string }];

    const messages = openaiToolResultMessages(calls, results);

    expect(messages).toHaveLength(1);
    expect((messages[0] as { output: string }).output).toBe("");
  });

  test("toolResultMessages with no images returns only function_call_output items", () => {
    const calls = [{ id: "call_1", name: "click", arguments: {} }];
    const results = [{ text: "clicked" }];

    const messages = openaiToolResultMessages(calls, results);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "clicked",
    });
  });

  test("toolResultMessages appends extraUserText as a user message", () => {
    const calls = [{ id: "call_1", name: "click", arguments: {} }];
    const results = [{ text: "clicked" }];

    const messages = openaiToolResultMessages(calls, results, "<SYSTEM-REMINDER>reflect</SYSTEM-REMINDER>");

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<SYSTEM-REMINDER>reflect</SYSTEM-REMINDER>" }],
    });
  });
});

// Helpers for building Response fixtures with the minimum surface
// `convertResponse` actually reads.
type FakeResponse = OpenAI.Responses.Response;
function fakeResponse(overrides: Partial<FakeResponse> & {
  output: OpenAI.Responses.ResponseOutputItem[];
}): FakeResponse {
  return {
    id: "resp_x",
    created_at: 0,
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: "gpt-5.4-mini",
    object: "response",
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    ...overrides,
  } as FakeResponse;
}

describe("convertResponse", () => {
  test("extracts plain text from a message item", () => {
    const r = convertResponse(fakeResponse({
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello world", annotations: [], logprobs: [] }],
        } as OpenAI.Responses.ResponseOutputMessage,
      ],
    }));
    expect(r.text).toBe("hello world");
    expect(r.toolCalls).toHaveLength(0);
    expect(r.reasoning).toBeUndefined();
    expect(r.stopReason).toBe("end_turn");
  });

  test("extracts a function call into toolCalls and sets stopReason: tool_use", () => {
    const r = convertResponse(fakeResponse({
      output: [
        {
          type: "function_call",
          call_id: "call_xyz",
          name: "click",
          arguments: '{"selector":"button"}',
          id: "fc_1",
          status: "completed",
        } as OpenAI.Responses.ResponseFunctionToolCall,
      ],
    }));
    expect(r.toolCalls).toEqual([{ id: "call_xyz", name: "click", arguments: { selector: "button" } }]);
    expect(r.stopReason).toBe("tool_use");
  });

  test("joins multiple reasoning summary parts into AgentResponse.reasoning", () => {
    const r = convertResponse(fakeResponse({
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "First, I considered..." },
            { type: "summary_text", text: " then I decided..." },
          ],
        } as OpenAI.Responses.ResponseReasoningItem,
      ],
    }));
    expect(r.reasoning).toBe("First, I considered... then I decided...");
  });

  test("preserves the full output[] array as rawAssistantMessage so reasoning items round-trip", () => {
    // The cache-utilization gain depends on encrypted_content
    // surviving the convert→push→re-send round trip byte-for-byte.
    const reasoningItem: OpenAI.Responses.ResponseReasoningItem = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "OPAQUE_BLOB_DO_NOT_TOUCH",
    };
    const fnCall: OpenAI.Responses.ResponseFunctionToolCall = {
      type: "function_call",
      call_id: "call_1",
      name: "screenshot",
      arguments: "{}",
      id: "fc_1",
      status: "completed",
    };
    const r = convertResponse(fakeResponse({ output: [reasoningItem, fnCall] }));
    expect(r.rawAssistantMessage).toEqual([reasoningItem, fnCall]);
    // Sanity: encrypted_content is preserved untouched.
    const items = r.rawAssistantMessage as OpenAI.Responses.ResponseOutputItem[];
    const ri = items[0] as OpenAI.Responses.ResponseReasoningItem;
    expect(ri.encrypted_content).toBe("OPAQUE_BLOB_DO_NOT_TOUCH");
  });

  test("subtracts cached_tokens from input_tokens to produce uncached count", () => {
    const r = convertResponse(fakeResponse({
      output: [],
      usage: {
        input_tokens: 1500,
        input_tokens_details: { cached_tokens: 1000 },
        output_tokens: 200,
        output_tokens_details: { reasoning_tokens: 50 },
        total_tokens: 1700,
      },
    }));
    expect(r.usage.inputTokens).toBe(500);
    expect(r.usage.cacheReadInputTokens).toBe(1000);
    expect(r.usage.outputTokens).toBe(200);
  });

  test("rawUsage carries the provider usage object verbatim for the cost sidecar", () => {
    const usage = {
      input_tokens: 1500,
      input_tokens_details: { cached_tokens: 1000 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 50 },
      total_tokens: 1700,
    };
    const r = convertResponse(fakeResponse({ output: [], usage }));
    expect(r.rawUsage).toEqual(usage);
  });

  test("cacheReadInputTokens is undefined when cached_tokens is 0", () => {
    const r = convertResponse(fakeResponse({
      output: [],
      usage: {
        input_tokens: 800,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 900,
      },
    }));
    expect(r.usage.inputTokens).toBe(800);
    expect(r.usage.cacheReadInputTokens).toBeUndefined();
  });

  test("refusal content surfaces as text with marker and stopReason: refusal", () => {
    const r = convertResponse(fakeResponse({
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "I cannot help with that." }],
        } as OpenAI.Responses.ResponseOutputMessage,
      ],
    }));
    expect(r.text).toBe("[refusal] I cannot help with that.");
    expect(r.stopReason).toBe("refusal");
  });
});

describe("deriveStopReason", () => {
  const mk = (status: OpenAI.Responses.ResponseStatus | undefined, reason?: "max_output_tokens" | "content_filter") =>
    fakeResponse({
      output: [],
      ...(status !== undefined && { status }),
      ...(reason && { incomplete_details: { reason } }),
    });

  test("any function call → tool_use (regardless of status)", () => {
    expect(deriveStopReason(mk("completed"), 1, false)).toBe("tool_use");
  });

  test("refusal beats max_tokens / content_filter", () => {
    expect(deriveStopReason(mk("incomplete", "max_output_tokens"), 0, true)).toBe("refusal");
  });

  test("incomplete + max_output_tokens → max_tokens", () => {
    expect(deriveStopReason(mk("incomplete", "max_output_tokens"), 0, false)).toBe("max_tokens");
  });

  test("incomplete + content_filter → stop_sequence (existing convention)", () => {
    expect(deriveStopReason(mk("incomplete", "content_filter"), 0, false)).toBe("stop_sequence");
  });

  test("completed with text → end_turn", () => {
    expect(deriveStopReason(mk("completed"), 0, false)).toBe("end_turn");
  });

  test("undefined status → end_turn", () => {
    expect(deriveStopReason(mk(undefined), 0, false)).toBe("end_turn");
  });
});

const skip = !process.env.OPENAI_API_KEY;

describe.skipIf(skip)("OpenAIClient integration", () => {
  const client = skip ? null! : createOpenAIClient("gpt-5-mini");

  test("userMessage creates a Responses-shaped user message item", () => {
    const msg = client.userMessage("hello");
    expect(msg).toEqual({ type: "message", role: "user", content: "hello" });
  });
});


import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attemptRows, withAssessmentFixture } from "./assessment-fixture";

const fixtureModel = "gpt-5.4-mini";
const fixtureResponse = { id: "resp_fixture", object: "response", model: fixtureModel, status: "completed", output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture answer", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
const withOpenAIAssessmentFixture = withAssessmentFixture({
  provider: "openai",
  model: fixtureModel,
  createClient: createOpenAIClient,
  env: baseURL => ({
    OPENAI_BASE_URL: baseURL,
    OPENAI_API_KEY: "fixture-api-key",
    OPENAI_ORG_ID: undefined,
    OPENAI_PROJECT_ID: undefined,
  }),
});

describe("openai assessment request control through the pinned SDK", () => {
  test("two HTTP retries consume three attempts; a continuation is refused without changing body or auth", async () => {
    const seen: Array<{ body: string; headers: Headers }> = [];
    await withOpenAIAssessmentFixture(async (request, index) => {
      seen.push({ body: await request.text(), headers: request.headers });
      return index < 2
        ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture retry" } }, { status: 429, headers: { "retry-after-ms": "1" } })
        : Response.json(fixtureResponse);
    }, async ({ client, journal, outDir }) => {
      const messages = [client.userMessage("unchanged prompt")];
      const tools = [{ name: "submit", description: "Submit report", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }];
      const controlled = await client.chat(messages, tools, "unchanged instructions", { runId: "fixture-run", assessment: journal.forRequest("logical-1", new AbortController().signal) });
      expect(controlled.text).toBe("fixture answer");
      expect(journal.snapshot()).toMatchObject({ admitted: 3, settled: 3, unknownUsageAttemptIds: ["001", "002"], usage: { inputTokens: 10, outputTokens: 4 } });
      await expect(client.chat(messages, tools, "unchanged instructions", { assessment: journal.forRequest("logical-2", new AbortController().signal) })).rejects.toThrow();
      expect(seen).toHaveLength(3);
      await client.chat(messages, tools, "unchanged instructions", { runId: "fixture-run" });
      expect(seen).toHaveLength(4);
      for (const request of seen) expect(JSON.parse(request.body)).toEqual(JSON.parse(seen[3].body));
      expect(seen[2].headers.get("authorization")).toBe(seen[3].headers.get("authorization"));
      expect(seen[2].headers.get("authorization")).toBe("Bearer fixture-api-key");
      const events = attemptRows(outDir);
      expect(events.filter(e => e.event === "admission").map(e => [e.assessment_request_id, e.assessment_attempt_id])).toEqual([["logical-1", "001"], ["logical-1", "002"], ["logical-1", "003"]]);
      const settlements = events.filter(e => e.event === "settlement");
      expect(settlements.map(e => e.usage)).toEqual(["not_returned", "not_returned", "recorded"]);
      expect(attemptRows(outDir, "usage.jsonl")).toHaveLength(1);
      expect(readFileSync(join(outDir, settlements[2].request_body_path), "utf8")).toBe(seen[2].body);
    });
  });

  test("cancellation aborts a pending request while an unrelated concurrent client completes", async () => {
    let started!: () => void;
    const firstRequest = new Promise<void>(resolve => { started = resolve; });
    let release!: (response: Response) => void;
    let releaseTimer: ReturnType<typeof setTimeout>;
    await withOpenAIAssessmentFixture((_request, index) => {
      if (index > 0) return Response.json(fixtureResponse);
      started();
      return new Promise<Response>(resolve => {
        release = resolve;
        releaseTimer = setTimeout(() => resolve(Response.json(fixtureResponse)), 100);
      });
    }, async ({ client, journal, outDir }) => {
      const abort = new AbortController();
      const pending = client.chat([client.userMessage("pending")], [], "system", { assessment: journal.forRequest("pending", abort.signal) });
      await firstRequest;
      const unrelated = createOpenAIClient(fixtureModel).chat([client.userMessage("ordinary")], [], "system");
      abort.abort();
      try {
        await expect(pending).rejects.toThrow();
        expect((await unrelated).text).toBe("fixture answer");
        expect(journal.snapshot()).toMatchObject({ admitted: 1, settled: 1, unknownUsageAttemptIds: ["001"] });
        expect(attemptRows(outDir)[1]).toMatchObject({ outcome: "aborted", usage: "not_returned" });
      } finally { clearTimeout(releaseTimer); release(Response.json(fixtureResponse)); }
    });
  });

  test("an SDK retry after work expiry never reaches the fixture", async () => {
    let expire!: () => void;
    let requests = 0;
    await withOpenAIAssessmentFixture(() => {
      requests++;
      expire();
      return Response.json({ type: "error", error: { message: "retry after expiry" } }, { status: 429, headers: { "retry-after-ms": "1" } });
    }, async ({ client, journal, expire: expireWork }) => {
      expire = expireWork;
      await expect(client.chat([client.userMessage("test")], [], "system", { assessment: journal.forRequest("expired", new AbortController().signal) })).rejects.toThrow();
      expect(requests).toBe(1);
      expect(journal.snapshot().admitted).toBe(1);
    });
  });

  test("native usage is written even when adapter conversion rejects model output", async () => {
    await withOpenAIAssessmentFixture(() => Response.json({ ...fixtureResponse, output: [{ type: "function_call", call_id: "bad", name: "submit", arguments: "{broken" }] }), async ({ client, journal, outDir }) => {
      await expect(client.chat([client.userMessage("test")], [], "system", { assessment: journal.forRequest("bad-content", new AbortController().signal) })).rejects.toThrow();
      expect(journal.snapshot()).toMatchObject({ admitted: 1, settled: 1, unknownUsageAttemptIds: [], usage: { inputTokens: 10, outputTokens: 4 } });
      expect(attemptRows(outDir, "usage.jsonl")).toHaveLength(1);
    });
  });
});

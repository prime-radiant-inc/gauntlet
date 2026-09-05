import { describe, test, expect } from "bun:test";
import OpenAI from "openai";
import {
  createOpenAIClient,
  openaiToolResultMessages,
  convertResponse,
  deriveStopReason,
  promptCacheKey,
} from "../../src/models/openai";

describe("promptCacheKey", () => {
  test("preserves run IDs at or below the API limit", () => {
    expect(promptCacheKey("short-run-id")).toBe("short-run-id");
    expect(promptCacheKey("x".repeat(64))).toBe("x".repeat(64));
  });

  test("truncates run IDs above the API limit", () => {
    expect(promptCacheKey("x".repeat(66))).toBe("x".repeat(64));
  });
});

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

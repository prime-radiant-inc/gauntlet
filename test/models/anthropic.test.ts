import { describe, test, expect } from "bun:test";
import {
  createAnthropicClient,
  anthropicToolResultMessages,
  convertResponse,
  resolveAnthropicAuth,
  buildAnthropicSystemBlocks,
  buildAnthropicClientOptions,
  CLAUDE_CODE_IDENTITY,
} from "../../src/models/anthropic";
import type Anthropic from "@anthropic-ai/sdk";

import { maxOutputTokensForModel } from "../../src/models/anthropic";

describe("resolveAnthropicAuth", () => {
  test("prefers a subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN) over an API key", () => {
    expect(
      resolveAnthropicAuth({
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-aaa",
        ANTHROPIC_API_KEY: "sk-ant-api03-bbb",
      }),
    ).toEqual({ mode: "oauth", token: "sk-ant-oat01-aaa" });
  });

  test("accepts ANTHROPIC_AUTH_TOKEN as the OAuth source", () => {
    expect(resolveAnthropicAuth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-ccc" })).toEqual({
      mode: "oauth",
      token: "sk-ant-oat01-ccc",
    });
  });

  test("falls back to the API key when no OAuth token is present", () => {
    expect(resolveAnthropicAuth({ ANTHROPIC_API_KEY: "sk-ant-api03-bbb" })).toEqual({
      mode: "api-key",
    });
  });

  test("throws when neither an OAuth token nor an API key is set", () => {
    expect(() => resolveAnthropicAuth({})).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/,
    );
  });
});

describe("buildAnthropicClientOptions", () => {
  test("OAuth mode pins apiKey:null so the SDK can't fall back to x-api-key", () => {
    // The SDK emits BOTH x-api-key and Authorization when apiKey is set (even
    // via env) alongside authToken; the server validates x-api-key first → 401.
    // apiKey:null is what forces Bearer-only.
    const opts = buildAnthropicClientOptions({ mode: "oauth", token: "sk-ant-oat01-aaa" });
    expect(opts).toEqual({
      authToken: "sk-ant-oat01-aaa",
      apiKey: null,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });
  });

  test("API-key mode returns empty options (SDK reads ANTHROPIC_API_KEY from env)", () => {
    expect(buildAnthropicClientOptions({ mode: "api-key" })).toEqual({});
  });
});

describe("buildAnthropicSystemBlocks", () => {
  test("API-key mode: the prompt alone, carrying the cache breakpoint", () => {
    expect(buildAnthropicSystemBlocks("QA PROMPT", false)).toEqual([
      { type: "text", text: "QA PROMPT", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("OAuth mode: Claude Code identity is the FIRST block, prompt follows", () => {
    const blocks = buildAnthropicSystemBlocks("QA PROMPT", true);
    expect(blocks).toHaveLength(2);
    // Anthropic gates subscription tokens on the first system block being the
    // exact Claude Code identity (verified: wrong/second-place → 429).
    expect(blocks[0]).toEqual({ type: "text", text: CLAUDE_CODE_IDENTITY });
    expect(CLAUDE_CODE_IDENTITY).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(blocks[1]).toEqual({
      type: "text",
      text: "QA PROMPT",
      cache_control: { type: "ephemeral" },
    });
  });
});

describe("maxOutputTokensForModel", () => {
  test("legacy Claude 3.0 family is capped at 4096", () => {
    expect(maxOutputTokensForModel("claude-3-opus-20240229")).toBe(4096);
    expect(maxOutputTokensForModel("claude-3-haiku-20240307")).toBe(4096);
    expect(maxOutputTokensForModel("claude-3-sonnet-20240229")).toBe(4096);
  });

  test("Claude 3.5/3.7 family is capped at 8192", () => {
    expect(maxOutputTokensForModel("claude-3-5-sonnet-20241022")).toBe(8192);
    expect(maxOutputTokensForModel("claude-3-5-haiku-20241022")).toBe(8192);
    expect(maxOutputTokensForModel("claude-3-7-sonnet-20250219")).toBe(8192);
  });

  test("known current model families get the full 16384 budget", () => {
    expect(maxOutputTokensForModel("claude-sonnet-4-6")).toBe(16384);
    expect(maxOutputTokensForModel("claude-opus-4-7")).toBe(16384);
    expect(maxOutputTokensForModel("claude-opus-4-20250514")).toBe(16384);
    expect(maxOutputTokensForModel("claude-haiku-4-5-20251001")).toBe(16384);
    expect(maxOutputTokensForModel("claude-fable-5")).toBe(16384);
    expect(maxOutputTokensForModel("claude-mythos-5")).toBe(16384);
  });

  test("Claude 5 named-tier family (opus/sonnet/haiku-5) gets the full 16384 budget", () => {
    // The named-tier generation number is version-agnostic: gen 5 (and beyond)
    // must get the same headroom as gen 4. The pre-fix regex pinned `-4`, so
    // claude-sonnet-5 fell to the 4096 fallback that "killed a run mid-verdict".
    expect(maxOutputTokensForModel("claude-sonnet-5")).toBe(16384);
    expect(maxOutputTokensForModel("claude-opus-5")).toBe(16384);
    expect(maxOutputTokensForModel("claude-haiku-5")).toBe(16384);
  });

  test("Bedrock/Mantle-prefixed ids get their native family's budget", () => {
    // The vendor prefix is transport naming, not a different model: the cap
    // that fits claude-sonnet-5 fits anthropic.claude-sonnet-5.
    expect(maxOutputTokensForModel("anthropic.claude-sonnet-5")).toBe(16384);
    expect(maxOutputTokensForModel("anthropic.claude-opus-4-8")).toBe(16384);
    expect(maxOutputTokensForModel("anthropic.claude-3-5-sonnet-20241022")).toBe(8192);
    expect(maxOutputTokensForModel("anthropic.claude-3-opus-20240229")).toBe(4096);
  });

  test("unrecognized or ancient model ids fall back to the conservative 4096", () => {
    expect(maxOutputTokensForModel("claude-2.1")).toBe(4096);
    expect(maxOutputTokensForModel("claude-instant-1.2")).toBe(4096);
    expect(maxOutputTokensForModel("claude-experimental-thing")).toBe(4096);
  });
});

describe("anthropicToolResultMessages", () => {
  test("creates tool_result content blocks", () => {
    const calls = [
      { id: "toolu_abc", name: "screenshot", arguments: {} },
      { id: "toolu_def", name: "click", arguments: { x: 10, y: 20 } },
    ];
    const results = [
      { kind: "text" as const, text: "base64data" },
      { kind: "text" as const, text: "clicked" },
    ];

    const messages = anthropicToolResultMessages(calls, results);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_abc", content: "base64data" },
        { type: "tool_result", tool_use_id: "toolu_def", content: "clicked" },
      ],
    });
  });

  test("handles undefined text gracefully", () => {
    const calls = [
      { id: "toolu_abc", name: "eval", arguments: {} },
    ];
    const results = [{ kind: "text" as const, text: undefined as unknown as string }];

    const messages = anthropicToolResultMessages(calls, results);

    expect(messages).toHaveLength(1);
    const content = (messages[0] as any).content;
    expect(content[0].content).toBe("");
  });

  test("handles undefined text in image result", () => {
    const calls = [
      { id: "toolu_img", name: "screenshot", arguments: {} },
    ];
    const results = [{
      kind: "image" as const,
      text: undefined as unknown as string,
      image: { data: "aGVsbG8=", mediaType: "image/png" },
    }];

    const messages = anthropicToolResultMessages(calls, results);

    const content = (messages[0] as any).content;
    const toolResult = content[0];
    const textBlock = toolResult.content.find((b: any) => b.type === "text");
    expect(typeof textBlock.text).toBe("string");
    expect(textBlock.text).toBe("");
  });

  test("embeds image content block when image is present", () => {
    const calls = [
      { id: "toolu_img", name: "screenshot", arguments: {} },
    ];
    const results = [{
      kind: "image" as const,
      text: "Screenshot saved to screenshots/001.png",
      image: { data: "aGVsbG8=", mediaType: "image/png" },
    }];

    const messages = anthropicToolResultMessages(calls, results);

    expect(messages).toHaveLength(1);
    const content = (messages[0] as any).content;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_img",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "aGVsbG8=",
          },
        },
        { type: "text", text: "Screenshot saved to screenshots/001.png" },
      ],
    });
  });
});

describe("convertResponse stop_reason pass-through", () => {
  function makeMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello", citations: null }] as unknown as Anthropic.Message["content"],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } as unknown as Anthropic.Message["usage"],
      ...overrides,
    } as Anthropic.Message;
  }

  test("end_turn passes through", () => {
    const r = convertResponse(makeMessage({ stop_reason: "end_turn" }));
    expect(r.stopReason).toBe("end_turn");
  });

  test("tool_use passes through", () => {
    const r = convertResponse(makeMessage({ stop_reason: "tool_use" }));
    expect(r.stopReason).toBe("tool_use");
  });

  test("max_tokens passes through (not collapsed to end_turn)", () => {
    const r = convertResponse(makeMessage({ stop_reason: "max_tokens" }));
    expect(r.stopReason).toBe("max_tokens");
  });

  test("stop_sequence passes through", () => {
    const r = convertResponse(makeMessage({ stop_reason: "stop_sequence" }));
    expect(r.stopReason).toBe("stop_sequence");
  });

  test("pause_turn passes through", () => {
    const r = convertResponse(makeMessage({ stop_reason: "pause_turn" }));
    expect(r.stopReason).toBe("pause_turn");
  });

  test("null stop_reason falls back to end_turn", () => {
    const r = convertResponse(makeMessage({ stop_reason: null }));
    expect(r.stopReason).toBe("end_turn");
  });
});

describe("convertResponse cache token capture", () => {
  function makeMessageWithUsage(usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  }): Anthropic.Message {
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello", citations: null }] as unknown as Anthropic.Message["content"],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: usage as unknown as Anthropic.Message["usage"],
    } as Anthropic.Message;
  }

  test("captures cache_creation_input_tokens", () => {
    const r = convertResponse(
      makeMessageWithUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 750,
        cache_read_input_tokens: 0,
      }),
    );
    expect(r.usage.cacheCreationInputTokens).toBe(750);
    expect(r.usage.cacheReadInputTokens).toBe(0);
  });

  test("captures cache_read_input_tokens", () => {
    const r = convertResponse(
      makeMessageWithUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 900,
      }),
    );
    expect(r.usage.cacheReadInputTokens).toBe(900);
    expect(r.usage.cacheCreationInputTokens).toBe(0);
  });

  test("rawUsage carries the provider usage object verbatim for the cost sidecar", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 750,
      cache_read_input_tokens: 0,
    };
    const r = convertResponse(makeMessageWithUsage(usage));
    expect(r.rawUsage).toEqual(usage);
  });

  test("treats null cache values as undefined", () => {
    const r = convertResponse(
      makeMessageWithUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    );
    expect(r.usage.cacheCreationInputTokens).toBeUndefined();
    expect(r.usage.cacheReadInputTokens).toBeUndefined();
  });

  test("preserves input/output tokens", () => {
    const r = convertResponse(
      makeMessageWithUsage({
        input_tokens: 123,
        output_tokens: 45,
      }),
    );
    expect(r.usage.inputTokens).toBe(123);
    expect(r.usage.outputTokens).toBe(45);
  });
});

const skip = !process.env.ANTHROPIC_API_KEY;

describe.skipIf(skip)("AnthropicClient integration", () => {
  const client = skip ? null! : createAnthropicClient("claude-sonnet-4-6");

  test("userMessage creates Anthropic user message format", () => {
    const msg = client.userMessage("hello");
    expect(msg).toEqual({ role: "user", content: "hello" });
  });
});

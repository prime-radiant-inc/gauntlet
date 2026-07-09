import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, ToolDefinition, AgentResponse, StopReason, ToolCall, ToolResult } from "./provider";
import { withLlmErrorSanitization } from "../util/sanitize-error";

/**
 * Per-model output-token ceiling. 4096 killed a run mid-verdict
 * (PRI-2160, run b35d: adaptive thinking counts against the cap and a
 * judge composing its final report can think past 4k), but legacy
 * Claude 3.x models reject anything above their smaller caps, so the
 * raise is model-aware. Cost is per token actually emitted, not per
 * cap.
 */
export function maxOutputTokensForModel(model: string): number {
  // Modern named-tier families (Claude 4.x and up, Fable/Mythos): plenty of
  // output headroom — the high cap is opt-in by family, not the default. The
  // `claude-{tier}-{gen}` naming only exists for gen 4+, so a version-agnostic
  // match never collides with the 3.x `claude-3-...` ids handled below.
  if (/^claude-(opus|sonnet|haiku)-/.test(model) || /^claude-(fable|mythos)-/.test(model)) {
    return 16384;
  }
  // Claude 3.5 / 3.7 family: 8192 without beta headers.
  if (/^claude-3-[57]-/.test(model)) return 8192;
  // Everything else — Claude 3.0, Claude 2.x, and any unrecognized id —
  // keeps the conservative 4096 this code always sent before the raise.
  return 4096;
}

export function createAnthropicClient(model: string): LLMClient {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is not set. " +
      "Set it to your Anthropic API key to use Claude models."
    );
  }
  const client = new Anthropic();

  return {
    async chat(messages, tools, systemPrompt) {
      const convertedTools = tools.map(convertTool);

      // Cache breakpoint 1: system prompt
      const system: Anthropic.Messages.TextBlockParam[] = [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ];

      // Cache breakpoint 2: last tool definition
      if (convertedTools.length > 0) {
        convertedTools[convertedTools.length - 1] = {
          ...convertedTools[convertedTools.length - 1],
          cache_control: { type: "ephemeral" },
        };
      }

      // Cache breakpoint 3: last message (moving breakpoint for conversation prefix)
      const apiMessages = withCacheBreakpointOnLastMessage(
        messages as Anthropic.MessageParam[]
      );

      const response = await withLlmErrorSanitization(() =>
        client.messages.create({
          model,
          max_tokens: maxOutputTokensForModel(model),
          system,
          messages: apiMessages,
          tools: convertedTools,
          // Sonnet 4.6 defaults to effort:high when unset; medium is Anthropic's
          // recommended default for most apps and the right floor for an
          // observe-and-report tester role. Opus 4.6/4.7 honor this too.
          output_config: { effort: "medium" },
          // Adaptive thinking lets the model decide depth per turn. Thinking
          // blocks are returned in response.content alongside text/tool_use;
          // they round-trip via rawAssistantMessage (signatures intact), so
          // multi-turn loops and session revival pick them up automatically.
          thinking: { type: "adaptive" },
        }),
      );

      return convertResponse(response);
    },

    userMessage(content: string) {
      return { role: "user", content };
    },

    toolResultMessages: anthropicToolResultMessages,
  };
}

export function anthropicToolResultMessages(
  calls: ToolCall[],
  results: ToolResult[],
  extraUserText?: string,
): unknown[] {
  const content: unknown[] = calls.map((call, i) => {
    const result = results[i];
    if (result.kind === "image") {
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: result.image.mediaType,
              data: result.image.data,
            },
          },
          { type: "text", text: result.text ?? "" },
        ],
      };
    }
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: result.text ?? "",
    };
  });
  if (extraUserText) {
    content.push({ type: "text", text: extraUserText });
  }
  return [{ role: "user", content }];
}

function convertTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool["input_schema"],
  };
}

/**
 * Shallow-clone the last message and add cache_control to its last content block.
 * This creates a moving cache breakpoint so the conversation prefix is cached between turns.
 */
function withCacheBreakpointOnLastMessage(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const result = [...messages];
  const last = result[result.length - 1];

  if (typeof last.content === "string") {
    result[result.length - 1] = {
      ...last,
      content: [
        {
          type: "text" as const,
          text: last.content,
          cache_control: { type: "ephemeral" as const },
        },
      ],
    };
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const contentCopy = [...last.content];
    const lastBlock = contentCopy[contentCopy.length - 1];
    // Our content blocks are always tool_result or text, both support cache_control
    contentCopy[contentCopy.length - 1] = {
      ...lastBlock,
      cache_control: { type: "ephemeral" },
    } as typeof lastBlock;
    result[result.length - 1] = { ...last, content: contentCopy };
  }

  return result;
}

/**
 * Convert an Anthropic SDK `Message` into our provider-neutral
 * `AgentResponse`. Exported for tests; the runtime path uses it via the
 * `chat()` method above.
 */
export function convertResponse(response: Anthropic.Message): AgentResponse {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const reasoning = response.content
    .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n\n") || undefined;

  const toolCalls = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      arguments: b.input as Record<string, unknown>,
    }));

  // Pass through stop_reason faithfully. The Anthropic SDK's type already
  // matches our StopReason union for the values we care about. If Anthropic
  // ships a new value (current SDK includes `refusal` which we also cover),
  // TS will complain here and we update the union.
  const stopReason: StopReason =
    (response.stop_reason as StopReason | null) ?? "end_turn";

  // Capture cache breakpoint telemetry. `cache_creation_input_tokens` tells
  // us how many tokens were written to the cache on this turn;
  // `cache_read_input_tokens` tells us how many were served from cache. If
  // both stay at 0 across an entire run, the three breakpoints in chat()
  // are not hitting and we have a silent regression to investigate.
  const cacheCreation = response.usage.cache_creation_input_tokens;
  const cacheRead = response.usage.cache_read_input_tokens;

  return {
    text,
    reasoning,
    toolCalls,
    stopReason,
    rawAssistantMessage: { role: "assistant", content: response.content },
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: cacheCreation ?? undefined,
      cacheReadInputTokens: cacheRead ?? undefined,
    },
    rawUsage: response.usage,
  };
}

import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, ToolDefinition, AgentResponse, StopReason, ToolCall, ToolResult } from "./provider";
import { withLlmErrorSanitization } from "../util/sanitize-error";

/**
 * The native Anthropic model id behind a request id. Bedrock (and its
 * Anthropic-compatible Mantle surface) names Anthropic models with a vendor
 * prefix — `anthropic.claude-sonnet-5` is `claude-sonnet-5` served through
 * Bedrock. The request must carry the prefixed id verbatim; family-keyed
 * decisions (provider routing, output caps) key on the native id.
 */
export function nativeAnthropicModelId(model: string): string {
  return model.replace(/^anthropic\./, "");
}

/**
 * Per-model output-token ceiling. 4096 killed a run mid-verdict
 * (PRI-2160, run b35d: adaptive thinking counts against the cap and a
 * judge composing its final report can think past 4k), but legacy
 * Claude 3.x models reject anything above their smaller caps, so the
 * raise is model-aware. Cost is per token actually emitted, not per
 * cap.
 */
export function maxOutputTokensForModel(model: string): number {
  const native = nativeAnthropicModelId(model);
  // Modern named-tier families (Claude 4.x and up, Fable/Mythos): plenty of
  // output headroom — the high cap is opt-in by family, not the default. The
  // `claude-{tier}-{gen}` naming only exists for gen 4+, so a version-agnostic
  // match never collides with the 3.x `claude-3-...` ids handled below.
  if (/^claude-(opus|sonnet|haiku)-/.test(native) || /^claude-(fable|mythos)-/.test(native)) {
    return 16384;
  }
  // Claude 3.5 / 3.7 family: 8192 without beta headers.
  if (/^claude-3-[57]-/.test(native)) return 8192;
  // Everything else — Claude 3.0, Claude 2.x, and any unrecognized id —
  // keeps the conservative 4096 this code always sent before the raise.
  return 4096;
}

// A subscription OAuth token (from `claude setup-token`) authenticates over
// Bearer and is gated by Anthropic to Claude Code: the request MUST carry the
// oauth beta header AND lead its system blocks with this exact identity string,
// or the API rejects it (429). Verified empirically 2026-06-23.
export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

export type AnthropicAuth =
  | { readonly mode: "oauth"; readonly token: string }
  | { readonly mode: "api-key" };

/**
 * Decide how to authenticate to Anthropic. A logged-in subscription is
 * preferred when present: a `claude setup-token` OAuth token wins over
 * ANTHROPIC_API_KEY, which remains the fallback. Throws when neither is set.
 *
 * GAUNTLET_OAUTH_TOKEN is where the token belongs. Claude Code itself reads
 * CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_AUTH_TOKEN, so a token exported
 * globally under either of those names overrides the auth of every Claude
 * Code session on the machine, not just Gauntlet's. Both are still honoured,
 * after GAUNTLET_OAUTH_TOKEN, for environments that set them on purpose.
 */
export function resolveAnthropicAuth(
  env: Record<string, string | undefined> = process.env,
): AnthropicAuth {
  const oauthToken =
    env.GAUNTLET_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
  if (oauthToken) return { mode: "oauth", token: oauthToken };
  if (env.ANTHROPIC_API_KEY) return { mode: "api-key" };
  throw new Error(
    "No Anthropic credential found. Set GAUNTLET_OAUTH_TOKEN (a subscription " +
    "token from `claude setup-token`) to use a logged-in Claude subscription, " +
    "or ANTHROPIC_API_KEY to use a pay-per-token API key."
  );
}

/**
 * Build the request's system blocks. OAuth requires the Claude Code identity as
 * the FIRST block (order matters — Anthropic checks the first block), with the
 * caller's prompt following and carrying the cache breakpoint. API-key mode
 * sends the prompt alone, unchanged.
 */
export function buildAnthropicSystemBlocks(
  systemPrompt: string,
  useOAuth: boolean,
): Anthropic.Messages.TextBlockParam[] {
  const promptBlock: Anthropic.Messages.TextBlockParam = {
    type: "text",
    text: systemPrompt,
    cache_control: { type: "ephemeral" },
  };
  return useOAuth
    ? [{ type: "text", text: CLAUDE_CODE_IDENTITY }, promptBlock]
    : [promptBlock];
}

/**
 * Anthropic SDK constructor options for the resolved auth.
 *
 * OAuth mode pins `apiKey: null`. The SDK otherwise defaults `apiKey` from
 * `process.env.ANTHROPIC_API_KEY` even when `authToken` is given, and its
 * `authHeaders` emits BOTH `x-api-key` and `Authorization` — the server then
 * validates the (possibly wrong/absent) x-api-key first and 401s. `null` forces
 * Bearer-only. API-key mode returns `{}` so the SDK reads the key from the env,
 * unchanged.
 */
export function buildAnthropicClientOptions(
  auth: AnthropicAuth,
): ConstructorParameters<typeof Anthropic>[0] {
  if (auth.mode === "oauth") {
    return {
      authToken: auth.token,
      apiKey: null,
      defaultHeaders: { "anthropic-beta": OAUTH_BETA_HEADER },
    };
  }
  return {};
}

export function createAnthropicClient(model: string): LLMClient {
  const auth = resolveAnthropicAuth();
  const useOAuth = auth.mode === "oauth";
  const client = new Anthropic(buildAnthropicClientOptions(auth));

  return {
    async chat(messages, tools, systemPrompt) {
      const convertedTools = tools.map(convertTool);

      // Cache breakpoint 1: system prompt (OAuth prepends the Claude Code
      // identity block ahead of it — see buildAnthropicSystemBlocks).
      const system = buildAnthropicSystemBlocks(systemPrompt, useOAuth);

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

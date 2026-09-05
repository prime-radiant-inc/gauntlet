import OpenAI from "openai";
import type { LLMClient, ToolDefinition, AgentResponse, StopReason, ToolCall, ToolResult } from "./provider";
import { withLlmErrorSanitization } from "../util/sanitize-error";

const MAX_PROMPT_CACHE_KEY_LENGTH = 64;

export function promptCacheKey(runId: string): string {
  return runId.slice(0, MAX_PROMPT_CACHE_KEY_LENGTH);
}

export function createOpenAIClient(model: string): LLMClient {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY environment variable is not set. " +
      "Set it to your OpenAI API key to use GPT models."
    );
  }
  const client = new OpenAI();

  return {
    async chat(messages, tools, systemPrompt, requestContext) {
      const response = await withLlmErrorSanitization(() =>
        client.responses.create({
          model,
          instructions: systemPrompt,
          input: messages as OpenAI.Responses.ResponseInputItem[],
          tools: tools.length > 0 ? tools.map(convertTool) : undefined,
          // gpt-5+ / o-series only — non-reasoning models silently
          // ignore. Effort matches the medium floor we set on Anthropic
          // (PRI-1589). Summary "auto" lets the model choose verbosity;
          // bump to "detailed" if we observe summaries are too thin.
          reasoning: { effort: "medium", summary: "auto" },
          // Receive opaque encrypted reasoning we can round-trip back
          // into input[] on the next turn — preserves chain-of-thought
          // across tool-call turns and keeps the cached prefix intact.
          include: ["reasoning.encrypted_content"],
          store: false,
          ...(requestContext?.runId && { prompt_cache_key: promptCacheKey(requestContext.runId) }),
        }),
      );
      return convertResponse(response);
    },

    userMessage(content: string) {
      return { type: "message", role: "user", content };
    },

    toolResultMessages: openaiToolResultMessages,
  };
}

export function openaiToolResultMessages(
  calls: ToolCall[],
  results: ToolResult[],
  extraUserText?: string,
): unknown[] {
  const items: unknown[] = calls.map((call, i) => ({
    type: "function_call_output",
    call_id: call.id,
    output: results[i].text ?? "",
  }));

  // Image attachments ride along as a separate user-role item with
  // ResponseInputImage content. `image_url` is a flat data-URL string
  // here (not nested under image_url.url like Chat Completions).
  const imageParts: Array<Record<string, unknown>> = [];
  for (const result of results) {
    if (result.kind === "image") {
      imageParts.push({
        type: "input_image",
        image_url: `data:${result.image.mediaType};base64,${result.image.data}`,
        detail: "auto",
      });
    }
  }

  if (imageParts.length > 0) {
    items.push({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Screenshots from the tool calls above:" },
        ...imageParts,
      ],
    });
  }

  if (extraUserText) {
    items.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: extraUserText }],
    });
  }

  return items;
}

function convertTool(tool: ToolDefinition): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

export function convertResponse(response: OpenAI.Responses.Response): AgentResponse {
  let text = "";
  let reasoning = "";
  let hasRefusal = false;
  const toolCalls: ToolCall[] = [];

  for (const item of response.output) {
    switch (item.type) {
      case "message": {
        for (const part of item.content) {
          if (part.type === "output_text") {
            text += part.text;
          } else if (part.type === "refusal") {
            text += `[refusal] ${part.refusal}`;
            hasRefusal = true;
          }
        }
        break;
      }
      case "function_call":
        toolCalls.push({
          id: item.call_id,
          name: item.name,
          arguments: JSON.parse(item.arguments),
        });
        break;
      case "reasoning":
        for (const s of item.summary) reasoning += s.text;
        break;
      // Other ResponseOutputItem types (file_search, web_search,
      // computer_use, code_interpreter, MCP, etc.) are not registered
      // on this client so won't appear in practice. Leaving them
      // unhandled is a deliberate scope choice — see the spec.
    }
  }

  // OpenAI Responses' `input_tokens` *includes* `cached_tokens`;
  // subtract so `TokenUsage.inputTokens` stays uncached-only across
  // both providers (Anthropic's `input_tokens` is naturally disjoint).
  const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  const inputTokens = (response.usage?.input_tokens ?? 0) - cached;

  return {
    text,
    reasoning: reasoning || undefined,
    toolCalls,
    stopReason: deriveStopReason(response, toolCalls.length, hasRefusal),
    // The full output[] array is replayed into the next turn's input[]
    // via pushAssistantTurn (which spreads arrays). This is how
    // reasoning items round-trip across turns — the load-bearing
    // behavior for the cache-utilization gain.
    rawAssistantMessage: response.output,
    usage: {
      inputTokens,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadInputTokens: cached || undefined,
    },
    rawUsage: response.usage,
  };
}

/**
 * Map a Responses API result to our provider-neutral StopReason.
 *
 * Responses has no `finish_reason`; we derive from the output-item
 * mix and `Response.status` + `incomplete_details.reason`.
 */
export function deriveStopReason(
  response: OpenAI.Responses.Response,
  toolCallCount: number,
  hasRefusal: boolean,
): StopReason {
  if (toolCallCount > 0) return "tool_use";
  if (hasRefusal) return "refusal";
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "max_tokens";
    if (reason === "content_filter") return "stop_sequence";
  }
  return "end_turn";
}

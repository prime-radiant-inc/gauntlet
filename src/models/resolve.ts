import type { LLMClient, Provider } from "./provider";
import type { ModelConfig } from "../types";
import { createAnthropicClient, nativeAnthropicModelId } from "./anthropic";
import { createOpenAIClient } from "./openai";

export const SUPPORTED_MODEL_PREFIXES_MESSAGE =
  "Supported prefixes: claude*, anthropic.claude*, gpt*, o1*, o3*";

export class UnknownModelProviderError extends Error {
  readonly code = "unknown_model";

  constructor(readonly model: string) {
    super(`Model not supported. ${SUPPORTED_MODEL_PREFIXES_MESSAGE}`);
    this.name = "UnknownModelProviderError";
  }
}

export function createClientForProvider(model: string, provider: Provider): LLMClient {
  switch (provider) {
    case "anthropic":
      return createAnthropicClient(model);
    case "openai":
      return createOpenAIClient(model);
  }
}

export function createClient(model: string): LLMClient {
  return createClientForProvider(model, resolveProvider(model));
}

export function resolveProvider(model: string): Provider {
  if (nativeAnthropicModelId(model).startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) {
    return "openai";
  }
  throw new UnknownModelProviderError(model);
}

export function parseModelFlags(flags: string[]): Partial<ModelConfig> {
  const config: Partial<ModelConfig> = {};

  for (const flag of flags) {
    const idx = flag.indexOf("=");
    if (idx === -1) continue;
    const role = flag.slice(0, idx) as keyof ModelConfig;
    const model = flag.slice(idx + 1);
    config[role] = model;
  }

  return config;
}

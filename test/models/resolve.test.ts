import { describe, test, expect } from "bun:test";
import { UnknownModelProviderError, parseModelFlags, resolveProvider } from "../../src/models/resolve";

describe("resolveProvider", () => {
  test("returns anthropic for claude models", () => {
    expect(resolveProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(resolveProvider("claude-opus-4-6")).toBe("anthropic");
    expect(resolveProvider("claude-3-5-sonnet-20241022")).toBe("anthropic");
  });

  test("returns anthropic for Bedrock/Mantle-prefixed claude models", () => {
    // Bedrock (and its Anthropic-compatible Mantle surface) names Anthropic
    // models with a vendor prefix; the request must carry that id verbatim,
    // so routing keys on the native id behind it.
    expect(resolveProvider("anthropic.claude-sonnet-5")).toBe("anthropic");
    expect(resolveProvider("anthropic.claude-opus-4-8")).toBe("anthropic");
  });

  test("returns openai for gpt/o-series models", () => {
    expect(resolveProvider("gpt-4o")).toBe("openai");
    expect(resolveProvider("gpt-4o-mini")).toBe("openai");
    expect(resolveProvider("gpt-5-mini")).toBe("openai");
    expect(resolveProvider("o3")).toBe("openai");
    expect(resolveProvider("o1-preview")).toBe("openai");
  });

  test("throws typed unknown-model error for unsupported prefixes", () => {
    expect(() => resolveProvider("unknown-model")).toThrow(UnknownModelProviderError);

    try {
      resolveProvider("unknown-model");
      throw new Error("expected resolveProvider to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownModelProviderError);
      expect((err as UnknownModelProviderError).code).toBe("unknown_model");
      expect((err as UnknownModelProviderError).message).toContain("claude*");
      expect((err as UnknownModelProviderError).message).toContain("anthropic.claude*");
      expect((err as UnknownModelProviderError).message).toContain("gpt*");
      expect((err as UnknownModelProviderError).message).toContain("o1*");
      expect((err as UnknownModelProviderError).message).toContain("o3*");
    }
  });
});

describe("parseModelFlags", () => {
  test("returns empty object when no flags provided", () => {
    const config = parseModelFlags([]);
    expect(config).toEqual({});
  });

  test("parses agent flag", () => {
    expect(parseModelFlags(["agent=claude-opus-4-6"])).toEqual({ agent: "claude-opus-4-6" });
  });

  test("parses fanout flag", () => {
    expect(parseModelFlags(["fanout=gpt-4o"])).toEqual({ fanout: "gpt-4o" });
  });
});

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, validateRunBody, mergeRunConfig, requireLlmCapable } from "../src/config";

describe("loadConfig", () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;

  function withExecutableResolver<T>(fn: (resolverPath: string) => T): T {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-cfg-resolver-"));
    const resolverPath = join(tmp, "resolver.sh");
    writeFileSync(resolverPath, "#!/bin/sh\necho ok\n");
    chmodSync(resolverPath, 0o755);
    try {
      return fn(resolverPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("all defaults when no args and empty env", () => {
    const c = loadConfig({}, emptyEnv);
    expect(c.projectRoot).toBe(".");
    expect(c.stateDirName).toBe(".gauntlet");
    expect(c.port).toBe(4400);
    expect(c.defaultChrome).toEqual({ host: "127.0.0.1", port: 9222 });
    expect(c.models.agent).toBe("claude-sonnet-4-6");
    expect(c.models.fanout).toBeUndefined();
    expect(c.models.available).toEqual([]);
    expect(c.apiKeys).toEqual({ anthropic: false, openai: false });
    expect(c.sources.projectRoot).toBe("default");
    expect(c.sources.stateDirName).toBe("default");
  });

  describe("stateDirName", () => {
    test("GAUNTLET_STATE_DIR env var overrides default", () => {
      const c = loadConfig({}, { GAUNTLET_STATE_DIR: "gauntlet" } as NodeJS.ProcessEnv);
      expect(c.stateDirName).toBe("gauntlet");
      expect(c.sources.stateDirName).toBe("env");
    });

    test("--state-dir flag overrides env", () => {
      const c = loadConfig(
        { stateDirName: ".gnt" },
        { GAUNTLET_STATE_DIR: "gauntlet" } as NodeJS.ProcessEnv,
      );
      expect(c.stateDirName).toBe(".gnt");
      expect(c.sources.stateDirName).toBe("flag");
    });

    test("rejects empty string", () => {
      expect(() => loadConfig({ stateDirName: "" }, emptyEnv)).toThrow(/--state-dir/);
    });

    test("rejects slashes", () => {
      expect(() => loadConfig({ stateDirName: "a/b" }, emptyEnv)).toThrow(/single path segment/);
      expect(() => loadConfig({ stateDirName: "a\\b" }, emptyEnv)).toThrow(/single path segment/);
      expect(() => loadConfig({}, { GAUNTLET_STATE_DIR: "x/y" } as NodeJS.ProcessEnv))
        .toThrow(/single path segment/);
    });

    test("rejects . and ..", () => {
      expect(() => loadConfig({ stateDirName: "." }, emptyEnv)).toThrow(/cannot be/);
      expect(() => loadConfig({ stateDirName: ".." }, emptyEnv)).toThrow(/cannot be/);
    });
  });

  test("env vars override defaults", () => {
    const c = loadConfig({}, {
      GAUNTLET_PORT: "5500",
      GAUNTLET_AGENT_MODEL: "gpt-4o",
      GAUNTLET_PROJECT_ROOT: "/data",
      GAUNTLET_CHROME: "chrome-svc:9333",
      GAUNTLET_MODELS: "claude-sonnet-4-6,gpt-4o",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    } as NodeJS.ProcessEnv);
    expect(c.port).toBe(5500);
    expect(c.models.agent).toBe("gpt-4o");
    expect(c.projectRoot).toBe("/data");
    expect(c.defaultChrome).toEqual({ host: "chrome-svc", port: 9333 });
    expect(c.models.available).toEqual(["claude-sonnet-4-6", "gpt-4o"]);
    expect(c.apiKeys.anthropic).toBe(true);
    expect(c.apiKeys.openai).toBe(false);
    expect(c.sources.port).toBe("env");
    expect(c.sources["models.agent"]).toBe("env");
  });

  test("CLI args override env vars", () => {
    const c = loadConfig(
      { port: 6600, projectRoot: "/flag", chrome: "flag-host:9444", models: { agent: "claude-opus-4-6" } },
      { GAUNTLET_PORT: "5500", GAUNTLET_PROJECT_ROOT: "/env", GAUNTLET_CHROME: "env:9333", GAUNTLET_AGENT_MODEL: "gpt-4o" } as NodeJS.ProcessEnv,
    );
    expect(c.port).toBe(6600);
    expect(c.projectRoot).toBe("/flag");
    expect(c.defaultChrome).toEqual({ host: "flag-host", port: 9444 });
    expect(c.models.agent).toBe("claude-opus-4-6");
    expect(c.sources.port).toBe("flag");
    expect(c.sources.projectRoot).toBe("flag");
    expect(c.sources.defaultChrome).toBe("flag");
    expect(c.sources["models.agent"]).toBe("flag");
  });

  test("invalid GAUNTLET_CHROME format throws", () => {
    expect(() => loadConfig({}, { GAUNTLET_CHROME: "no-port-here" } as NodeJS.ProcessEnv))
      .toThrow(/GAUNTLET_CHROME/);
  });

  test("invalid --chrome format throws", () => {
    expect(() => loadConfig({ chrome: "no-port-here" }, emptyEnv))
      .toThrow(/chrome/i);
  });

  test("invalid port in env throws", () => {
    expect(() => loadConfig({}, { GAUNTLET_PORT: "not-a-number" } as NodeJS.ProcessEnv))
      .toThrow(/GAUNTLET_PORT/);
  });

  test("available models defaults to [] (no allow-list) when GAUNTLET_MODELS unset", () => {
    const c = loadConfig({}, { GAUNTLET_AGENT_MODEL: "gpt-4o" } as NodeJS.ProcessEnv);
    expect(c.models.available).toEqual([]);
  });

  test("apiKeys reflects both providers when both keys set", () => {
    const c = loadConfig({}, { ANTHROPIC_API_KEY: "sk-ant-xxx", OPENAI_API_KEY: "sk-xxx" } as NodeJS.ProcessEnv);
    expect(c.apiKeys).toEqual({ anthropic: true, openai: true });
  });

  test("a subscription OAuth token counts as an Anthropic credential (no API key)", () => {
    const c = loadConfig({}, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx" } as NodeJS.ProcessEnv);
    expect(c.apiKeys.anthropic).toBe(true);
    expect(c.apiKeys.openai).toBe(false);
  });

  test("GAUNTLET_OAUTH_TOKEN alone counts as an Anthropic credential", () => {
    const c = loadConfig({}, { GAUNTLET_OAUTH_TOKEN: "sk-ant-oat01-xxx" } as NodeJS.ProcessEnv);
    expect(c.apiKeys.anthropic).toBe(true);
    expect(c.apiKeys.openai).toBe(false);
  });

  test("defaultSaveScreencast defaults to false", () => {
    const c = loadConfig({}, emptyEnv);
    expect(c.defaultSaveScreencast).toBe(false);
    expect(c.sources.defaultSaveScreencast).toBe("default");
  });

  test("GAUNTLET_SAVE_SCREENCAST=1 enables (env source)", () => {
    const c = loadConfig({}, { GAUNTLET_SAVE_SCREENCAST: "1" } as NodeJS.ProcessEnv);
    expect(c.defaultSaveScreencast).toBe(true);
    expect(c.sources.defaultSaveScreencast).toBe("env");
  });

  test("GAUNTLET_SAVE_SCREENCAST=false disables explicitly (still env source)", () => {
    const c = loadConfig({}, { GAUNTLET_SAVE_SCREENCAST: "false" } as NodeJS.ProcessEnv);
    expect(c.defaultSaveScreencast).toBe(false);
    expect(c.sources.defaultSaveScreencast).toBe("env");
  });

  test("--save-screencast flag overrides env", () => {
    const c = loadConfig(
      { saveScreencast: true },
      { GAUNTLET_SAVE_SCREENCAST: "0" } as NodeJS.ProcessEnv,
    );
    expect(c.defaultSaveScreencast).toBe(true);
    expect(c.sources.defaultSaveScreencast).toBe("flag");
  });

  test("invalid GAUNTLET_SAVE_SCREENCAST throws", () => {
    expect(() => loadConfig({}, { GAUNTLET_SAVE_SCREENCAST: "maybe" } as NodeJS.ProcessEnv))
      .toThrow(/GAUNTLET_SAVE_SCREENCAST/);
  });

  test("defaultReflectionInterval defaults to 10", () => {
    const c = loadConfig({}, emptyEnv);
    expect(c.defaultReflectionInterval).toBe(10);
    expect(c.sources.defaultReflectionInterval).toBe("default");
  });

  test("GAUNTLET_REFLECTION_INTERVAL overrides default", () => {
    const c = loadConfig({}, { GAUNTLET_REFLECTION_INTERVAL: "5" } as NodeJS.ProcessEnv);
    expect(c.defaultReflectionInterval).toBe(5);
    expect(c.sources.defaultReflectionInterval).toBe("env");
  });

  test("GAUNTLET_REFLECTION_INTERVAL=0 disables", () => {
    const c = loadConfig({}, { GAUNTLET_REFLECTION_INTERVAL: "0" } as NodeJS.ProcessEnv);
    expect(c.defaultReflectionInterval).toBe(0);
    expect(c.sources.defaultReflectionInterval).toBe("env");
  });

  test("--reflection-interval flag overrides env", () => {
    const c = loadConfig(
      { reflectionInterval: 7 },
      { GAUNTLET_REFLECTION_INTERVAL: "20" } as NodeJS.ProcessEnv,
    );
    expect(c.defaultReflectionInterval).toBe(7);
    expect(c.sources.defaultReflectionInterval).toBe("flag");
  });

  test("invalid GAUNTLET_REFLECTION_INTERVAL throws", () => {
    expect(() => loadConfig({}, { GAUNTLET_REFLECTION_INTERVAL: "-1" } as NodeJS.ProcessEnv))
      .toThrow(/GAUNTLET_REFLECTION_INTERVAL/);
    expect(() => loadConfig({}, { GAUNTLET_REFLECTION_INTERVAL: "abc" } as NodeJS.ProcessEnv))
      .toThrow(/GAUNTLET_REFLECTION_INTERVAL/);
  });

  test("invalid --reflection-interval throws", () => {
    expect(() => loadConfig({ reflectionInterval: -3 }, emptyEnv))
      .toThrow(/reflection-interval/);
    expect(() => loadConfig({ reflectionInterval: 1.5 }, emptyEnv))
      .toThrow(/reflection-interval/);
  });

  test("GAUNTLET_CREDENTIAL_RESOLVER populates credentialResolver", () => {
    withExecutableResolver((resolverPath) => {
      const c = loadConfig({}, {
        GAUNTLET_CREDENTIAL_RESOLVER: resolverPath,
      } as NodeJS.ProcessEnv);
      expect(c.credentialResolver).toEqual({
        path: resolverPath,
        timeoutMs: 10_000,
        includeInTranscripts: false,
      });
      expect(c.sources.credentialResolver).toBe("env");
    });
  });

  test("credentialResolver is undefined when env var unset", () => {
    const c = loadConfig({}, {} as NodeJS.ProcessEnv);
    expect(c.credentialResolver).toBeUndefined();
    expect(c.sources.credentialResolver).toBe("default");
  });

  test("GAUNTLET_CREDENTIAL_RESOLVER_TIMEOUT_MS overrides default", () => {
    withExecutableResolver((resolverPath) => {
      const c = loadConfig({}, {
        GAUNTLET_CREDENTIAL_RESOLVER: resolverPath,
        GAUNTLET_CREDENTIAL_RESOLVER_TIMEOUT_MS: "5000",
      } as NodeJS.ProcessEnv);
      expect(c.credentialResolver?.timeoutMs).toBe(5_000);
    });
  });

  test("invalid GAUNTLET_CREDENTIAL_RESOLVER_TIMEOUT_MS throws", () => {
    withExecutableResolver((resolverPath) => {
      expect(() => loadConfig({}, {
        GAUNTLET_CREDENTIAL_RESOLVER: resolverPath,
        GAUNTLET_CREDENTIAL_RESOLVER_TIMEOUT_MS: "abc",
      } as NodeJS.ProcessEnv)).toThrow(/GAUNTLET_CREDENTIAL_RESOLVER_TIMEOUT_MS/);
    });
  });

  test("GAUNTLET_CREDENTIAL_INCLUDE_IN_TRANSCRIPTS=1 sets includeInTranscripts true", () => {
    withExecutableResolver((resolverPath) => {
      const c = loadConfig({}, {
        GAUNTLET_CREDENTIAL_RESOLVER: resolverPath,
        GAUNTLET_CREDENTIAL_INCLUDE_IN_TRANSCRIPTS: "1",
      } as NodeJS.ProcessEnv);
      expect(c.credentialResolver?.includeInTranscripts).toBe(true);
    });
  });

  test("GAUNTLET_CREDENTIAL_RESOLVER pointing at nonexistent path throws", () => {
    expect(() =>
      loadConfig({}, {
        GAUNTLET_CREDENTIAL_RESOLVER: "/nonexistent/path/credential-resolver.sh",
      } as NodeJS.ProcessEnv),
    ).toThrow(/GAUNTLET_CREDENTIAL_RESOLVER/);
  });

  test("GAUNTLET_CREDENTIAL_RESOLVER pointing at non-executable file throws", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-cfg-resolver-"));
    try {
      const resolverPath = join(tmp, "resolver.sh");
      writeFileSync(resolverPath, "not-executable");
      chmodSync(resolverPath, 0o644);
      expect(() =>
        loadConfig({}, {
          GAUNTLET_CREDENTIAL_RESOLVER: resolverPath,
        } as NodeJS.ProcessEnv),
      ).toThrow(/GAUNTLET_CREDENTIAL_RESOLVER/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("relative GAUNTLET_CREDENTIAL_RESOLVER is resolved against projectRoot", () => {
    withExecutableResolver((resolverPath) => {
      const c = loadConfig({}, {
        GAUNTLET_PROJECT_ROOT: dirname(resolverPath),
        GAUNTLET_CREDENTIAL_RESOLVER: "resolver.sh",
      } as NodeJS.ProcessEnv);
      expect(c.credentialResolver?.path).toBe(resolverPath);
    });
  });
});

describe("validateRunBody", () => {
  test("accepts minimal body with just target", () => {
    expect(validateRunBody({ target: "http://x" })).toEqual({
      target: "http://x",
      model: undefined,
      chrome: undefined,
      adapter: undefined,
    });
  });

  test("accepts full allowed body", () => {
    const b = validateRunBody({
      target: "http://x",
      model: "gpt-4o",
      chrome: "localhost:9333",
      adapter: "web",
    });
    expect(b.target).toBe("http://x");
    expect(b.model).toBe("gpt-4o");
    expect(b.chrome).toBe("localhost:9333");
    expect(b.adapter).toBe("web");
  });

  test("rejects unknown field", () => {
    expect(() => validateRunBody({ target: "http://x", screenshotQuality: 99 }))
      .toThrow(/Unknown field.*screenshotQuality/);
  });

  test("rejects missing target", () => {
    expect(() => validateRunBody({})).toThrow(/target/);
  });

  test("rejects non-string target", () => {
    expect(() => validateRunBody({ target: 123 })).toThrow(/target/);
  });

  test("rejects non-object body", () => {
    expect(() => validateRunBody(null)).toThrow(/object/);
    expect(() => validateRunBody("string")).toThrow(/object/);
  });

  test("accepts saveScreencast boolean", () => {
    const b = validateRunBody({ target: "http://x", saveScreencast: true });
    expect(b.saveScreencast).toBe(true);
    const b2 = validateRunBody({ target: "http://x", saveScreencast: false });
    expect(b2.saveScreencast).toBe(false);
  });

  test("rejects non-boolean saveScreencast", () => {
    expect(() => validateRunBody({ target: "http://x", saveScreencast: "yes" }))
      .toThrow(/saveScreencast/);
    expect(() => validateRunBody({ target: "http://x", saveScreencast: 1 }))
      .toThrow(/saveScreencast/);
  });
});

describe("mergeRunConfig", () => {
  const app = loadConfig({}, { GAUNTLET_CHROME: "server-default:9000", GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);

  test("falls through to server defaults when body has only target", () => {
    const eff = mergeRunConfig(app, { target: "http://x" });
    expect(eff.target).toBe("http://x");
    expect(eff.model).toBe("claude-sonnet-4-6");
    expect(eff.chrome).toEqual({ host: "server-default", port: 9000 });
    expect(eff.adapter).toBe("web");
  });

  test("body chrome overrides server default", () => {
    const eff = mergeRunConfig(app, { target: "http://x", chrome: "override:9333" });
    expect(eff.chrome).toEqual({ host: "override", port: 9333 });
  });

  test("body model overrides server default", () => {
    const eff = mergeRunConfig(app, { target: "http://x", model: "claude-opus-4-6" });
    expect(eff.model).toBe("claude-opus-4-6");
  });

  test("invalid chrome format in body throws", () => {
    expect(() => mergeRunConfig(app, { target: "http://x", chrome: "no-port" }))
      .toThrow(/chrome/i);
  });

  test("chrome is undefined when neither body nor server config specified (default source)", () => {
    const appDefault = loadConfig({}, {} as NodeJS.ProcessEnv);
    const eff = mergeRunConfig(appDefault, { target: "http://x" });
    expect(eff.chrome).toBeUndefined();
  });

  test("chrome uses server default when env set it explicitly", () => {
    const appEnv = loadConfig({}, { GAUNTLET_CHROME: "svc:9000" } as NodeJS.ProcessEnv);
    const eff = mergeRunConfig(appEnv, { target: "http://x" });
    expect(eff.chrome).toEqual({ host: "svc", port: 9000 });
  });

  test("chrome uses server default when flag set it explicitly", () => {
    const appFlag = loadConfig({ chrome: "flaghost:9001" }, {} as NodeJS.ProcessEnv);
    const eff = mergeRunConfig(appFlag, { target: "http://x" });
    expect(eff.chrome).toEqual({ host: "flaghost", port: 9001 });
  });

  test("saveScreencast falls through to server default (false) when body omits it", () => {
    const eff = mergeRunConfig(app, { target: "http://x" });
    expect(eff.saveScreencast).toBe(false);
  });

  test("saveScreencast server default propagates when env sets it", () => {
    const appEnv = loadConfig({}, { GAUNTLET_SAVE_SCREENCAST: "1" } as NodeJS.ProcessEnv);
    const eff = mergeRunConfig(appEnv, { target: "http://x" });
    expect(eff.saveScreencast).toBe(true);
  });

  test("body saveScreencast=true overrides server default (false)", () => {
    const eff = mergeRunConfig(app, { target: "http://x", saveScreencast: true });
    expect(eff.saveScreencast).toBe(true);
  });

  test("body saveScreencast=false overrides server default (true)", () => {
    const appEnv = loadConfig({}, { GAUNTLET_SAVE_SCREENCAST: "1" } as NodeJS.ProcessEnv);
    const eff = mergeRunConfig(appEnv, { target: "http://x", saveScreencast: false });
    expect(eff.saveScreencast).toBe(false);
  });
});

describe("requireLlmCapable", () => {
  test("throws when neither anthropic nor openai key is set", () => {
    const config = loadConfig({}, {} as NodeJS.ProcessEnv);
    expect(() => requireLlmCapable(config)).toThrow(/No LLM provider configured/);
  });

  test("passes when only anthropic key is set", () => {
    const config = loadConfig({}, { ANTHROPIC_API_KEY: "sk-ant-xxx" } as NodeJS.ProcessEnv);
    expect(() => requireLlmCapable(config)).not.toThrow();
  });

  test("passes when only openai key is set", () => {
    const config = loadConfig({}, { OPENAI_API_KEY: "sk-xxx" } as NodeJS.ProcessEnv);
    expect(() => requireLlmCapable(config)).not.toThrow();
  });

  test("passes when only a subscription OAuth token is set", () => {
    const config = loadConfig({}, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx" } as NodeJS.ProcessEnv);
    expect(() => requireLlmCapable(config)).not.toThrow();
  });

  test("passes when both keys are set", () => {
    const config = loadConfig({}, { ANTHROPIC_API_KEY: "sk-ant-xxx", OPENAI_API_KEY: "sk-xxx" } as NodeJS.ProcessEnv);
    expect(() => requireLlmCapable(config)).not.toThrow();
  });
});


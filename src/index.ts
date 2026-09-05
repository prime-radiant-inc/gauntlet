#!/usr/bin/env bun
import { parseArgs } from "./cli/args";
import { run } from "./cli/run";
import { formatCliError, isVerboseRequest } from "./cli/error-output";
import type { AppConfig, CliArgsInput } from "./config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

async function loadConfigOrThrow(cli: CliArgsInput): Promise<AppConfig> {
  const { loadConfig } = await import("./config");
  return loadConfig(cli, process.env);
}

/**
 * Sibling to loadConfigOrThrow: enforces the "at least one LLM provider
 * configured" gate at dispatch time for `serve` and `run`. Deliberately
 * NOT called from `config`, which must still work in broken environments
 * so the user can see what's missing.
 */
async function requireLlmCapableOrThrow(config: AppConfig): Promise<void> {
  const { requireLlmCapable } = await import("./config");
  requireLlmCapable(config);
}

async function main() {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "run": {
      if (args.showPromptAndExit) {
        // Introspect path: render the composed system prompt with
        // provenance and exit. loadConfigOrThrow does NOT require LLM
        // creds; only requireLlmCapableOrThrow does.
        const { showPromptAndExit } = await import("./cli/show-prompt");
        const config = await loadConfigOrThrow(args.cli);
        const viewport = args.cli.viewport ?? "1440x900";
        showPromptAndExit({
          scenarioPath: args.scenarioPath,
          target: args.cli.target ?? "",
          adapter: args.adapter,
          projectRoot: config.projectRoot,
          stateDirName: config.stateDirName,
          projectPromptPath: args.projectPromptPath,
          viewport,
        });
        break;
      }
      const config = await loadConfigOrThrow(args.cli);
      await requireLlmCapableOrThrow(config);
      await run({
        scenarioPath: args.scenarioPath,
        target: args.cli.target ?? "",
        outDir: args.outDir,
        adapterType: args.adapter,
        config,
        silent: args.silent,
        format: args.format,
        noColor: args.noColor,
        passes: args.passes,
        projectPromptPath: args.projectPromptPath,
        tuiInputGuardPath: args.tuiInputGuardPath,
      });
      break;
    }
    case "batch": {
      const config = await loadConfigOrThrow(args.cli);
      await requireLlmCapableOrThrow(config);
      const { runBatch } = await import("./cli/batch");
      const exitCode = await runBatch({
        scenarioPaths: args.scenarioPaths,
        target: args.cli.target ?? "",
        adapterType: args.adapter,
        config,
        silent: args.silent,
        format: args.format,
        noColor: args.noColor,
        sink: { write: (s: string) => process.stdout.write(s) },
        isTTY: Boolean(process.stdout.isTTY),
        passes: args.passes,
      });
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }
    case "validate": {
      const { validateScenario } = await import("./cli/validate");
      const result = validateScenario(args.scenarioPath);
      if (result.valid) {
        console.log(JSON.stringify({ valid: true }));
      } else {
        console.log(JSON.stringify({ valid: false, errors: result.errors }));
        process.exit(1);
      }
      break;
    }
    case "fanout": {
      const config = await loadConfigOrThrow(args.cli);
      await requireLlmCapableOrThrow(config);
      const { fanout } = await import("./cli/fanout");
      // Prefer an explicit fanout model, else fall back to the agent model.
      // The fanout implementation takes a ModelConfig where `agent` is the
      // model it will actually call; `fanout` is kept on the struct for
      // parity with other callers but is functionally redundant here.
      const models = {
        agent: config.models.fanout ?? config.models.agent,
        fanout: config.models.fanout,
      };
      await fanout(args.scenarioPath, args.outDir, models, args.resultDir);
      break;
    }
    case "config": {
      const { runConfigCommand } = await import("./cli/config-command");
      console.log(runConfigCommand(args, process.env));
      break;
    }
    case "ask": {
      const config = await loadConfigOrThrow(args.cli);
      await requireLlmCapableOrThrow(config);
      const { ask } = await import("./cli/ask");
      const code = await ask(args, config);
      process.exit(code);
    }
    case "render": {
      const config = await loadConfigOrThrow(args.cli);
      const { render } = await import("./cli/render");
      await render(args, config);
      break;
    }
    case "serve": {
      const { createApp } = await import("./api/server");
      const { RunBroadcaster } = await import("./api/ws");
      const { ActiveRunRegistry } = await import("./api/active-runs");
      const { RunSetBroadcaster } = await import("./api/run-set-broadcaster");
      const { CancelTokenRegistry } = await import("./api/run-cancel");
      const { handleWsOpen, handleSetWsOpen } = await import("./api/ws-handlers");
      const { ShutdownState, drainShutdown, installShutdownHandlers } = await import("./api/shutdown");
      const { decideUpgrade } = await import("./api/ws-upgrade");
      const { join } = await import("path");
      const { gauntletPath } = await import("./paths");
      const { serve } = await import("./runtime/serve");

      const config = await loadConfigOrThrow(args.cli);
      await requireLlmCapableOrThrow(config);

      const here = dirname(fileURLToPath(import.meta.url));
      const uiDir = join(here, "..", "ui", "dist");
      const gauntletRoot = gauntletPath(config.projectRoot, config.stateDirName);
      const resultsRoot = gauntletPath(config.projectRoot, config.stateDirName, "results");
      const broadcaster = new RunBroadcaster();
      const registry = new ActiveRunRegistry();
      const setBroadcaster = new RunSetBroadcaster();
      const cancelTokens = new CancelTokenRegistry();
      const shutdownState = new ShutdownState();
      const app = createApp(config, uiDir, broadcaster, registry, setBroadcaster, cancelTokens, shutdownState);
      const port = config.port;
      console.error(`gauntlet server listening on port ${port}`);
      type WsData = { runId?: string; runSetId?: string };
      const server = serve<WsData>({
        port,
        idleTimeout: 255, // seconds; LLM calls can take minutes
        wsIdleTimeoutSec: config.wsIdleTimeoutSec, // PRI-1483
        fetch: (req) => app.fetch(req),
        websocket: {
          // Validation + Origin gating live in decideUpgrade so they're
          // testable without a live server. PRI-1483.
          upgrade(url, headers) {
            return decideUpgrade(url, headers, {
              originAllowlist: config.wsOriginAllowlist,
            });
          },
          open(ws, data) {
            if (data.runSetId) {
              handleSetWsOpen(setBroadcaster, data.runSetId, ws, gauntletRoot);
            } else if (data.runId) {
              handleWsOpen(registry, broadcaster, data.runId, ws, resultsRoot);
            }
          },
          close(ws, data) {
            if (data.runSetId) {
              setBroadcaster.removeClient(data.runSetId, ws);
            } else if (data.runId) {
              broadcaster.removeClient(data.runId, ws);
            }
          },
        },
      });

      // PRI-1477: graceful shutdown on SIGTERM/SIGINT/SIGHUP. The handler
      // marks state as draining (middleware then refuses new POSTs),
      // closes existing WS connections, waits up to shutdownGraceMs for
      // in-flight runs to complete naturally, then stops the server and
      // exits 0. Runs that exceed the grace window are abandoned —
      // PRI-1507 closes that gap once the orchestrator can be cancelled.
      let shuttingDown = false;
      installShutdownHandlers(["SIGTERM", "SIGINT", "SIGHUP"], async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
          await drainShutdown({
            signal,
            state: shutdownState,
            broadcaster,
            setBroadcaster,
            registry,
            cancelTokens,
            resultsRoot,
            graceMs: config.shutdownGraceMs,
            postAbortMs: 1000,
            pollMs: 100,
            log: (msg) => process.stderr.write(`gauntlet: ${msg}\n`),
          });
        } finally {
          await server.stop();
          process.exit(0);
        }
      });
      break;
    }
  }
}

main().catch((err) => {
  const verbose = isVerboseRequest(process.env as Record<string, string | undefined>, process.argv);
  const isTty = Boolean(process.stderr.isTTY);
  process.stderr.write(formatCliError(err, { verbose, isTty }));
  process.exit(1);
});

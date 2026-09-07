import { readFileSync } from "node:fs";
import { TUIAdapter } from "../adapters/tui/adapter";
import { runConversation, type ConverseOptions } from "../conversation/converse";
import type { ConversationRecord } from "../conversation/record";
import { EvidenceLogger } from "../evidence/logger";
import { createClient, resolveProvider } from "../models/resolve";
import type { ConverseArgs } from "./args";

export function conversationExitCode(record: ConversationRecord): 0 | 1 {
  return record.status === "completed" ? 0 : 1;
}

export async function converse(args: ConverseArgs): Promise<ConversationRecord> {
  const brief = readFileSync(args.briefPath, "utf8");
  const provider = resolveProvider(args.model);
  const client = createClient(args.model);
  const logger = new EvidenceLogger(args.outDir);
  logger.logRunStart({
    runId: args.runId,
    cardId: args.cardId,
    target: undefined,
    provider,
    model: args.model,
    adapter: "tui",
    budgetMs: args.maxTimeMs,
    reflectionInterval: 0,
    toolTimeoutMs: 30_000,
    contextTreeBytes: 0,
    outDir: args.outDir,
  });
  const adapter = new TUIAdapter({
    runDir: args.outDir,
    logger,
    preparedSubject: {
      launcherPath: args.launcherPath,
      workspace: args.workspace,
      socketPath: args.tmuxSocketPath,
    },
  });
  const options: ConverseOptions = {
    brief,
    adapter,
    workspace: args.workspace,
    outDir: args.outDir,
    completionPath: args.completionPath,
    client,
    logger,
    runId: args.runId,
    maxTimeMs: args.maxTimeMs,
  };
  return runConversation(options);
}

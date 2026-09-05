import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { EvidenceLogger } from "../../evidence/logger";

export interface InputGuard {
  path: string;
  timeoutMs: number;
}

/** A trusted observer hook. No shell interpolation or subject input is sent
 * until it exits successfully. This is evidence capture, not a sandbox. */
export function runInputGuard(
  guard: InputGuard,
  request: { name: string; args: Record<string, unknown> },
  logger?: EvidenceLogger,
): void {
  if (!isAbsolute(guard.path)) throw new Error("Input guard requires an absolute executable path");
  const started = Date.now();
  const result = spawnSync(guard.path, [], {
    input: JSON.stringify(request) + "\n",
    encoding: "utf8",
    timeout: guard.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  const ok = result.status === 0 && !result.error;
  logger?.logEvent("tui_input_guard", {
    path: guard.path, tool: request.name, ok,
    elapsed_ms: Date.now() - started,
    output: result.stdout, error: result.error?.message ?? result.stderr,
  });
  if (!ok) throw new Error(`Input guard failed; input was not sent: ${result.error?.message ?? result.stderr ?? result.status}`);
}

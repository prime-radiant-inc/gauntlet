import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { writeResultFiles } from "../evidence/writer";
import type { VetResult } from "../types";
import { parseRunId } from "../util/id";
import type { AssessmentDecision } from "./lifecycle";

export type AssessmentCompletion = {
  schema_version: 1;
  run_id: string;
  status: "completed" | "timed_out" | "cancelled" | "errored";
  reason: string;
  terminal_at: string;
  accepted_report_sha256: string | null;
};

export function parseAssessmentCompletion(value: unknown): AssessmentCompletion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid assessment completion");
  }
  const record = value as Record<string, unknown>;
  const { schema_version, run_id, status, reason, terminal_at, accepted_report_sha256 } = record;
  if (schema_version !== 1 || typeof run_id !== "string" || !parseRunId(run_id) ||
      (status !== "completed" && status !== "timed_out" && status !== "cancelled" && status !== "errored") ||
      typeof reason !== "string" || reason.trim().length === 0 ||
      typeof terminal_at !== "string" || !Number.isFinite(Date.parse(terminal_at)) ||
      new Date(terminal_at).toISOString() !== terminal_at) {
    throw new Error("invalid assessment completion");
  }
  if (status === "completed"
    ? typeof accepted_report_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(accepted_report_sha256)
    : accepted_report_sha256 !== null) {
    throw new Error("invalid assessment completion digest for status");
  }
  return { schema_version, run_id, status, reason, terminal_at, accepted_report_sha256 } as AssessmentCompletion;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAtomic(path: string, text: string, noReplace = false): void {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let pendingTemporary = false;
  let linked = false;
  try {
    const fd = openSync(temporary, "wx");
    pendingTemporary = true;
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (noReplace) {
      linkSync(temporary, path);
      linked = true;
      unlinkSync(temporary);
    } else {
      renameSync(temporary, path);
    }
    pendingTemporary = false;
    syncDirectory(directory);
  } catch (error) {
    // Only remove a marker linked by this call. An existing winner is immutable.
    if (linked) {
      unlinkSync(path);
      syncDirectory(directory);
    }
    throw error;
  } finally {
    if (pendingTemporary) {
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort cleanup must not hide the publication error when storage
        // also refuses to remove the temporary file owned by this call.
      }
    }
  }
}

export function publishAssessment(input: {
  outDir: string;
  runId: string;
  result: VetResult;
  decision: AssessmentDecision;
  beforeMarker(): void;
  /** Observe publication failures converted into an errored completion. */
  onPublicationError?(error: unknown): void;
}): AssessmentCompletion {
  const { outDir, runId, result, decision } = input;
  if (!parseRunId(runId) || result.runId !== runId ||
      result.scenario !== runId.split("_")[0] || basename(outDir) !== runId) {
    throw new Error("assessment publication run identity mismatch");
  }
  if (decision.kind === "report" && result.status === "errored") {
    throw new Error("an errored result cannot complete an assessment report");
  }
  const markerPath = join(outDir, "assessment-completion.json");
  if (lstatSync(markerPath, { throwIfNoEntry: false })) {
    throw new Error("assessment completion already published");
  }
  // A report decision authorizes publication. It becomes completed only when
  // every report file and settled evidence have been successfully published.
  const terminal = parseAssessmentCompletion({
    schema_version: 1,
    run_id: runId,
    status: decision.kind === "report" ? "errored" : decision.kind,
    reason: decision.reason,
    terminal_at: new Date(decision.atMs).toISOString(),
    accepted_report_sha256: null,
  });
  function errored(error: unknown): AssessmentCompletion {
    input.onPublicationError?.(error);
    return {
      ...terminal,
      status: "errored",
      reason: `Assessment publication failed: ${error instanceof Error ? error.message : String(error)}`,
      accepted_report_sha256: null,
    };
  }
  let completion = terminal;
  try {
    writeResultFiles(outDir, result, writeAtomic);
    if (decision.kind === "report") {
      completion = {
        ...terminal,
        status: "completed",
        accepted_report_sha256: createHash("sha256")
          .update(readFileSync(join(outDir, "result.json"))).digest("hex"),
      };
    }
  } catch (error) {
    completion = errored(error);
  }
  // Attempt to retain settled usage/events even when report publication failed.
  try {
    input.beforeMarker();
  } catch (error) {
    completion = errored(error);
  }
  try {
    writeAtomic(markerPath, JSON.stringify(completion, null, 2) + "\n", true);
    return completion;
  } catch (error) {
    if (completion.status === "errored") throw error;
    const failure = errored(error);
    writeAtomic(markerPath, JSON.stringify(failure, null, 2) + "\n", true);
    return failure;
  }
}

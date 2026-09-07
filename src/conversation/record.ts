import { isAbsolute, normalize } from "node:path";

export type ConversationRecord = {
  status: "completed" | "stopped" | "timed_out" | "errored";
  endpoint: "delivery" | "refusal" | null;
  reason: string;
  timestamp: string;
  evidence: { path: string; quote: string } | null;
};

const STATUSES = new Set<ConversationRecord["status"]>([
  "completed", "stopped", "timed_out", "errored",
]);
const ENDPOINTS = new Set<NonNullable<ConversationRecord["endpoint"]>>([
  "delivery", "refusal",
]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvidence(value: unknown): ConversationRecord["evidence"] {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.quote !== "string") {
    throw new Error("Conversation record evidence must contain string path and quote fields");
  }
  if (value.path.trim() === "" || isAbsolute(value.path)) {
    throw new Error("Conversation record evidence path must be a nonempty relative path");
  }
  const normalized = normalize(value.path);
  if (normalized === ".." || normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Conversation record evidence path must not traverse outside the run");
  }
  if (value.quote.trim() === "") {
    throw new Error("Conversation record evidence quote must be nonempty");
  }
  return { path: value.path, quote: value.quote };
}

export function validateConversationRecord(value: unknown): ConversationRecord {
  if (!isRecord(value)) throw new Error("Conversation record must be an object");
  if (typeof value.status !== "string" || !STATUSES.has(value.status as ConversationRecord["status"])) {
    throw new Error("Conversation record has an invalid status");
  }
  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    throw new Error("Conversation record reason must be nonempty");
  }
  if (
    typeof value.timestamp !== "string" ||
    !ISO_TIMESTAMP.test(value.timestamp) ||
    !Number.isFinite(Date.parse(value.timestamp))
  ) {
    throw new Error("Conversation record timestamp must be an ISO timestamp");
  }

  const status = value.status as ConversationRecord["status"];
  const evidence = parseEvidence(value.evidence);
  if (status === "completed") {
    if (typeof value.endpoint !== "string" || !ENDPOINTS.has(value.endpoint as "delivery" | "refusal")) {
      throw new Error("Completed conversation record requires a delivery or refusal endpoint");
    }
    if (evidence === null) {
      throw new Error("Completed conversation record requires captured evidence");
    }
    return {
      status,
      endpoint: value.endpoint as "delivery" | "refusal",
      reason: value.reason,
      timestamp: value.timestamp,
      evidence,
    };
  }

  if (value.endpoint !== null) {
    throw new Error("Incomplete conversation record endpoint must be null");
  }
  return { status, endpoint: null, reason: value.reason, timestamp: value.timestamp, evidence };
}

# Assessment Report Criteria Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept an assessment report whose criteria array arrives as XML function-call markup inside `reasoning`, validate it as native rows, and mark the repair so it is countable downstream.

**Architecture:** One pure recovery function in `src/assessment/report.ts` extracts the array and cleans the reasoning; `parseAssessmentReport` calls it only when the native `criteria` argument is absent and then runs the unchanged row, count, and read-before-cite checks. The loop in `src/assessment/assess.ts` logs an event and uses a distinct decision reason when a report was repaired. Nothing else changes.

**Tech Stack:** TypeScript on Bun; `bun test`; `tsc --noEmit` runs as the pre-commit hook.

**Spec:** `docs/superpowers/specs/2026-09-10-assessment-report-criteria-repair-design.md`

## Global Constraints

- Recover only when `value.criteria` is `undefined`; a native value of any type wins and is validated exactly as today.
- Recognized wrappers: `<criteria>` and `<parameter name="criteria">`, whitespace tolerated inside the tag; the block ends at the first `</criteria>` or `</parameter>` after the open tag, or at the end of the string.
- Recovered rows pass through the same row, count, and exposed-path checks as native rows; no new leniency.
- Cleaned reasoning has the block and any stray `<invoke …>`, `</invoke>`, `<parameter …>`, `</parameter>`, `<reasoning>`, `</reasoning>` tags removed and is trimmed. Empty cleaned reasoning rejects with `reasoning: empty after recovering criteria; provide a concise synthesis`.
- Repair marker on the parsed report: `repair: { source: "reasoning-markup", wrapper: "<criteria>" | "<parameter name=\"criteria\">" }`; absent on native parses.
- Loop: event `assessment_report_repaired` with `turn`, `wrapper`, `criteria` (row count); decision reason `criteria recovered from reasoning markup` instead of `valid native report`.
- No change to the tool schema, rejection text, prompts, deadline, or `result.json` shape.
- The 23 retained rejected submissions live under `~/.local/share/superpowers-evals/smoke-688fccf6/` and are private; verify against them with an uncommitted script only.

---

## File Structure

- Modify `src/assessment/report.ts` — add `ReportRepair`, `recoverCriteriaFromReasoning`, the `repair` field on `AssessmentReport`, and the repair step inside `parseAssessmentReport`. One file owns the report contract and its parsing, as today.
- Modify `src/assessment/assess.ts:227-238` (`validateReport` return type) and `:341-347` (the accept site) — event and reason only.
- Test `test/assessment/report.test.ts` — new `describe("recoverCriteriaFromReasoning")` and five new cases inside `describe("parseAssessmentReport")`.
- Test `test/assessment/assess.test.ts` — one new case inside `describe("runAssessment")`.
- Uncommitted `/tmp/criteria-repair-verify.ts` — offline check against the retained submissions.
- Evals repo `docs/experiments/2026-09-10-conversation-code-review-smoke.md` — one follow-up paragraph with the offline count.

---

### Task 1: Recovery function

**Files:**
- Modify: `src/assessment/report.ts` (add after the `AssessmentCriterionSubmission` type, before `ASSESSMENT_REPORT_TOOL`)
- Test: `test/assessment/report.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type ReportRepair = { source: "reasoning-markup"; wrapper: "<criteria>" | '<parameter name="criteria">' }` and `export function recoverCriteriaFromReasoning(reasoning: string): { rows: unknown[]; wrapper: ReportRepair["wrapper"]; reasoning: string } | undefined`. Task 2 calls it; Task 3 reads `wrapper`.

- [ ] **Step 1: Write the failing tests**

Add to `test/assessment/report.test.ts`, after the existing imports, and extend the import line to include `recoverCriteriaFromReasoning`:

```ts
import {
  ASSESSMENT_REPORT_TOOL,
  deriveAssessmentStatus,
  parseAssessmentReport,
  recoverCriteriaFromReasoning,
} from "../../src/assessment/report";
```

Append at the end of the file:

```ts
describe("recoverCriteriaFromReasoning", () => {
  const rows = submission(["pass", "fail"]).criteria;
  const rowsJson = JSON.stringify(rows);

  test("recovers a <criteria> block after a stray closing reasoning tag", () => {
    const recovered = recoverCriteriaFromReasoning(
      `Synthesis text.</reasoning> <criteria>${rowsJson}</criteria>`,
    );
    expect(recovered).toEqual({ rows, wrapper: "<criteria>", reasoning: "Synthesis text." });
  });

  test('recovers a <parameter name="criteria"> block followed by </invoke>', () => {
    const recovered = recoverCriteriaFromReasoning(
      `Synthesis text.</parameter> <parameter name="criteria">${rowsJson}</parameter> </invoke>`,
    );
    expect(recovered).toEqual({
      rows,
      wrapper: '<parameter name="criteria">',
      reasoning: "Synthesis text.",
    });
  });

  test("recovers an unclosed <criteria> block that runs to the end of the string", () => {
    const recovered = recoverCriteriaFromReasoning(
      `Synthesis text.</reasoning> <criteria>${rowsJson}`,
    );
    expect(recovered).toEqual({ rows, wrapper: "<criteria>", reasoning: "Synthesis text." });
  });

  test("returns undefined without a criteria tag or when the block is not a JSON array", () => {
    expect(recoverCriteriaFromReasoning("Plain synthesis with no block.")).toBeUndefined();
    expect(recoverCriteriaFromReasoning("<criteria>not json</criteria>")).toBeUndefined();
    expect(recoverCriteriaFromReasoning('<criteria>{"verdict":"pass"}</criteria>')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/assessment/report.test.ts`
Expected: FAIL with `Export named 'recoverCriteriaFromReasoning' not found`.

- [ ] **Step 3: Implement the recovery function**

In `src/assessment/report.ts`, after the `AssessmentCriterionSubmission` type and before `ASSESSMENT_REPORT_TOOL`:

```ts
/** A report whose criteria arrived as markup inside reasoning, not as the native argument. */
export type ReportRepair = {
  source: "reasoning-markup";
  wrapper: "<criteria>" | '<parameter name="criteria">';
};

const CRITERIA_OPEN_TAG = /<parameter\s+name="criteria"\s*>|<criteria\s*>/;
const CRITERIA_CLOSE_TAGS = ["</parameter>", "</criteria>"] as const;
const STRAY_CALL_TAGS = /<\/?(?:invoke|parameter|reasoning)\b[^>]*>/g;

/**
 * Some models write the criteria array as XML function-call markup inside the
 * reasoning string and omit the native argument. The rows inside are usually
 * well-formed JSON. Lift them out and hand back the reasoning without the block
 * and without stray call tags; the caller validates the rows as native rows.
 */
export function recoverCriteriaFromReasoning(
  reasoning: string,
): { rows: unknown[]; wrapper: ReportRepair["wrapper"]; reasoning: string } | undefined {
  const open = CRITERIA_OPEN_TAG.exec(reasoning);
  if (open === null) return undefined;
  const bodyStart = open.index + open[0].length;
  let bodyEnd = reasoning.length;
  let blockEnd = reasoning.length;
  for (const close of CRITERIA_CLOSE_TAGS) {
    const at = reasoning.indexOf(close, bodyStart);
    if (at !== -1 && at < bodyEnd) {
      bodyEnd = at;
      blockEnd = at + close.length;
    }
  }
  let rows: unknown;
  try {
    rows = JSON.parse(reasoning.slice(bodyStart, bodyEnd).trim());
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  const wrapper: ReportRepair["wrapper"] = open[0].startsWith("<parameter")
    ? '<parameter name="criteria">'
    : "<criteria>";
  const cleaned = (reasoning.slice(0, open.index) + reasoning.slice(blockEnd))
    .replace(STRAY_CALL_TAGS, "")
    .trim();
  return { rows, wrapper, reasoning: cleaned };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/assessment/report.test.ts`
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Commit**

```bash
git add src/assessment/report.ts test/assessment/report.test.ts
git commit -m "Recover a criteria array from reasoning markup"
```

---

### Task 2: Repair step in the parser

**Files:**
- Modify: `src/assessment/report.ts` (`AssessmentReport` interface; `parseAssessmentReport` body)
- Test: `test/assessment/report.test.ts`

**Interfaces:**
- Consumes: `recoverCriteriaFromReasoning`, `ReportRepair` from Task 1.
- Produces: `AssessmentReport.repair?: ReportRepair`. A successful parse of a repaired report carries `repair`; a native parse does not. Task 3 reads it.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("parseAssessmentReport", …)` in `test/assessment/report.test.ts`, after the `"allows repeated valid rows"` case:

```ts
  test("recovers criteria from reasoning markup when the native argument is absent", () => {
    const native = submission();
    const { criteria, ...withoutCriteria } = native;
    const parsed = parseAssessmentReport(
      {
        ...withoutCriteria,
        reasoning: `${native.reasoning}</reasoning> <criteria>${JSON.stringify(criteria)}</criteria>`,
      },
      acceptanceCriteria,
      exposedEvidencePaths,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.repair).toEqual({ source: "reasoning-markup", wrapper: "<criteria>" });
    expect(parsed.value.reasoning).toBe(native.reasoning);
    expect(parsed.value.status).toBe("fail");
    expect(parsed.value.criteria.map((row) => row.verdict)).toEqual(["pass", "fail"]);
    expect(parsed.value.criteria[0].criterion).toBe(acceptanceCriteria[0]);
  });

  test("a native criteria array wins over markup in reasoning", () => {
    const native = submission();
    const reasoning = `${native.reasoning} <criteria>[]</criteria>`;
    const parsed = parseAssessmentReport(
      { ...native, reasoning },
      acceptanceCriteria,
      exposedEvidencePaths,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.repair).toBeUndefined();
    expect(parsed.value.reasoning).toBe(reasoning);
    expect(parsed.value.criteria).toHaveLength(2);
  });

  test("recovered rows face the same count and reference checks as native rows", () => {
    const { criteria: oneRow, ...oneRest } = submission(["pass"]);
    expect(parseAssessmentReport(
      { ...oneRest, reasoning: `${oneRest.reasoning} <criteria>${JSON.stringify(oneRow)}</criteria>` },
      acceptanceCriteria,
      exposedEvidencePaths,
    )).toEqual({
      ok: false,
      reason: "criteria: expected 2 entries (one per acceptance criterion, in order), got 1",
    });

    const unread = submission();
    unread.criteria[0].references = ["visible/never-read.txt"];
    const { criteria: unreadRows, ...unreadRest } = unread;
    expect(parseAssessmentReport(
      { ...unreadRest, reasoning: `${unreadRest.reasoning} <criteria>${JSON.stringify(unreadRows)}</criteria>` },
      acceptanceCriteria,
      exposedEvidencePaths,
    )).toEqual({
      ok: false,
      reason: "criteria[0].references[0]: evidence path has not been read: visible/never-read.txt",
    });
  });

  test("markup that is not a JSON array falls through to the original rejection", () => {
    const { criteria: _rows, ...rest } = submission();
    expect(parseAssessmentReport(
      { ...rest, reasoning: `${rest.reasoning} <criteria>not json</criteria>` },
      acceptanceCriteria,
      exposedEvidencePaths,
    )).toEqual({ ok: false, reason: "criteria: expected array, got undefined" });
  });

  test("a recovered block that leaves reasoning empty is rejected", () => {
    const { criteria, ...rest } = submission();
    expect(parseAssessmentReport(
      { ...rest, reasoning: `<criteria>${JSON.stringify(criteria)}</criteria>` },
      acceptanceCriteria,
      exposedEvidencePaths,
    )).toEqual({
      ok: false,
      reason: "reasoning: empty after recovering criteria; provide a concise synthesis",
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/assessment/report.test.ts`
Expected: the first new case fails on `parsed.ok` being `false` with reason `criteria: expected array, got undefined`; the native-wins case passes already; the count/reference case fails on the reason text; the empty-reasoning case fails with the `expected array` reason instead of the new one. (Four failures, one pass, among the five new cases.)

- [ ] **Step 3: Implement the repair step**

In `src/assessment/report.ts`:

Add the field to the interface:

```ts
export interface AssessmentReport {
  status: Exclude<VetStatus, "errored">;
  summary: string;
  reasoning: string;
  observations: Observation[];
  criteria: CriterionVerdict[];
  repair?: ReportRepair;
}
```

Replace the body of `parseAssessmentReport` from the `acceptanceCriteria.length === 0` check through the end of the function with:

```ts
  if (acceptanceCriteria.length === 0) {
    return { ok: false, reason: "criteria: assessment requires at least one acceptance criterion" };
  }

  let criteriaValue: unknown = value.criteria;
  let reasoningValue: unknown = value.reasoning;
  let repair: ReportRepair | undefined;
  if (criteriaValue === undefined && typeof reasoningValue === "string") {
    const recovered = recoverCriteriaFromReasoning(reasoningValue);
    if (recovered !== undefined) {
      if (recovered.reasoning === "") {
        return {
          ok: false,
          reason: "reasoning: empty after recovering criteria; provide a concise synthesis",
        };
      }
      criteriaValue = recovered.rows;
      reasoningValue = recovered.reasoning;
      repair = { source: "reasoning-markup", wrapper: recovered.wrapper };
    }
  }

  if (!Array.isArray(criteriaValue)) {
    return { ok: false, reason: `criteria: expected array, got ${typeName(criteriaValue)}` };
  }
  if (criteriaValue.length !== acceptanceCriteria.length) {
    return {
      ok: false,
      reason:
        `criteria: expected ${acceptanceCriteria.length} entries (one per ` +
        `acceptance criterion, in order), got ${criteriaValue.length}`,
    };
  }

  const criteria: CriterionVerdict[] = [];
  for (let i = 0; i < criteriaValue.length; i++) {
    const row = criteriaValue[i];
    if (!isRecord(row)) {
      return { ok: false, reason: `criteria[${i}]: expected object, got ${typeName(row)}` };
    }
    if (Object.hasOwn(row, "criterion")) {
      return {
        ok: false,
        reason: `criteria[${i}].criterion: must not be supplied; canonical text is attached by position`,
      };
    }
    if (
      typeof row.verdict !== "string" ||
      !CRITERION_VERDICTS.includes(row.verdict as CriterionVerdict["verdict"])
    ) {
      return {
        ok: false,
        reason:
          `criteria[${i}].verdict: "${String(row.verdict)}" not in ` +
          `[${CRITERION_VERDICTS.join(", ")}]`,
      };
    }
    for (const field of ["observation", "basis", "limitations"] as const) {
      if (typeof row[field] !== "string" || row[field].trim() === "") {
        return {
          ok: false,
          reason: `criteria[${i}].${field}: must be a non-empty string`,
        };
      }
    }
    if (!Array.isArray(row.references) || row.references.length === 0) {
      return {
        ok: false,
        reason: `criteria[${i}].references: must be a non-empty array`,
      };
    }
    for (let referenceIndex = 0; referenceIndex < row.references.length; referenceIndex++) {
      const reference = row.references[referenceIndex];
      if (typeof reference !== "string" || reference.trim() === "") {
        return {
          ok: false,
          reason:
            `criteria[${i}].references[${referenceIndex}]: must be a non-empty string`,
        };
      }
      if (!exposedEvidencePaths.has(reference)) {
        return {
          ok: false,
          reason:
            `criteria[${i}].references[${referenceIndex}]: evidence path has not been read: ${reference}`,
        };
      }
    }
    const submission = row as unknown as AssessmentCriterionSubmission;
    const evidence = [
      `Observation: ${submission.observation}`,
      `Basis: ${submission.basis}`,
      `Limitations: ${submission.limitations}`,
      `Sources: ${submission.references.join(", ")}`,
    ].join("\n");
    criteria.push({
      criterion: acceptanceCriteria[i],
      verdict: row.verdict as CriterionVerdict["verdict"],
      evidence,
    });
  }

  const core = parseReportResult({
    ...value,
    reasoning: reasoningValue,
    status: deriveAssessmentStatus(criteria),
    criteria,
  });
  if (!core.ok) return core;
  return { ok: true, value: { ...core.value, criteria, ...(repair === undefined ? {} : { repair }) } };
}
```

The row loop is the existing loop with `value.criteria` renamed to `criteriaValue`; nothing inside it changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/assessment/report.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add src/assessment/report.ts test/assessment/report.test.ts
git commit -m "Repair an assessment report whose criteria arrived as reasoning markup"
```

---

### Task 3: Event and decision reason in the assessment loop

**Files:**
- Modify: `src/assessment/assess.ts:227-238` and `src/assessment/assess.ts:341-347`
- Test: `test/assessment/assess.test.ts`

**Interfaces:**
- Consumes: `AssessmentReport` (with `repair`) from `./report`.
- Produces: event `{ type: "event", name: "assessment_report_repaired", turn, wrapper, criteria }` in `run.jsonl`; completion reason `criteria recovered from reasoning markup`.

- [ ] **Step 1: Write the failing test**

Add inside `describe("runAssessment", …)` in `test/assessment/assess.test.ts`, after the `"accepts a repaired structured report after returning its typed rejection"` case:

```ts
  test("accepts criteria recovered from reasoning markup and marks the repair", async () => {
    const native = report("pass");
    const { criteria, ...rest } = native.toolCalls[0].arguments as Record<string, unknown> & {
      criteria: unknown[];
    };
    const markup = response([{
      id: "report-markup",
      name: "report_result",
      arguments: {
        ...rest,
        reasoning: `pass reasoning from retained evidence</reasoning> <criteria>${JSON.stringify(criteria)}</criteria>`,
      },
    }]);
    const client = new ScriptedClient([readVisible(), markup]);
    const fx = fixture(client);
    try {
      const result = await fx.run();
      expect(result.status).toBe("pass");
      expect(result.reasoning).toBe("pass reasoning from retained evidence");
      expect(result.criteria).toHaveLength(1);
      expect(result.usage?.turns).toBe(2);
      const events = readFileSync(join(fx.outDir, "run.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        events.filter((event) => event.type === "event" && event.name === "assessment_report_repaired"),
      ).toEqual([expect.objectContaining({ turn: 2, wrapper: "<criteria>", criteria: 1 })]);
      expect(JSON.parse(readFileSync(join(fx.outDir, "assessment-completion.json"), "utf8")))
        .toMatchObject({ status: "completed", reason: "criteria recovered from reasoning markup" });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/assessment/assess.test.ts -t "recovered from reasoning markup"`
Expected: FAIL. The report is accepted (Task 2), but the event filter returns `[]` and the completion reason is `valid native report`.

- [ ] **Step 3: Wire the event and the reason**

In `src/assessment/assess.ts`, extend the import from `./report` to include the type:

```ts
import {
  ASSESSMENT_REPORT_TOOL,
  type AssessmentReport,
  formatAssessmentReportRejection,
  parseAssessmentReport,
} from "./report";
```

That block replaces the existing three-name import at lines 26-30 exactly; only `type AssessmentReport` is new.

Change the `validateReport` signature at line 227 so the accepted value keeps its `repair` field:

```ts
  function validateReport(call: ToolCall):
    | { ok: true; value: AssessmentReport }
    | { ok: false; result: ToolResult } {
```

Replace the accept site at lines 341-347:

```ts
          if (call.name === "report_result") {
            const report = validateReport(call);
            if (report.ok) {
              const repair = report.value.repair;
              if (repair !== undefined) {
                logger.logEvent("assessment_report_repaired", {
                  turn: turns,
                  wrapper: repair.wrapper,
                  criteria: report.value.criteria.length,
                });
              }
              const reason = repair === undefined
                ? "valid native report"
                : "criteria recovered from reasoning markup";
              if (state.decide("report", reason)) accepted = report.value;
              else controller.abort("assessment work deadline elapsed");
              break work;
            }
            result = report.result;
            error = true;
          } else {
```

`accepted` is typed `Parameters<typeof buildResult>[0] | undefined`; an `AssessmentReport` assigns to it structurally, and `buildResult` copies only the fields it names, so `result.json` keeps its shape.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/assessment/assess.test.ts`
Expected: PASS, including the existing `"accepts a repaired structured report"` and `"actual Anthropic SDK preserves repeated malformed reports"` cases (the latter skips without provider credentials, as before).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add src/assessment/assess.ts test/assessment/assess.test.ts
git commit -m "Mark repaired assessment reports in the event stream and completion reason"
```

---

### Task 4: Offline verification against the retained submissions

**Files:**
- Create (uncommitted, outside the repo): `/tmp/criteria-repair-verify.ts`
- Modify (evals repo): `docs/experiments/2026-09-10-conversation-code-review-smoke.md`

**Interfaces:**
- Consumes: `parseAssessmentReport` from Task 2, the twelve `run.jsonl` event streams under `~/.local/share/superpowers-evals/smoke-688fccf6/*/gauntlet-agent/results/*/`.
- Produces: a count of how many of the 23 rejected submissions the parser now accepts, recorded in the evals experiment entry.

- [ ] **Step 1: Write the verification script**

```ts
// /tmp/criteria-repair-verify.ts — private check; do not commit.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAssessmentReport } from "/Users/drewritter/prime-rad/gauntlet/src/assessment/report";

const MIRROR = `${process.env.HOME}/.local/share/superpowers-evals/smoke-688fccf6`;
const criteria = Array.from({ length: 6 }, (_, i) => `criterion ${i + 1}`);
let rejectedSeen = 0;
let nowAccepted = 0;
const reasons: Record<string, number> = {};

for (const run of readdirSync(MIRROR)) {
  const resultsDir = join(MIRROR, run, "gauntlet-agent", "results");
  if (!existsSync(resultsDir)) continue;
  for (const out of readdirSync(resultsDir)) {
    const events = readFileSync(join(resultsDir, out, "run.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const exposed = new Set<string>();
    const pending: string[] = [];
    const readPaths = new Map<string, string>();
    for (const event of events) {
      if (event.type === "llm_response") {
        for (const path of pending) exposed.add(path);
        pending.length = 0;
        for (const call of event.toolCalls ?? []) {
          if (call.name !== "report_result" || Array.isArray(call.arguments?.criteria)) continue;
          rejectedSeen++;
          const parsed = parseAssessmentReport(call.arguments, criteria, exposed);
          if (parsed.ok) nowAccepted++;
          else reasons[parsed.reason] = (reasons[parsed.reason] ?? 0) + 1;
        }
      } else if (event.type === "tool_call" && event.name === "read_evidence") {
        readPaths.set(event.toolUseId, event.arguments?.path);
      } else if (event.type === "tool_result" && !event.error && readPaths.has(event.toolUseId)) {
        pending.push(readPaths.get(event.toolUseId)!);
      }
    }
  }
}
console.log(JSON.stringify({ rejectedSeen, nowAccepted, reasons }, null, 2));
```

The exposure rule mirrors the loop: a path read in an earlier response is exposed; a read in the reporting response is not yet available to that report.

- [ ] **Step 2: Run it from the gauntlet root**

Run: `cd /Users/drewritter/prime-rad/gauntlet && bun /tmp/criteria-repair-verify.ts`
Expected: `rejectedSeen: 23`, `nowAccepted: 22`, `reasons` containing only `"criteria: expected array, got undefined": 1` (the summary-only submission). If `nowAccepted` is lower, the `reasons` map names why (for example a cited path never read); report the actual numbers, do not adjust the parser to chase them without a spec change.

- [ ] **Step 3: Record the count in the evals experiment entry**

In the evals repo on a new branch from `main`, append to `docs/experiments/2026-09-10-conversation-code-review-smoke.md` under `## Next`:

```markdown
### Follow-up: offline repair check

Gauntlet's criteria repair (`docs/superpowers/specs/2026-09-10-assessment-report-criteria-repair-design.md`
in the gauntlet repo) was run against this campaign's 23 rejected submissions
with each submission's exposed evidence paths reconstructed from its event
stream: <N> of 23 now parse as valid reports; <M> remain rejected
(<reasons>). The submissions stay private; the check is reproducible from the
retained run streams.
```

Replace `<N>`, `<M>`, and `<reasons>` with the numbers Step 2 printed. Commit with the message `Record the offline criteria-repair check for the code-review smoke` and open a PR against `main`.

---

### Task 5: Full check, pull request, merge

**Files:**
- No new files.

- [ ] **Step 1: Run the full check**

Run: `cd /Users/drewritter/prime-rad/gauntlet && bun run check`
Expected: typecheck, UI typecheck, UI build, and the test suite all pass (the provider-gated assessment case skips without credentials, as on main).

- [ ] **Step 2: Push and open the pull request**

```bash
git push -u origin spec/assessment-report-criteria-repair
gh pr create --repo prime-radiant-inc/gauntlet --base main --title "Recover assessment criteria from reasoning markup" --body-file - <<'BODY'
Sonnet 5 on Bedrock often writes the assessment criteria array as XML function-call markup inside `reasoning` and omits the native argument; Gauntlet rejected it and the model repeated the shape until Quorum's 120 s deadline. In the 2026-09-10 smoke campaign, 22 of 23 rejected submissions carried a well-formed array in one of three wrappers.

`parseAssessmentReport` now recovers the array only when `criteria` is absent, validates the rows exactly as native rows, cleans the markup out of `reasoning`, and carries a `repair` marker. The loop logs `assessment_report_repaired` and decides with reason `criteria recovered from reasoning markup`, which reaches Quorum's completion record unchanged. Schema, prompts, rejection text, and deadline are untouched.

Spec: `docs/superpowers/specs/2026-09-10-assessment-report-criteria-repair-design.md`. Offline check against the retained submissions: <N> of 23 accepted (recorded in the evals experiment entry).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
```

Replace `<N>` with the Task 4 result.

- [ ] **Step 3: Merge after CI**

Run: `gh pr checks <number> --repo prime-radiant-inc/gauntlet --watch --fail-fast` then `gh pr merge <number> --repo prime-radiant-inc/gauntlet --rebase --delete-branch` (add `--admin` only if the ruleset's review requirement blocks the author, as it did on PR #18).
Expected: merged onto gauntlet `main` as three commits.

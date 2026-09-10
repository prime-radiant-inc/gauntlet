# Assessment report criteria repair

**Status:** Draft for review. **Date:** 2026-09-10.
**Evidence:** superpowers-evals `docs/experiments/2026-09-10-conversation-code-review-smoke.md`, campaign `688fccf6`.

## Problem

The assessment role asks the model to call `report_result` with `summary`,
`reasoning`, and a native `criteria` array. Sonnet 5 on Bedrock often writes the
criteria array as XML function-call markup inside the `reasoning` string and
omits the native argument. Gauntlet rejects the call, explains the required
shape, and the model resubmits the same shape three or four times. Each attempt
costs 20 to 45 seconds of generation. Within Quorum's 120-second work deadline,
that loses the assessment.

In the smoke campaign of 2026-09-10, 12 assessments made 31 submissions. Six
were valid on the first submission, two after three or four rejections, and
four never, so four attempts composed `indeterminate`. Of the 23 rejected
submissions, 22 carried a JSON array of exactly six well-formed rows inside one
of three wrappers:

| Wrapper | Count |
|---|---:|
| `<criteria>` … `</criteria>` | 10 |
| `<criteria>` … end of string, never closed | 4 |
| `<parameter name="criteria">` … `</parameter>`, sometimes followed by `</invoke>` | 8 |

A stray `</reasoning>` or `</parameter>` preceded the block. Every row had the
five required fields. The remaining submission carried only `summary` and is
not recoverable. No submission was truncated: every report turn stopped on
`tool_use` at under 4,900 output tokens. Accepted submissions had short
reasoning, under 1,600 characters; rejected ones had 4,300 to 7,500.

The judgments themselves are sound. An independent read of all 48 accepted
criterion verdicts against the planted fixture found no disagreement. The
failure is the envelope, not the assessment.

## Decision

Recover the criteria array from the reasoning markup when, and only when, the
native `criteria` argument is absent. Validate the recovered rows exactly as
native rows. Record that the repair happened in the event stream and in the
completion reason, so every repaired assessment is countable downstream.

The native path stays primary. The schema, the rejection text, the prompts, and
the deadline do not change. This is the smallest change that turns the observed
failure into an accepted report with a visible marker.

## Design

### Parser: `src/assessment/report.ts`

`parseAssessmentReport` gains one step before the array check. When
`value.criteria` is `undefined` and `value.reasoning` is a string:

1. Find the first `<criteria>` or `<parameter name="criteria">` tag. Whitespace
   inside the tag is tolerated.
2. Take the text after the tag up to the matching `</criteria>` or
   `</parameter>`, or to the end of the string when no close tag follows.
3. Trim it and parse it as JSON. Require an array.
4. On success, continue with the recovered array in place of `value.criteria`.
   The row checks, the count check, and the read-before-cite check run
   unchanged.
5. Clean `reasoning`: remove the recovered block and its tags, then strip stray
   `<invoke …>`, `</invoke>`, `<parameter name="reasoning">`, `</parameter>`,
   and `</reasoning>` tags, and trim. If the cleaned text is empty, reject with
   a new reason, `reasoning: empty after recovering criteria; provide a concise
   synthesis`, so the model resubmits. The generic validator only requires
   `reasoning` to be a string; this rule applies to the repaired path only.

When the tag is missing or the inner text is not a JSON array, the existing
rejection fires with its existing reason. When `value.criteria` is present in
any form, nothing here runs; a native value wins even if markup also appears
in reasoning.

The successful parse result carries
`repair: { source: "reasoning-markup", wrapper: "<criteria>" | "<parameter name=\"criteria\">" }`.
A native parse carries no `repair` field.

### Loop: `src/assessment/assess.ts`

On an accepted report with `repair` set:

- Log `assessment_report_repaired` with `turn`, `wrapper`, and `criteria`
  (row count) through the evidence logger.
- Decide with reason `criteria recovered from reasoning markup` instead of
  `valid native report`. That reason already reaches
  `assessment-completion.json` in Quorum, so the count of repaired assessments
  needs no schema change on either side.

`result.json` keeps its shape. `criteria` holds the recovered rows and
`reasoning` holds the cleaned synthesis.

### Out of scope

- Changing the tool schema, property order, or reasoning length limits.
- Changing the rejection feedback or the system prompt.
- Changing the 120-second work deadline, which Quorum owns.
- Recovering a submission with no criteria block at all.
- A/B of the grader route (direct versus Bedrock). If the repair does not
  reach first-submission acceptance above 90 percent on the retained
  submissions, that comparison is the next experiment, not part of this change.

## Verification

Tests first, in `test/assessment/report.test.ts`:

1. `</reasoning> <criteria>[…]</criteria>` with the right row count: accepted,
   rows attached by position, reasoning cleaned, `repair.wrapper` set.
2. `<parameter name="criteria">[…]</parameter> </invoke>`: accepted, same.
3. `<criteria>[…` unclosed to end of string: accepted.
4. Wrapper whose inner text is not a JSON array: the original rejection
   `criteria: expected array, got undefined`.
5. Native `criteria` present alongside markup in reasoning: native rows used,
   no `repair`, reasoning untouched.
6. Wrapper with the wrong row count: the existing count rejection.
7. Recovered block that leaves reasoning empty after cleaning: rejected with
   the new reason.

In the assessment loop tests, one scripted case asserts the
`assessment_report_repaired` event and the completion reason.

Then, outside the repository, run the 23 retained rejected submissions from
campaign `688fccf6` through the real parser with each submission's exposed
evidence paths reconstructed from its event stream. Expected: 22 accepted, 1
rejected. Record the count in the evals experiment entry. These submissions are
private and are not committed as fixtures.

## Rollout

Land on gauntlet main. On the appliance, `prepare` rebuilds gauntlet main.
Re-register and run the same twelve-attempt smoke suite, about $8, and read the
first-submission acceptance and the repaired count from the completion reasons.
That live run is a separate decision.

## Risks

- **Accepting a report the model did not intend.** The recovered rows are the
  model's own judgments, in the model's own words, validated by the same rules
  as native rows. The marker keeps the two populations separable.
- **Masking the underlying behavior.** The event and reason make the repair
  rate a first-class number. If it stays high, the prompt or route is the next
  target, with data.
- **Wrapper drift.** A new wrapper shape falls through to the existing
  rejection, which is today's behavior, not a regression.

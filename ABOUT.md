# gauntlet

> AI-powered QA testing framework that drives web/CLI/TUI targets from markdown story cards and returns pass/fail verdicts with evidence.

**Family:** eval-labs · **Type:** tool · **Lifecycle:** production · **Owner:** mhat

## What it does
Gauntlet uses LLMs (Claude or GPT) to test software like a human tester: web apps via Chrome DevTools Protocol, CLI tools via stdin/stdout, and TUI programs in a tmux session. You write markdown story cards with acceptance criteria, and an agentic loop works through them via one of three adapters, returning a structured verdict (pass/fail/investigate) with screenshots, observations, and an action log. It can also generate story variations (fanout).

## How it fits
- Depends on: [obol](https://github.com/prime-radiant-inc/obol) — data contract: each LLM call appends an obol cost-sidecar row (`usage.jsonl`, type `obol.usage`) that obol normalizes at read time (`src/evidence/logger.ts`, `src/agent/agent.ts`; PRI-2125). No package or service dependency otherwise.
- Used by: obol (reads the usage.jsonl cost sidecar gauntlet emits)
- External: Anthropic SDK (Claude, API key or Claude subscription OAuth), OpenAI SDK; Chrome via CDP; tmux

## Runtime & data
- Runs: Bun/TypeScript CLI plus a Hono HTTP API + React UI; Docker image available
- Data in: Story cards (markdown with YAML frontmatter); target under test
- Data out: Structured results (JSON), screenshots, action logs, per-call LLM usage sidecar (`usage.jsonl`, obol schema)

<!-- Maintained by the maintaining-project-map skill. Do not hand-edit; regenerated. -->

# Gauntlet

Gauntlet is an AI-powered QA testing framework. It uses large language models (Claude or GPT) to test software the way a human tester would: working through web apps in a real browser, CLI tools at a stdin/stdout prompt, and terminal/TUI programs in a live tmux session — clicking, typing, reading screens, and reporting bugs. You write **story cards** -- markdown files with a title, description, and acceptance criteria -- and Gauntlet's AI agent works through them via one of three adapters (`web`, `cli`, `tui`), delivering a verdict (pass/fail/investigate) with evidence.

## What it does

1. **You describe what to test** in a story card -- a markdown file with a title, description, and acceptance criteria.
2. **An AI agent drives your target** through one of three adapters: a real Chrome browser (via CDP) for web apps, a stdin/stdout subprocess for CLI tools, or a tmux-hosted session for terminal/TUI programs.
3. **The agent explores and evaluates** your acceptance criteria, but also reports anything else it notices: bugs, UX issues, typos, accessibility problems, performance issues, and suggestions.
4. **You get a structured result** with a verdict, reasoning, observations, screenshots, and an action log.

Beyond single-story testing, Gauntlet can **generate variations** ("fanout") from a parent story card -- producing edge-case, error-path, and alternate-persona stories automatically. It can also generate follow-up stories from observations or failures in previous runs.

## Architecture

```
                  ┌──────────────┐
                  │  Story Cards │  (markdown files with YAML frontmatter)
                  └──────┬───────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   CLI commands     HTTP API + UI    Fanout generator
   (run, validate)  (Hono server)    (AI-generated variations)
        │                │
        └────────┬───────┘
                 │
           ┌─────┴──────┐
           │   Agent    │  (agentic loop: LLM + adapter tools, wall-clock budget)
           └─────┬──────┘
                 │
        ┌────────┼────────┐
        │        │        │
   LLM Client  Adapter   Evidence Logger
   (Claude or  (one of)  (screenshots,
    OpenAI)              action log)
                │
                │   web → Chrome via CDP
                │   cli → stdin/stdout subprocess
                │   tui → tmux send-keys + ANSI capture
                ▼
           target under test
```

### Tech stack

- **Runtime**: [Bun](https://bun.sh) (TypeScript)
- **Server**: [Hono](https://hono.dev) (minimal web framework)
- **Frontend**: React 19 + React Router 7 + Vite + Tailwind CSS
- **Automation surfaces**: Chrome DevTools Protocol for `web` (custom CDP library), stdin/stdout subprocess for `cli`, tmux send-keys + ANSI capture-pane for `tui`
- **AI providers**: Anthropic SDK (Claude) and OpenAI SDK
- **Deployment**: Docker (Debian + Chromium + Bun); a separate `Dockerfile.chrome` ships a Google Chrome sidecar for amd64 production use
- **Storage**: File-based (no database) -- markdown for stories, JSON for results

## How it works

### Story cards

Story cards are markdown files (conventionally named `story.md`) with YAML-style frontmatter followed by a markdown body:

```markdown
---
id: login-001
title: User can log in with valid credentials
status: ready
tags: auth, smoke
stakeholder: end-user
---

Test the login flow for a registered user.

## Acceptance Criteria

- User can enter email and password
- Clicking "Log in" with valid credentials navigates to the dashboard
- Error message is shown for an incorrect password
```

**Frontmatter** (delimited by `---` lines, one `key: value` per line):

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Stable identifier for the card (used in URLs and filenames) |
| `title` | yes | One-line human-readable summary |
| `status` | no | `draft` or `ready` (defaults to `draft`). Only `ready` cards are surfaced for routine runs |
| `tags` | no | Comma-separated list (e.g. `auth, smoke`) |
| `stakeholder` | no | Whose perspective the test takes (e.g. `end-user`, `admin`) |
| `parent` | no | `id` of the parent card -- set automatically on fanout-generated variations to link back to the source. Lineage only; it does **not** imply run order or a dependency between cards. |

The frontmatter parser is intentionally minimal: it splits on the first `:` per line, so values are plain strings -- do not quote them and do not use nested YAML structures.

**Body**: free-form markdown describing the story. Everything before the `## Acceptance Criteria` heading is treated as the description and passed to the agent as context. Lines under `## Acceptance Criteria` that begin with `- ` are parsed as individual criteria; a criterion may soft-wrap across multiple lines -- continuation lines (indented or not) are joined onto the bullet until a blank line or the next bullet. The agent evaluates each one and the verdict reflects whether they all hold. The `## Acceptance Criteria` section is optional -- a description-only card is valid.

You can validate a card's format with `gauntlet validate story.md`.

Each file holds exactly one card: one frontmatter block, one description, one optional `## Acceptance Criteria` list. `gauntlet run` executes one card in one agent loop; `gauntlet batch` (see [Batch mode](#batch-mode) below) takes a set of card paths and runs them serially with a live progress display and an aggregate exit code.

**Copy-paste template** -- a minimal card you can drop into a new `story.md` and edit:

```markdown
---
id: my-card-001
title: Short description of what this tests
status: draft
tags: smoke
stakeholder: end-user
---

Describe the story here: what the tester should do, any setup or context
they need, and what a successful run looks like.

## Acceptance Criteria

- First thing that must be true
- Second thing that must be true
- Third thing that must be true
```

### Context

Cards describe outcomes. To get from *"Matt writes a journal entry"* to a real authenticated user clicking real buttons, the agent needs material the card itself doesn't carry: who Matt is, what his credentials are, how to get past the sign-in screen. That material lives in a folder at `.gauntlet/context/` — natural-language fixtures the agent reads as part of its system prompt.

A typical layout:

```
.gauntlet/context/
  HOW-TO-LOGIN.md         # plain English: where the sign-in form is, what to type
  profiles/
    matt/
      profile.md          # name, credentials, a sentence of personality
      cookies.yaml        # optional: pre-baked session for install_cookies
```

Filenames are not load-bearing. `HOW-TO-LOGIN.md`, `LOGIN-INSTRUCTIONS.md`, or `auth.md` all work — the agent infers what each file is for from its name and contents the same way a new teammate would skim a wiki. The card refers to the user by name in prose (*"Matt writes a post…"*); the agent picks the right profile by inference.

What context buys you: every card doesn't have to repeat itself. Add a profile once, and any card that mentions that user can sign in as them. Change a password in `profile.md`, and the next run picks it up — no test plumbing to update. When a card fails for an avoidable reason, the fix is usually a sentence in a `.md` file, not a code change.

For the auth specifics — `install_cookies`, password-based sign-in, the cookie-lifecycle quirk — see [`docs/credentials.md`](docs/credentials.md).

### The agent loop

The core of Gauntlet is an agentic loop in `src/agent/agent.ts`:

1. The story card is loaded and a system prompt is built, instructing the LLM to act as a thorough QA tester.
2. The LLM is given adapter tools — the set depends on which adapter the run picked. Web exposes a browser surface (mouse, keyboard, navigation, extraction, tab management); `cli` exposes `type` / `press` / `read_output`; `tui` exposes `type` / `press` / `read_screen`. See [Adapters](#adapters) for the full lists. A special `report_result` tool is always added.
3. On each turn, the LLM decides what to do -- take a screenshot, click a button, type into a form, etc. Tool results (including screenshot images) are fed back into the conversation.
4. The loop continues until the agent calls `report_result` with its verdict, or exhausts its wall-clock time budget (`--max-time`, default 5m). When the budget runs out, the orchestrator gives the agent one grace turn to file a final report before terminating.
5. Each tool call has a 30-second timeout to prevent hangs.

The agent reports:
- **Status**: `pass`, `fail`, or `investigate`
- **Summary and reasoning**: what happened and why
- **Observations**: an array of `{kind, description}` where kind is one of: `bug`, `ux`, `typo`, `suggestion`, `a11y`, `performance`

### Adapters

Gauntlet ships three adapters. The agent loop is identical at every level — only the tools and the "vision" the agent gets back change. Pick one with `--adapter web|cli|tui`. The default is `web`. For a six-story walkthrough that exercises all three, see [`docs/tutorial.md`](docs/tutorial.md).

| Adapter | What it drives | What `--target` is | Vision |
|---------|----------------|--------------------|--------|
| `web` | Real Chrome, via CDP | A URL | DOM text + pixel screenshots |
| `cli` | A subprocess spawned with `sh -c "<target>"` | A shell command | Bytes on stdout/stderr |
| `tui` | A target spawned inside a detached tmux session at 120×40 | A shell command | ANSI-rendered screen (colors, cursor, escapes preserved) |

#### Web adapter

`src/adapters/web/adapter.ts` drives Chrome via CDP. It exposes seventeen browser tools by default, plus three optional tools (`read`, `install_cookies`, `install_passkey`) that are mounted when the corresponding context files exist:

| Tool | Description |
|------|-------------|
| `screenshot` | Capture the page or a specific element (returns image to the LLM) |
| `click` | Click an element by selector (CSS, XPath, or `:contains('text')`) |
| `type` | Type text into an element |
| `press` | Press a special key (Enter, Tab, Escape, etc.) |
| `hover` | Move the mouse over an element (fires `:hover` and tooltips) |
| `double_click` | Double-click an element |
| `right_click` | Right-click to open a context menu |
| `drag` | Drag an element to another selector or to `{x, y}` coordinates |
| `mouse_move` | Move the mouse to viewport coordinates |
| `scroll` | Scroll the page or an element using real wheel events |
| `file_upload` | Upload local files into an `<input type=file>` |
| `navigate` | Go to a URL |
| `extract` | Return the page (or element) as DOM text |
| `eval` | Run a JavaScript expression in the page |
| `wait_for` | Wait for an element or text to appear |
| `new_tab` | Open a foreground tab for a side trip (OTP fetch, 2FA portal) |
| `close_tab` | Close the current side-trip tab and return to the original |
| `read` *(opt-in)* | Read a fixture file from `.gauntlet/context/` |
| `install_cookies` *(opt-in)* | Install browser cookies from `cookies.yaml` — see [`docs/credentials.md`](docs/credentials.md) |
| `install_passkey` *(opt-in)* | Register a virtual WebAuthn credential from `passkey.yaml` — see [`docs/credentials.md`](docs/credentials.md) |

Most tools support `return_screenshot` to automatically capture the page state after the action.

#### CLI adapter

`src/adapters/cli/adapter.ts` spawns the target with `sh -c "<target>"` and connects the agent to its stdin/stdout/stderr. No browser, no terminal emulator — the agent reads bytes and writes bytes.

| Tool | Description |
|------|-------------|
| `type` | Write text to the subprocess's stdin |
| `press` | Send a special key (Enter → `\n`, Tab → `\t`, Escape → `\x1b`, Ctrl+C/D/Z) |
| `read_output` | Read whatever the subprocess has written to stdout/stderr since the last read |
| `read` *(opt-in)* | Read a fixture file from `.gauntlet/context/` |

Use this for `npm init`-style prompt-and-answer flows, REPLs, and any program whose UI is a stream of plain text.

#### TUI adapter

`src/adapters/tui/adapter.ts` runs the target inside a detached `tmux` session at 120×40. Keystrokes go in via `tmux send-keys`; the screen comes back via `tmux capture-pane -p -e` with ANSI escapes preserved, so the agent reads color, cursor position, and inverse video the way a human would. Requires `tmux` on the host.

| Tool | Description |
|------|-------------|
| `type` | Send literal text to the tmux session |
| `press` | Send a named key (`Enter`, `Tab`, `Escape`, arrow keys, `Backspace`, `Delete`, `Home`/`End`, `PageUp`/`PageDown`, `Ctrl+C/D/Z/X/O/S/W/K/G`) |
| `read_screen` | Capture the current pane as ANSI-escaped text |
| `read` *(opt-in)* | Read a fixture file from `.gauntlet/context/` |

Use this for full-screen terminal UIs: `vim`, arrow-key selectors (`bun init`), `htop`, anything that uses cursor positioning or color as a UI signal.

### LLM providers

Gauntlet supports two providers via a common `LLMClient` interface:

- **Anthropic** (`src/models/anthropic.ts`): Uses Claude with prompt caching (ephemeral markers on system prompt, tools, and the last message) to reduce token costs on long agent runs.
- **OpenAI** (`src/models/openai.ts`): Standard chat completions API.

### Fanout: test variation generation

The fanout system (`src/fanout/generator.ts`) uses an LLM to automatically generate additional story cards from a parent card. Three modes:

- **Variations**: Edge cases, error paths, alternate personas, boundary conditions (3-5 generated per parent card).
- **From observations**: Promotes observations from a test run (bugs, UX issues, etc.) into focused follow-up story cards.
- **From failures**: When a test fails, generates 2-3 root-cause investigation stories.

Generated cards include `parent` linking back to the source and are validated against the story card format before being saved.

### Evidence collection

During each run, the `EvidenceLogger` captures:
- **Screenshots**: PNG images saved to a `screenshots/` directory
- **Action log**: A JSONL file recording every tool call and its arguments
- **Video**: Frame capture for playback in the UI

Results are written to a `results/` directory as `result.json` alongside the evidence files.

## Installation

Gauntlet ships as a `gauntlet` command on your PATH. The package isn't published to a registry; it's consumed via a local clone, with `bun link` registering the repo's `bin` entry globally so every shell sees it.

### Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- Google Chrome (or Chromium) — required for the `web` adapter; the CDP driver works against either
- `tmux` — required for the `tui` adapter
- An LLM credential — `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` in your environment, or a Claude subscription via `GAUNTLET_OAUTH_TOKEN` (see [Using a Claude subscription (OAuth)](#using-a-claude-subscription-oauth))

### Install

```bash
git clone git@github.com:prime-radiant-inc/gauntlet.git
cd gauntlet
bun install
bun link            # registers the package globally; adds `gauntlet` to ~/.bun/bin
```

Verify:

```bash
cd /tmp
gauntlet            # prints usage
gauntlet config     # reads project + env config
```

`~/.bun/bin` is on your PATH after `bun.sh/install`. If `gauntlet: command not found`, add `~/.bun/bin` to PATH manually.

### Upgrade

```bash
cd <gauntlet-repo>
git pull
bun install
```

The symlink already points at the repo — no re-link needed.

### Uninstall

```bash
cd <gauntlet-repo>
bun unlink
```

## Usage

### CLI

```bash
# Run a story against a target URL
gauntlet run story.md --target http://localhost:3000

# Run with a specific model, adapter, viewport, and time budget
gauntlet run story.md --target http://localhost:3000 --model agent=claude-sonnet-4-6 --adapter web --viewport 1440x900 --max-time 5m

# Stream machine-readable events instead of the pretty terminal transcript
gauntlet run story.md --target http://localhost:3000 --format jsonl

# Suppress the run transcript and only print the runId on stderr
gauntlet run story.md --target http://localhost:3000 --silent

# Run a set of cards serially with a live progress display
gauntlet batch story-a.md story-b.md --target http://localhost:3000

# Glob-expanded set; exit 0 iff every card passes, 1 otherwise
gauntlet batch stories/*.md --target https://staging.example.com

# Validate a story card's format
gauntlet validate story.md

# Generate test variations from a story card
gauntlet fanout story.md --out ./stories

# Generate follow-up stories from a previous result
gauntlet fanout --from-result ./results/run-001 --out ./stories

# Start the web server — point --project-dir at the project's root
# (Gauntlet writes state to <project>/.gauntlet/).
gauntlet serve --port 4400 --project-dir ../my-app
```

### Batch mode

`gauntlet batch <story.md> [more.md ...] --target <url>` runs N cards
serially. The active card sits at the bottom as a single redrawing
spinner line; finished cards stack above as committed result rows. The
final summary tells you where evidence landed.

```
Gauntlet · 3 cards · target https://app.local

  ✓ login-matt              pass          6 turns · 4.2s
        → /…/.gauntlet/results/login-matt_…/
  ! login-not-logged-in     investigate   9 turns · 8.1s
        → /…/.gauntlet/results/login-not-logged-in_…/
  ⠋ [3/3] login-locked-out   turn 4

batch: 1 pass · 0 fail · 1 investigate · 0 errored
results: /…/.gauntlet/results
```

Per-card flags (`--target`, `--adapter`, `--model`, `--chrome`,
`--max-time`, `--reflection-interval`, `--viewport`, `--save-screencast`,
`--project-dir`) apply uniformly to every card. `--out` is rejected — each card uses its
default per-run directory under `<.gauntlet>/results/<runId>/`.

Output modes:

- **Default** (TTY): the live ticker shown above.
- **`--format jsonl`**: every per-event log line on stdout, with
  `runId` injected. No table. This is the CI / machine-readable mode.
- **`--silent`**: stdout is empty; the one-line summary lands on
  stderr. The exit code (`0` iff every card is `pass`, `1` otherwise)
  is the only other signal.

Errors don't abort the batch — a card that throws is marked errored
and the loop moves on. Concurrent execution (`-j N`) isn't implemented
yet; v1 is strictly serial.

To see Chrome's launch banners (silent by default to keep the ticker
clean), set `GAUNTLET_CHROME_VERBOSE=1`.

### Web UI

Run `gauntlet serve` to start the server (default port 4400). The UI provides:

- **Cards view**: Browse, create, and edit story cards in a sidebar-driven interface.
- **Runs view**: See all test results with status badges (pass/fail/investigate), view summaries, observations, and screenshot evidence.
- **Run detail**: Watch video playback of the test, read the agent's reasoning, see token usage, and trigger fanout (generate variations, investigate failures).
- **Live run**: Start a test from the UI and watch it execute in real-time via WebSocket -- see the browser frames update and the LLM's output stream in.

### API

The HTTP API (Hono) serves at `/api`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scenarios` | GET | List all story cards |
| `/api/scenarios` | POST | Create a new story card |
| `/api/scenarios/:id` | GET | Get a single card |
| `/api/scenarios/:id` | PUT | Update a card |
| `/api/scenarios/:id` | DELETE | Delete a card |
| `/api/scenarios/:id/approve` | POST | Set card status to ready |
| `/api/run/:id` | POST | Execute a story; returns `{ runId, cardId }` |
| `/api/results` | GET | List all results |
| `/api/results/:runId` | GET | Get result metadata |
| `/api/results/:runId/file/:path` | GET | Fetch a file from a run (must be listed in result.json) |
| `/api/run-sets/:id` | GET | Get a run-set's metadata and per-attempt results |
| `/api/run-sets/:id/summary` | GET | Aggregate summary (per-card buckets: `consistent_pass`, `mixed`, `errored`, …) |
| `/api/run-sets/:id` | DELETE | Delete a run-set and all of its runs from disk |
| `/api/runs/active` | GET | List runs currently executing in this server process |
| `/api/runs/active/:runId/snapshot` | GET | Current snapshot of an in-flight run (latest events, last frame) |
| `/api/fanout/:id` | POST | Generate test variations |
| `/api/fanout/:id/observations` | POST | Generate cards from observations |
| `/api/fanout/:id/failure` | POST | Generate cards from a failure |
| `/api/config` | GET | Loaded server config |
| `/api/config/effective` | GET | Effective config with per-field source attribution (env / flag / default) — same payload as `gauntlet config --json` |
| `/api/errors` | GET | Tail of recent error envelopes captured by the unified error pipeline (debug aid) |
| `/api/ws?run=<runId>` | WS | WebSocket for live run streaming, scoped to one run |
| `/api/ws/run-sets/:id` | WS | WebSocket for run-set live streaming (per-attempt completions, manifest updates) |

## Docker

Run a story from the current directory against a target URL — the container mounts your working directory and reads `story.md`:

```bash
docker run --rm \
  -e OPENAI_API_KEY=sk-... \
  -e GAUNTLET_AGENT_MODEL=gpt-5-mini \
  -v "$PWD:/work" -w /work \
  gauntlet run story.md --target https://example.com
```

On macOS/Windows, use `--target http://host.docker.internal:3000` to reach a dev server running on the host.

The Docker image includes Chromium (multi-arch — works on both amd64 and arm64), Bun, and the pre-built UI, on Debian bookworm-slim. For production deployments that prefer Google Chrome, the separate `docker/Dockerfile.chrome` builds a standalone headless Chrome sidecar (amd64 only).

### Docker Compose

For persistent server use — the web UI, repeat runs, multiple stories — Compose is more ergonomic, mostly because it reads a `.env` file so API keys and defaults live in one place instead of on every `docker run` invocation:

```bash
cp .env.example .env    # then fill in your API keys
docker compose up
```

By default this mounts `.` (the Gauntlet repo itself) as the project root and Gauntlet writes state under `./.gauntlet/`. Story cards live at `.gauntlet/stories/`, run artifacts at `.gauntlet/results/`.

## Configuration

Gauntlet loads its runtime configuration once at startup via `loadConfig(argv, env)`. The result is an `AppConfig` object that flows explicitly through every command, route factory, and adapter. There is exactly one place that reads `process.env` for Gauntlet-level config; everything else takes its inputs as arguments.

### Precedence

```
defaults < environment variables < CLI flags < per-request body (web only)
```

The web `POST /api/run/:id` body is validated against an explicit allow-list. Unknown fields are rejected with HTTP 400. Every field exposed to the web is a conscious decision.

### CLI flags per command

| Command | Flag | Description |
|---------|------|-------------|
| `run` | `--target <url>` | (required) Application under test |
| `run` | `--model agent=<name>` | Model for the agent |
| `run` | `--chrome host:port` | Chrome debugging endpoint |
| `run` | `--adapter web\|cli\|tui` | Adapter type (default: web) |
| `run` | `--max-time <duration>` | Wall-clock budget per run; accepts ms/s/m/h or bare seconds (default: 5m) |
| `run` | `--reflection-interval <n>` | Inject a reflection-checkpoint reminder every N turns (default: 10; 0 disables) |
| `run` | `--passes <n>` | Number of attempts for this card; integer in `[1, 50]` (default: 1). Used to surface flaky behavior — repeated attempts roll up into a run-set. |
| `run` | `--viewport WxH` | Browser viewport for web-adapter runs (default: 1440x900) |
| `run` | `--save-screencast [bool]` | Persist screencast frames to disk (default: off; live UI stream is unchanged) |
| `run` | `--out <dir>` | Evidence output directory |
| `run` | `--project-dir <dir>` | Project root (contains `.gauntlet/` state dir) |
| `run` | `--silent` | Suppress the streaming transcript; prints only `runId` on stderr |
| `run` | `--format pretty\|jsonl` | Streaming transcript format (default: auto by TTY) |
| `run` | `--no-color` | Disable ANSI color output; `NO_COLOR` is also respected |
| `run` | `--project-prompt <path>` | Caller-supplied augmentation prompt (overrides `.gauntlet/project.md`) |
| `run` | `--show-prompt-and-exit` | Print the composed system prompt with provenance and exit (no Chrome, no LLM call) |
| `batch` | `<story.md> [more.md ...]` | Positional card paths (at least one required) |
| `batch` | `--target <url>` | (required) Application under test |
| `batch` | `--passes <n>` | Attempts per card; integer in `[1, 50]` (default: 1). The full execution becomes `cards × passes` runs, all rolled up into one run-set. |
| `batch` | other per-card flags | Same as `run` minus `--out`. Applied uniformly to every card. |
| `batch` | `--silent` | Suppress the table; print only the final summary on stderr |
| `batch` | `--format pretty\|jsonl` | Output format (default: auto by TTY); jsonl injects `runId` per event |
| `batch` | `--no-color` | Disable ANSI color output; `NO_COLOR` is also respected |
| `serve` | `--port <n>` | Server port |
| `serve` | `--project-dir <dir>` | Project root (contains `.gauntlet/` state dir) |
| `serve` | `--chrome host:port` | Default Chrome endpoint for runs |
| `serve` | `--target <url>` | Default target hint for the UI |
| `serve` | `--model agent=<name>` | Default agent model |
| `serve` | `--max-time <duration>` | Default time budget per run (default: 5m) |
| `serve` | `--reflection-interval <n>` | Default reflection-checkpoint interval (default: 10; 0 disables) |
| `serve` | `--viewport WxH` | Default browser viewport (default: 1440x900) |
| `serve` | `--save-screencast [bool]` | Default screencast-frame persistence (default: off) |
| `config` | `--json` | Emit JSON instead of formatted text |
| `config` | `--project-dir <dir>` | Inspect config with this project root override |
| `config` | `--port <n>` | Inspect config with this server port override |
| `config` | `--chrome host:port` | Inspect config with this Chrome endpoint override |
| `config` | `--target <url>` | Inspect config with this target override |
| `config` | `--model agent=<name>` | Inspect config with this agent model override |
| `config` | `--max-time <duration>` | Inspect config with this time-budget override |
| `config` | `--reflection-interval <n>` | Inspect config with this reflection-interval override |
| `config` | `--viewport WxH` | Inspect config with this viewport override |
| `config` | `--save-screencast [bool]` | Inspect config with this screencast override |
| `validate` | (positional `<story.md>` only) | Parse and validate a story card's frontmatter and structure. Exits non-zero on failure. |
| `fanout` | `--out <dir>` | Output directory |
| `fanout` | `--model fanout=<name>` | Model for generation |
| `fanout` | `--from-result <dir>` | Generate from an existing result |
| `ask` | (positional `<runId>`) | Open an interactive REPL against a completed run, replaying its conversation up to a chosen turn |
| `ask` | `--turn <n>` | Cut off at turn N (default: include all turns) |
| `ask` | `--model <model-id>` | Override the recorded model (default: pin to recorded) |
| `ask` | `--project-dir <dir>` | Project root (contains `.gauntlet/results/<runId>`) |

Unknown flags are now rejected loudly. If you mistype `--chrom` you will get an error, not silent fallthrough.

### Environment variables

Gauntlet-prefixed (consumed by `loadConfig`):

| Variable | Description | Default |
|----------|-------------|---------|
| `GAUNTLET_PORT` | Server port | `4400` |
| `GAUNTLET_PROJECT_ROOT` | Project root (contains `.gauntlet/` state dir) | `.` |
| `GAUNTLET_CHROME` | Default Chrome endpoint (`host:port`) | `127.0.0.1:9222` |
| `GAUNTLET_TARGET` | Default target URL, surfaced as a UI prefill | -- |
| `GAUNTLET_MAX_TIME` | Default wall-clock budget per run; accepts ms/s/m/h or bare seconds | `5m` |
| `GAUNTLET_REFLECTION_INTERVAL` | Default reflection-checkpoint interval (turns; `0` disables) | `10` |
| `GAUNTLET_VIEWPORT` | Default browser viewport (`WxH`) | `1440x900` |
| `GAUNTLET_SAVE_SCREENCAST` | Persist screencast frames to disk (`1/0`, `true/false`, `yes/no`, `on/off`) | `0` |
| `GAUNTLET_AGENT_MODEL` | Default agent model | `claude-sonnet-4-6` |
| `GAUNTLET_FANOUT_MODEL` | Default fanout model | -- |
| `GAUNTLET_MODELS` | Comma-separated allow-list of models (opt-in) | `[]` (no restriction) |
| `GAUNTLET_CHROME_VERBOSE` | Print Chrome lifecycle messages (reconnect, startup, session dir) on stderr. Any truthy string activates it. | unset |

### SDK env pass-through policy

Gauntlet does **not** read, wrap, or re-export the SDK-native environment variables — with one exception, a Claude subscription token (see below). Otherwise they flow directly to the Anthropic and OpenAI SDKs via the empty-constructor pattern (`new Anthropic()`, `new OpenAI()`).

| Variable | Owned by |
|----------|----------|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_LOG` | Anthropic SDK |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT` | OpenAI SDK |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Both SDKs (via Node) |

If you want to point Gauntlet at a custom Anthropic endpoint, set `ANTHROPIC_BASE_URL=https://your-gateway.example.com` directly. Gauntlet will not touch it; the SDK will.

`gauntlet config` records the *presence* of API keys in its output (`apiKeys.anthropic: set`) but never their values.

### Using a Claude subscription (OAuth)

For Claude models, Gauntlet can authenticate with a **logged-in Claude subscription** instead of a pay-per-token API key — useful for running Gauntlet's QA driver against your existing Max/Pro plan.

1. Mint a long-lived token (interactive, one-time):

   ```bash
   claude setup-token
   ```

2. Put it in your environment as `GAUNTLET_OAUTH_TOKEN` (e.g. in `.env`, or a shell-global variable). When present, Gauntlet **prefers it over `ANTHROPIC_API_KEY`**; the API key remains the fallback.

   `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` are honoured too, after `GAUNTLET_OAUTH_TOKEN`, for environments that already export them on purpose. Do not store the token globally under either of those names: Claude Code reads both, so every Claude Code session on the machine would authenticate with that token instead of its own login.

Unlike the other Anthropic env vars, Gauntlet reads this one explicitly: it constructs the client with the token as `authToken` (Bearer), sends the `anthropic-beta: oauth-2025-04-20` header, and — because Anthropic gates subscription tokens to Claude Code — prepends the exact Claude Code identity (`"You are Claude Code, Anthropic's official CLI for Claude."`) as the **first** system block of every request, with the QA system prompt following. A request missing that framing is rejected with `429`.

**Caveat:** that identity block means the Gauntlet-Agent (the grader) runs under a "you are Claude Code" preface ahead of its QA instructions. The QA prompt itself is unchanged (it's the second block), so the effect is small, but it is a behavioral nudge worth knowing when comparing API-key vs subscription runs.

`gauntlet config` shows `anthropic: set` whenever either credential is present.

### Inspecting effective config

```bash
gauntlet config              # formatted text with per-field source attribution
gauntlet config --json       # machine-readable
GAUNTLET_PORT=5500 gauntlet config --project-dir /tmp/x
#   port:           5500  (env)
#   projectRoot:    /tmp/x  (flag)
```

The same payload is available over HTTP at `GET /api/config/effective` once the server is running.

### Docker / compose pattern

Use `GAUNTLET_CHROME` to point at a sidecar Chrome service:

```yaml
services:
  gauntlet:
    environment:
      GAUNTLET_CHROME: chrome:9222
      GAUNTLET_AGENT_MODEL: claude-sonnet-4-6
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
```

## Environment variables

See the [Configuration](#configuration) section above for the full list. Quick reference:

| Variable | Description | Default |
|----------|-------------|---------|
| `GAUNTLET_OAUTH_TOKEN` | Claude subscription token (`claude setup-token`); preferred over `ANTHROPIC_API_KEY` when set. `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` are read as fallbacks. See [Using a Claude subscription (OAuth)](#using-a-claude-subscription-oauth). | -- |
| `ANTHROPIC_API_KEY` | API key for Claude models | -- |
| `OPENAI_API_KEY` | API key for OpenAI models | -- |
| `GAUNTLET_PORT` | Server port | 4400 |
| `GAUNTLET_PROJECT_ROOT` | Project root (contains `.gauntlet/` state dir) | `.` |
| `GAUNTLET_CHROME` | Default Chrome endpoint | `127.0.0.1:9222` |
| `GAUNTLET_TARGET` | Default target URL for the web UI | -- |
| `GAUNTLET_MAX_TIME` | Default wall-clock budget per run | `5m` |
| `GAUNTLET_REFLECTION_INTERVAL` | Default reflection-checkpoint interval (turns; `0` disables) | `10` |
| `GAUNTLET_VIEWPORT` | Default browser viewport | `1440x900` |
| `GAUNTLET_SAVE_SCREENCAST` | Persist screencast frames to disk | `0` |
| `GAUNTLET_AGENT_MODEL` | Default model for test execution | `claude-sonnet-4-6` |
| `GAUNTLET_FANOUT_MODEL` | Model for story generation | -- |
| `GAUNTLET_MODELS` | Comma-separated model allow-list (opt-in) | `[]` (no restriction) |
| `GAUNTLET_CHROME_VERBOSE` | Print Chrome lifecycle messages on stderr | unset |

## Project structure

```
src/
  index.ts              CLI entry point and command router
  types.ts              Core types (VetResult, Observation, RunConfigSnapshot)
  config.ts             Single loadConfig() — env + flags → AppConfig
  paths.ts              .gauntlet/ project directory conventions
  agent/
    agent.ts            Agentic loop: LLM + tools, with grace turn after max
    prompts.ts          System prompt construction from story cards + context
    validators.ts       Per-tool argument schema validation before dispatch
  models/
    provider.ts         LLM client interface
    anthropic.ts        Claude client (with prompt caching)
    openai.ts           OpenAI client
    resolve.ts          Model string -> client instantiation
  adapters/
    adapter.ts          Abstract adapter interface
    web/adapter.ts      Chrome CDP browser adapter (17 tools + 3 opt-in)
    web/cookies.ts      install_cookies tool + cookies.yaml loader
    web/passkey.ts      install_passkey tool + passkey.yaml loader
    cli/adapter.ts      Terminal-based adapter (stdin/stdout target)
    tui/adapter.ts      Text UI adapter (tmux-hosted target)
    tui/capture-parser.ts  ANSI screen capture → structured cells
  api/
    server.ts           Hono app: API routes + static UI serving
    ws.ts               WebSocket broadcaster for single runs
    ws-handlers.ts      Per-connection handler dispatch
    active-runs.ts      In-process registry of running runs
    run-cancel.ts       Cancellation plumbing for live runs
    run-set-broadcaster.ts  WS broadcaster for run-sets (multi-pass / batch)
    mime-types.ts       Static-file content-type table
    routes/
      scenarios.ts      Story-card CRUD
      run.ts            POST /api/run/:id — start a run
      run-sets.ts       Run-set retrieval, summary, deletion
      results.ts        Result list + per-run files (manifest-gated)
      fanout.ts         Generate variations / from-observations / from-failure
      active-runs.ts    GET /api/runs/active
      config.ts         GET /api/config
      config-effective.ts  GET /api/config/effective
      errors.ts         GET /api/errors (tail of recent error envelopes)
  cli/
    args.ts             CLI argument parsing
    run.ts              `run` command (single-card streaming wrapper)
    run-one.ts          Engine shared by `run` and `batch` (constructs
                        EvidenceLogger, drives runAgent, owns adapter lifecycle)
    batch.ts            `batch` command — serial runner + per-card observer
    validate.ts         `validate` command
    fanout.ts           `fanout` command
    config-command.ts   `config` command (effective config inspector)
    error-output.ts     Unified top-level error envelope across commands
    signals.ts          SIGINT/SIGTERM handling for in-flight runs
    stream/             Streaming-transcript renderers (pretty, jsonl,
                        batch-table) plus shared formatters
  cards/
    store.ts            Story-card filesystem store (read/write/list)
  runs/
    orchestrator.ts     Shared run orchestrator (used by CLI and HTTP)
    run-set.ts          Run-set lifecycle (passes × cards loop)
    run-set-types.ts    RunSetCtx / SetBucket types
    aggregate.ts        Per-set roll-up (consistent_pass / mixed / errored)
    snapshot.ts         Per-run snapshot for /api/runs/active
  context/
    tree.ts             .gauntlet/context/ directory listing for system prompt
    read-tool.ts        Opt-in `read` tool (when context tree non-empty)
  fanout/
    generator.ts        AI-powered test variation generation
  evidence/
    logger.ts           Per-run event log + screenshot/capture writers
    writer.ts           Result serialization (result.json + result.md)
    run-set-writer.ts   Run-set roll-up serialization
  format/
    story-card.ts       Story card parsing and serialization
  streaming/
    screencast.ts       Browser frame capture (opt-in disk persistence)
  util/
    id.ts               runId composition
    pick-free-port.ts   Local TCP port helper (dev / test / Chrome launch)
    sanitize-error.ts   Stack-trace scrubbing for transmissible error envelopes
ui/
  src/
    App.tsx             React Router setup
    main.tsx            Vite entry point
    app.css             Global styles
    components/         CardsList, CardEditor, RunsList, RunDetail, RunSetDetail,
                        LiveRun, NewRunModal, AppShell, Sidebar, transcript/...
    components/transcript/  Transcript view + ToolPairCard, EventLine,
                            Screenshot, TuiCapture, ThinkingBlock, etc.
    hooks/              useCards, useCard, useResults, useRunStream,
                        useTranscript, useLiveTranscript, useActiveRuns
    lib/api.ts          HTTP client for the backend API
    lib/runId.ts        runId parsing helpers (mirrors src/util/id.ts)
    lib/transcript.ts   Reducer for transcriptSnapshot + event WS messages
docker/
  Dockerfile            Production image (Debian + Chromium + Bun)
  Dockerfile.chrome     Standalone headless Chrome image (separate target)
compose.yaml            Docker Compose entry point (mounts project root at /project)
.env.example            Template for API keys and optional env overrides
```

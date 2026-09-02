import type { CliArgsInput } from "../config";
import { ADAPTER_TYPES, isAdapterType, type AdapterType } from "../adapters/adapter";

/**
 * parseInt("abc", 10) returns NaN, which propagates through loadConfig
 * (typeof NaN === "number") and ultimately crashes Bun.serve. Reject
 * non-integer values up front with a clean error, matching how
 * GAUNTLET_PORT is validated inside loadConfig.
 */
function parseIntFlag(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${label} value "${raw}": expected an integer`);
  }
  return parsed;
}

/**
 * Parse a boolean CLI flag. A bareword `--flag` yields true (parseFlags
 * stores "true"); an explicit `--flag false` / `--flag 0` yields false.
 * Returns undefined when absent so loadConfig can fall through to env /
 * server default.
 */
function parseBoolFlag(raw: string | undefined, label: string): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  throw new Error(`Invalid ${label} value "${raw}": expected a boolean (true/false, 1/0, yes/no, on/off)`);
}

/**
 * Parse the --passes flag. Defaults to 1 when omitted. Must be an integer
 * in the range [1, 50]. The soft cap at 50 is a v1 safety guard against
 * accidental thousand-pass invocations.
 */
function parsePasses(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error(`--passes must be an integer in [1, 50], got: ${raw}`);
  }
  return n;
}

const RUN_ALLOWED = new Set([
  "target", "out", "adapter", "model", "chrome", "project-dir", "state-dir",
  "max-time", "reflection-interval", "viewport", "save-screencast",
  "silent", "format", "no-color", "passes",
  "project-prompt",
  "show-prompt-and-exit",
]);
// Everything `run` accepts, minus `--out` — batch doesn't invent a
// batch-level results dir; each card writes to its default per-run dir.
// `--project-prompt` and `--show-prompt-and-exit` are excluded; batch
// may get them in a future task.
const BATCH_ALLOWED = new Set([...RUN_ALLOWED].filter(
  (f) => f !== "out" && f !== "project-prompt" && f !== "show-prompt-and-exit",
));
const VALIDATE_ALLOWED = new Set<string>([]);
const FANOUT_ALLOWED = new Set(["out", "model", "from-result"]);
const SERVE_ALLOWED = new Set(["port", "project-dir", "state-dir", "chrome", "target", "model", "max-time", "reflection-interval", "viewport", "save-screencast"]);
const CONFIG_ALLOWED = new Set(["json", "project-dir", "state-dir", "port", "chrome", "target", "model", "max-time", "reflection-interval", "viewport", "save-screencast"]);
const ASK_ALLOWED = new Set(["turn", "model", "project-dir", "state-dir"]);
const RENDER_ALLOWED = new Set(["project-dir", "state-dir"]);

function rejectUnknownFlags(
  flags: Record<string, unknown>,
  allowed: Set<string>,
  command: string,
): void {
  const unknown = Object.keys(flags).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    const validList = [...allowed].sort().map((f) => `--${f}`).join(", ");
    throw new Error(
      `Unknown flag${unknown.length > 1 ? "s" : ""} for "gauntlet ${command}": ${unknown.map((f) => `--${f}`).join(", ")}\n\nValid flags: ${validList || "(none)"}`,
    );
  }
}

export interface RunArgs {
  command: "run";
  scenarioPath: string;
  outDir?: string;
  adapter: AdapterType;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
  passes: number;
  projectPromptPath?: string;
  showPromptAndExit: boolean;
  cli: CliArgsInput;
}

export interface BatchArgs {
  command: "batch";
  scenarioPaths: string[];
  adapter: AdapterType;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
  passes: number;
  cli: CliArgsInput;
}

export interface ValidateArgs {
  command: "validate";
  scenarioPath: string;
}

export interface FanoutArgs {
  command: "fanout";
  scenarioPath?: string;
  resultDir?: string;
  outDir: string;
  cli: CliArgsInput;
}

export interface ServeArgs {
  command: "serve";
  cli: CliArgsInput;
}

export interface ConfigArgs {
  command: "config";
  json: boolean;
  cli: CliArgsInput;
}

export interface AskArgs {
  command: "ask";
  runId: string;
  upToTurn?: number;
  modelOverride?: string;
  cli: CliArgsInput;
}

export interface RenderArgs {
  command: "render";
  /** A run-id (looked up under <state-dir>/results/) or an absolute/relative path to a run dir. */
  runIdOrPath: string;
  cli: CliArgsInput;
}

export type ParsedArgs = RunArgs | BatchArgs | ValidateArgs | FanoutArgs | ServeArgs | ConfigArgs | AskArgs | RenderArgs;

export function parseArgs(argv: string[]): ParsedArgs {
  // Skip "bun" and script name. Strip `--verbose` here so it works on
  // every command without polluting per-command flag whitelists; it's a
  // process-wide signal consumed by the top-level error renderer in
  // src/index.ts (via isVerboseRequest), not a per-command behavior flag.
  const args = argv.slice(2).filter((a) => a !== "--verbose");
  const command = args[0];

  if (!command) {
    throw new Error(usage());
  }

  switch (command) {
    case "run":
      return parseRunArgs(args.slice(1));
    case "batch":
      return parseBatchArgs(args.slice(1));
    case "validate":
      return parseValidateArgs(args.slice(1));
    case "fanout":
      return parseFanoutArgs(args.slice(1));
    case "serve":
      return parseServeArgs(args.slice(1));
    case "config":
      return parseConfigArgs(args.slice(1));
    case "ask":
      return parseAskArgs(args.slice(1));
    case "render":
      return parseRenderArgs(args.slice(1));
    default:
      throw new Error(`Unknown command: ${command}\n${usage()}`);
  }
}

function parseConfigArgs(args: string[]): ConfigArgs {
  // `--json` works as a bareword (parseFlags maps it to "true") or as
  // an explicit `--json true`. parseFlags now refuses to swallow a
  // following `--flag` as the value, so no special-casing is needed.
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, CONFIG_ALLOWED, "config");
  return {
    command: "config",
    json: flags.json === "true",
    cli: {
      projectRoot: flags["project-dir"],
      stateDirName: flags["state-dir"],
      port: parseIntFlag(flags.port, "--port"),
      chrome: flags.chrome,
      target: flags.target,
      viewport: flags.viewport,
      saveScreencast: parseBoolFlag(flags["save-screencast"], "--save-screencast"),
      models: parseModelFlagArray(flags.model),
      maxTime: typeof flags["max-time"] === "string" ? flags["max-time"] : undefined,
      reflectionInterval: parseIntFlag(flags["reflection-interval"], "--reflection-interval"),
    },
  };
}

function parseAskArgs(args: string[]): AskArgs {
  const positional = extractPositional(args);
  if (!positional) {
    throw new Error("Missing runId\n\nUsage: gauntlet ask <runId> [--turn N] [--model MODEL]");
  }
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, ASK_ALLOWED, "ask");
  // parseFlags accumulates --model into flags.model (string[])
  const modelOverride =
    Array.isArray(flags.model) && flags.model.length > 0
      ? flags.model[0]
      : undefined;
  return {
    command: "ask",
    runId: positional,
    upToTurn: parseIntFlag(flags.turn, "--turn"),
    modelOverride,
    cli: { projectRoot: flags["project-dir"], stateDirName: flags["state-dir"] },
  };
}

function parseRenderArgs(args: string[]): RenderArgs {
  const positional = extractPositional(args);
  if (!positional) {
    throw new Error("Missing run-id or path\n\nUsage: gauntlet render <run-id-or-path>");
  }
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, RENDER_ALLOWED, "render");
  return {
    command: "render",
    runIdOrPath: positional,
    cli: { projectRoot: flags["project-dir"], stateDirName: flags["state-dir"] },
  };
}

function parseRunArgs(args: string[]): RunArgs {
  const positional = extractPositional(args);
  if (!positional) {
    throw new Error("Missing story path\n\nUsage: gauntlet run <story.md> --target <url>");
  }

  const flags = parseFlags(args);
  rejectUnknownFlags(flags, RUN_ALLOWED, "run");
  if (!flags.target) {
    throw new Error("Missing required flag: --target <url>");
  }

  let adapter: AdapterType = "web";
  if (flags.adapter !== undefined) {
    if (!isAdapterType(flags.adapter)) {
      throw new Error(
        `Invalid --adapter value "${flags.adapter}": must be one of ${ADAPTER_TYPES.join(", ")}`,
      );
    }
    adapter = flags.adapter;
  }

  let format: "pretty" | "jsonl" | undefined;
  if (flags.format !== undefined) {
    if (flags.format !== "pretty" && flags.format !== "jsonl") {
      throw new Error(`Invalid --format value "${flags.format}": must be "pretty" or "jsonl"`);
    }
    format = flags.format;
  }

  return {
    command: "run",
    scenarioPath: positional,
    outDir: flags.out,
    adapter,
    silent: flags.silent === "true",
    format,
    noColor: flags["no-color"] === "true",
    passes: parsePasses(flags.passes),
    projectPromptPath: flags["project-prompt"],
    showPromptAndExit: flags["show-prompt-and-exit"] === "true",
    cli: {
      projectRoot: flags["project-dir"],
      stateDirName: flags["state-dir"],
      chrome: flags.chrome,
      target: flags.target,
      viewport: flags.viewport,
      saveScreencast: parseBoolFlag(flags["save-screencast"], "--save-screencast"),
      models: parseModelFlagArray(flags.model),
      maxTime: typeof flags["max-time"] === "string" ? flags["max-time"] : undefined,
      reflectionInterval: parseIntFlag(flags["reflection-interval"], "--reflection-interval"),
    },
  };
}

function parseBatchArgs(args: string[]): BatchArgs {
  // Positionals must precede all flags. A bareword flag immediately before a
  // path would absorb that path as its value (same convention as
  // extractPositional / parseRunArgs).
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    positionals.push(args[i]);
  }
  if (positionals.length === 0) {
    throw new Error("Missing card paths\n\nUsage: gauntlet batch <story.md> [more.md ...] --target <url>\n\nAt least one card path is required.");
  }

  const flags = parseFlags(args);
  rejectUnknownFlags(flags, BATCH_ALLOWED, "batch");
  if (!flags.target) {
    throw new Error("Missing required flag: --target <url>");
  }

  let adapter: AdapterType = "web";
  if (flags.adapter !== undefined) {
    if (!isAdapterType(flags.adapter)) {
      throw new Error(
        `Invalid --adapter value "${flags.adapter}": must be one of ${ADAPTER_TYPES.join(", ")}`,
      );
    }
    adapter = flags.adapter;
  }

  let format: "pretty" | "jsonl" | undefined;
  if (flags.format !== undefined) {
    if (flags.format !== "pretty" && flags.format !== "jsonl") {
      throw new Error(`Invalid --format value "${flags.format}": must be "pretty" or "jsonl"`);
    }
    format = flags.format;
  }

  return {
    command: "batch",
    scenarioPaths: positionals,
    adapter,
    silent: flags.silent === "true",
    format,
    noColor: flags["no-color"] === "true",
    passes: parsePasses(flags.passes),
    cli: {
      projectRoot: flags["project-dir"],
      stateDirName: flags["state-dir"],
      chrome: flags.chrome,
      target: flags.target,
      viewport: flags.viewport,
      saveScreencast: parseBoolFlag(flags["save-screencast"], "--save-screencast"),
      models: parseModelFlagArray(flags.model),
      maxTime: typeof flags["max-time"] === "string" ? flags["max-time"] : undefined,
      reflectionInterval: parseIntFlag(flags["reflection-interval"], "--reflection-interval"),
    },
  };
}

function parseValidateArgs(args: string[]): ValidateArgs {
  const positional = extractPositional(args);
  if (!positional) {
    throw new Error("Missing story path\n\nUsage: gauntlet validate <story.md>");
  }

  const flags = parseFlags(args);
  rejectUnknownFlags(flags, VALIDATE_ALLOWED, "validate");

  return {
    command: "validate",
    scenarioPath: positional,
  };
}

function parseFanoutArgs(args: string[]): FanoutArgs {
  const positional = extractPositional(args);
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, FANOUT_ALLOWED, "fanout");
  const resultDir = flags["from-result"];

  if (!positional && !resultDir) {
    throw new Error("Missing story path or --from-result\n\nUsage: gauntlet fanout <story.md> | --from-result <result-dir>");
  }

  return {
    command: "fanout",
    scenarioPath: positional,
    resultDir,
    outDir: flags.out ?? "./",
    cli: {
      models: parseModelFlagArray(flags.model),
    },
  };
}

function parseServeArgs(args: string[]): ServeArgs {
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, SERVE_ALLOWED, "serve");

  return {
    command: "serve",
    cli: {
      projectRoot: flags["project-dir"],
      stateDirName: flags["state-dir"],
      port: parseIntFlag(flags.port, "--port"),
      chrome: flags.chrome,
      target: flags.target,
      viewport: flags.viewport,
      saveScreencast: parseBoolFlag(flags["save-screencast"], "--save-screencast"),
      models: parseModelFlagArray(flags.model),
      maxTime: typeof flags["max-time"] === "string" ? flags["max-time"] : undefined,
      reflectionInterval: parseIntFlag(flags["reflection-interval"], "--reflection-interval"),
    },
  };
}

/**
 * Accepted form is `--model agent=<name>` or `--model fanout=<name>`.
 * Anything else (bare value, unknown role prefix) is dropped with a
 * stderr warning so the user sees what was ignored — the silent-drop
 * behavior was the source of the "why didn't --model work?" report.
 */
function parseModelFlagArray(
  modelFlags: string[] | undefined,
): { agent?: string; fanout?: string } | undefined {
  if (!modelFlags || modelFlags.length === 0) return undefined;
  const out: { agent?: string; fanout?: string } = {};
  for (const flag of modelFlags) {
    const idx = flag.indexOf("=");
    if (idx === -1) {
      console.warn(
        `warning: ignoring --model "${flag}" — expected --model agent=<name> or --model fanout=<name>`,
      );
      continue;
    }
    const role = flag.slice(0, idx);
    const model = flag.slice(idx + 1);
    if (role !== "agent" && role !== "fanout") {
      console.warn(
        `warning: ignoring --model "${flag}" — unknown role "${role}"; expected "agent" or "fanout"`,
      );
      continue;
    }
    out[role] = model;
  }
  return out;
}

/** Extract the first positional argument (non-flag, not a flag value) */
function extractPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i++; // skip flag value
      continue;
    }
    return args[i];
  }
  return undefined;
}

/** Parse --flag value pairs. Repeatable flags (like --model) collect into arrays.
 *
 * A flag whose "value" begins with `--` (or is missing entirely) is treated as
 * a bareword flag — `flags[key] = "true"` — and the next token is left in
 * place for the next iteration. This prevents `--json --project-dir /tmp` from
 * silently eating the `--project-dir` token as the value of `--json`.
 */
function parseFlags(args: string[]): Record<string, string> & { model?: string[] } {
  const flags: Record<string, string> = {};
  const models: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;

    const key = args[i].slice(2);
    const value = args[i + 1];

    if (key === "model") {
      if (value !== undefined && !value.startsWith("--")) {
        models.push(value);
        i++;
      }
      // bareword --model is meaningless, but don't swallow the next flag
    } else {
      if (value !== undefined && !value.startsWith("--")) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = "true"; // bareword flag
      }
    }
  }

  const result = flags as Record<string, string> & { model?: string[] };
  if (models.length > 0) result.model = models;
  return result;
}

function usage(): string {
  return `Usage: gauntlet <command> [options]

Commands:
  run <story.md>    Run a story
    --target <url>       (required) Application under test
    --model agent=<name> Model for the agent (default: claude-sonnet-4-6)
    --chrome host:port   Chrome debugging endpoint (default: 127.0.0.1:9222)
    --adapter <type>     web | cli | tui (default: web)
    --max-time <duration>   Max wall-clock time per run (default: 5m). Accepts ms/s/m/h suffixes or bare seconds.
    --reflection-interval <n>  Inject a reflection-checkpoint reminder every N turns (default: 10; 0 disables)
    --viewport WxH       Browser viewport (default: 1440x900)
    --save-screencast    Persist screencast frames to disk (default: off; live WS stream is always on)
    --out <dir>          Evidence output directory (default: <project>/<state-dir>/results/<runId>)
    --project-dir <dir>  Project root (contains the state dir)
    --state-dir <name>   State directory leaf name (default: .gauntlet). Single segment, no slashes.
                         A non-dotted name (e.g. "gauntlet") is committed by default — add to .gitignore yourself.
    --silent             Suppress the streaming transcript (default: stream)
    --format <mode>      Stream format: pretty | jsonl (default: auto by TTY)
    --no-color           Disable ANSI color (also respects NO_COLOR env var)
    --project-prompt <path> Caller-supplied augmentation prompt (overrides <state-dir>/project.md)
    --show-prompt-and-exit  Print the composed system prompt with provenance and exit (no Chrome, no LLM call)

  batch <story.md> [more.md ...]  Run multiple cards serially
    --target <url>       (required) Application under test
    --model agent=<name> Model for the agent
    --chrome host:port   Chrome debugging endpoint
    --adapter <type>     web | cli | tui (default: web)
    --max-time <duration>   Max wall-clock time per run (default: 5m). Accepts ms/s/m/h suffixes or bare seconds.
    --reflection-interval <n>  Inject a reflection-checkpoint reminder every N turns (default: 10; 0 disables)
    --viewport WxH       Browser viewport
    --save-screencast    Persist screencast frames to disk
    --project-dir <dir>  Project root
    --silent             Suppress the table; only print final summary
    --format <mode>      pretty | jsonl (default: auto by TTY)
    --no-color           Disable ANSI color

  validate <story.md>  Validate a story file

  fanout <story.md>    Fan out a story into sub-stories
    --out <dir>             Output directory
    --model fanout=<name>   Model for generation
    --from-result <dir>     Generate from an existing result directory

  serve                    Start the API server
    --port <n>               Server port (default: 4400)
    --project-dir <dir>      Project root (contains the state dir)
    --state-dir <name>       State directory leaf name (default: .gauntlet)
    --chrome host:port       Default Chrome endpoint for runs
    --target <url>           Default target (prefilled in the UI; request body still overrides)
    --max-time <duration>    Default time budget per run (default: 5m). Accepts ms/s/m/h suffixes or bare seconds.
    --reflection-interval <n>  Default reflection-checkpoint interval (default: 10; 0 disables)
    --viewport WxH           Default browser viewport (default: 1440x900)
    --save-screencast        Default: persist screencast frames to disk (default: off)
    --model agent=<name>     Default agent model

  config                   Print effective configuration
    --json                   Emit JSON instead of text (also accepts --json true)
    (also accepts the same knobs as serve/run, for "what would happen if...")

  ask <runId>              Chat with the agent from a completed run.
    --turn N                 Cut off at turn N (default: include all turns)
    --model <model-id>       Override the recorded model (default: pin to recorded)
    --project-dir <dir>      Project root (contains <state-dir>/results/<runId>)
    --state-dir <name>       State directory leaf name (default: .gauntlet)

  render <runIdOrPath>     Re-render an existing run's HTML report (<runDir>/index.html)
    --project-dir <dir>      Project root (contains the state dir)
    --state-dir <name>       State directory leaf name (default: .gauntlet)

Environment:
  GAUNTLET_PORT              Server port
  GAUNTLET_PROJECT_ROOT      Project root (contains the state dir)
  GAUNTLET_STATE_DIR         State directory leaf name (default: .gauntlet)
  GAUNTLET_CHROME            Default Chrome endpoint (host:port)
  GAUNTLET_TARGET            Default target URL (UI prefill)
  GAUNTLET_MAX_TIME          Default time budget (duration string, e.g. 5m)
  GAUNTLET_REFLECTION_INTERVAL Default reflection-checkpoint interval (turns; 0 disables)
  GAUNTLET_VIEWPORT          Default browser viewport (WxH, e.g. 1440x900)
  GAUNTLET_SAVE_SCREENCAST   Persist screencast frames to disk (1/0, default: 0)
  GAUNTLET_AGENT_MODEL       Default agent model
  GAUNTLET_FANOUT_MODEL      Default fanout model
  GAUNTLET_MODELS            Comma-separated model allow-list

  GAUNTLET_OAUTH_TOKEN     Claude subscription token (claude setup-token); preferred over ANTHROPIC_API_KEY.
                           CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN are honoured too, but Claude Code
                           reads those, so a global export under them hijacks every Claude Code session
  ANTHROPIC_API_KEY        Read by the Anthropic SDK (if using Claude models)
  OPENAI_API_KEY           Read by the OpenAI SDK (if using GPT models)

Run 'gauntlet config' to see effective configuration at any time.`;
}

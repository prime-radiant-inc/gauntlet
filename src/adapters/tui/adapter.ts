import type { Adapter } from "../adapter";
import { textResult, type ToolDefinition, type ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";
import { buildSharedTools, type SharedTools } from "../../agent/shared-tools";
import { validateToolArgs } from "../../agent/validators";
import type { CredentialResolverConfig, Viewport } from "../../config";
import { defaultCaptureParser, type CaptureParser } from "./capture-parser";
import { spawnSync } from "../../runtime/spawn";
import { mkdirSync } from "fs";
import { join } from "path";
import { runInputGuard, type InputGuard } from "./input-guard";
import { listDescendants } from "../../runtime/process-tree";

/**
 * tmux pane dimensions in character cells. Hardcoded for now — resize
 * support lands when we have a reason to need it. `defaultViewport()`
 * reports these in the run snapshot.
 */
const TUI_GRID: Viewport = { width: 120, height: 40 };

const KEY_MAP: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
  Backspace: "BSpace",
  Delete: "DC",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  "Ctrl+C": "C-c",
  "Ctrl+D": "C-d",
  "Ctrl+Z": "C-z",
  "Ctrl+X": "C-x",
  "Ctrl+O": "C-o",
  "Ctrl+S": "C-s",
  "Ctrl+W": "C-w",
  "Ctrl+K": "C-k",
  "Ctrl+G": "C-g",
};

const AVAILABLE_KEYS = Object.keys(KEY_MAP).join(", ");

export interface TUIAdapterOptions {
  contextRoot?: string;
  inputGuard?: InputGuard;
  /**
   * Per-run directory; adapter creates `<runDir>/scratch` as bash cwd.
   * Required at start(); optional only so the registry's
   * tool-introspection construction (which never starts a session) still
   * works. In production, always set.
   */
  runDir?: string;
  /**
   * Logger used by the adapter to emit cleanup events
   * (`tui_session_descendants_reaped`). Optional for the same registry
   * reason.
   */
  logger?: EvidenceLogger;
  credentialResolver?: CredentialResolverConfig;
  /** Override the capture parser (differential testing, future ghostty
   *  selection). Defaults to xterm. */
  captureParser?: CaptureParser;
  /**
   * How long close() waits (ms) for descendants to exit on the HUP from
   * the dying pty before SIGKILLing them. Well-behaved TUI agents flush
   * state on HUP (Copilot CLI writes its session.shutdown usage record
   * ~11ms after the signal); an instant SIGKILL races that flush away.
   * Default 3000.
   */
  descendantGraceMs?: number;
}

export class TUIAdapter implements Adapter {
  readonly name = "tui";
  private _sessionName: string | null = null;
  private _socket: string | null = null;
  private shared: SharedTools;
  private captureParser: CaptureParser;
  /** Lazy cache of tool name → parameter schema for O(1) validation. */
  private toolSchemas: Map<string, ToolDefinition["parameters"]> | null = null;
  private runDir: string | undefined;
  private logger: EvidenceLogger | undefined;
  private bashPid: number | null = null;
  private descendantGraceMs: number;

  private readonly inputGuard?: InputGuard;

  constructor(options?: TUIAdapterOptions) {
    this.inputGuard = options?.inputGuard;
    this.shared = buildSharedTools({
      contextRoot: options?.contextRoot,
      credentialResolver: options?.credentialResolver,
      cwd: options?.runDir ? join(options.runDir, "scratch") : undefined,
    });
    this.captureParser = options?.captureParser ?? defaultCaptureParser;
    this.runDir = options?.runDir;
    this.logger = options?.logger;
    this.descendantGraceMs = options?.descendantGraceMs ?? 3000;
  }

  get sessionName(): string {
    if (!this._sessionName) throw new Error("Session not started");
    return this._sessionName;
  }

  /**
   * Build a tmux invocation pinned to this session's private server.
   *
   * Each session runs on its own `-L <socket>` server rather than the
   * shared default server. `tmux new-session` against the default server
   * attaches to whatever server is already running, and the new session
   * inherits the *server's* environment — which is stale whenever that
   * server was started by some unrelated process (it never saw this
   * process's env, so vars like ANTHROPIC_API_KEY never reach the agent).
   * A private server is started by our own `new-session` call and so
   * inherits this process's full environment instead. `kill-server`
   * disposes it cleanly with no orphan.
   */
  private tmux(...args: string[]): string[] {
    if (!this._socket) throw new Error("Session not started");
    return ["tmux", "-L", this._socket, ...args];
  }

  async start(_target: string): Promise<void> {
    if (!this.runDir) {
      throw new Error("TUIAdapter: runDir is required to start a session");
    }
    const id = `gauntlet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._sessionName = id;
    this._socket = id;
    const scratch = join(this.runDir, "scratch");
    mkdirSync(scratch, { recursive: true });

    const create = spawnSync(this.tmux(
      "new-session", "-d", "-s", id,
      "-x", String(TUI_GRID.width),
      "-y", String(TUI_GRID.height),
      "-c", scratch,
      "bash", "--norc", "--noprofile", "-i",
    ));
    if (create.exitCode !== 0) {
      throw new Error(
        `Failed to start tmux session: ${new TextDecoder().decode(create.stderr)}`,
      );
    }

    this.bashPid = await this.readPanePid(id);
  }

  private async readPanePid(sessionId: string): Promise<number> {
    // tmux new-session -d should make pane_pid available immediately, but on
    // loaded CI machines we've seen the first read race the pane setup.
    // One short retry covers the gap cheaply.
    for (let attempt = 0; attempt < 2; attempt++) {
      const pane = spawnSync(this.tmux("list-panes", "-t", sessionId, "-F", "#{pane_pid}"));
      if (pane.exitCode === 0) {
        const pid = Number(new TextDecoder().decode(pane.stdout).trim());
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Failed to read pane pid for session ${sessionId} after retry`);
  }

  async readScreen(): Promise<string> {
    const result = spawnSync(this.tmux(
      "capture-pane",
      "-t",
      this.sessionName,
      "-p",
      "-e",
    ));

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to capture pane: ${stderr}`);
    }

    return new TextDecoder().decode(result.stdout);
  }

  async type(text: string): Promise<void> {
    this.guard("type", { text });
    const result = spawnSync(this.tmux(
      "send-keys",
      "-t",
      this.sessionName,
      "-l",
      text,
    ));

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to send keys: ${stderr}`);
    }
  }

  async press(key: string): Promise<void> {
    this.guard("press", { key });
    const mapped = KEY_MAP[key];
    if (!mapped) throw new Error(`Unknown key: ${key}. Available: ${AVAILABLE_KEYS}`);

    const result = spawnSync(this.tmux(
      "send-keys",
      "-t",
      this.sessionName,
      mapped,
    ));

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to send key: ${stderr}`);
    }
  }

  // Type, give the receiving TUI one render cycle to settle, then send Enter.
  // Submit-then-drop in Ink/React TUIs (Codex, Claude Code) is a render-state
  // race on the receiver, not a sender-atomicity issue — when Enter arrives
  // during the render that the text update triggered, the input field's
  // state machine handles it against a stale view and discards it. A small
  // fixed delay covers a single ~16ms frame and turns the race into a
  // guarantee.
  async typeAndSubmit(text: string): Promise<void> {
    await this.type(text);
    await new Promise((r) => setTimeout(r, 15));
    await this.press("Enter");
  }

  private guard(name: string, args: Record<string, unknown>, logger = this.logger): void {
    if (!this.inputGuard || (name === "press" && ["Escape", "Ctrl+C"].includes(String(args.key)))) return;
    runInputGuard(this.inputGuard, { name, args }, logger);
  }

  describeTarget(target: string): string {
    const base =
      `You are at an interactive bash shell rendered inside a tmux pane ` +
      `(${TUI_GRID.width}×${TUI_GRID.height}). Use \`type_and_submit\` to ` +
      `issue shell commands and answer any prompts; reach for \`type\` and ` +
      `\`press\` only for incremental input or named keys. The shell is your ` +
      `durable session — many commands can run through it during the run. ` +
      `When you are finished, send \`exit\` to close the shell cleanly.`;
    if (!target) return base;
    return `${base} The command you are exercising is \`${target}\`.`;
  }

  defaultViewport(): Viewport {
    return TUI_GRID;
  }

  async close(): Promise<void> {
    if (!this._sessionName) return;
    const sessionName = this._sessionName;
    const descendants = this.bashPid !== null
      ? listDescendants(this.bashPid)
      : [];

    try {
      // kill-server (not kill-session): the private server holds only this
      // session, so disposing the whole server is correct and orphan-free.
      spawnSync(this.tmux("kill-server"));
    } catch {
      // server may already be dead
    }

    // The dying pty just HUP'd the pane's process group. Give descendants a
    // grace window to flush state and exit on their own (Copilot CLI writes
    // its session.shutdown usage record ~11ms after SIGHUP) before hard-
    // killing the stragglers — an instant SIGKILL races that flush away.
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    const deadline = Date.now() + this.descendantGraceMs;
    let survivors = descendants.filter(alive);
    while (survivors.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      survivors = survivors.filter(alive);
    }

    let reaped = 0;
    for (const pid of survivors) {
      try { process.kill(pid, "SIGKILL"); reaped++; } catch { /* already dead */ }
    }
    if (reaped > 0 && this.logger) {
      this.logger.logEvent("tui_session_descendants_reaped", {
        sessionName,
        descendantCount: descendants.length,
        reapedCount: reaped,
      });
    }

    this._sessionName = null;
    this._socket = null;
    this.bashPid = null;
  }

  isMutatingTool(name: string): boolean {
    return name === "type" || name === "press" || name === "type_and_submit" || (name === "bash" && !!this.inputGuard);
  }

  toolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "type",
        description: "Type literal text into the terminal",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type" },
          },
          required: ["text"],
        },
      },
      {
        name: "press",
        description: `Press a special key. Available keys: ${AVAILABLE_KEYS}`,
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key name to press" },
          },
          required: ["key"],
        },
      },
      {
        name: "type_and_submit",
        description:
          "Type literal text and then press Enter to submit it, pacing the two so full-screen TUIs (e.g. Codex, Claude Code) don't drop the Enter mid-redraw — which they do when a separate `type` followed by `press(Enter)` lands the Enter inside the render that the text update triggered, leaving the message in the input field unsent. For line-oriented programs (bash, REPLs) `type` with a trailing newline is equivalent and either works.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type before submitting" },
          },
          required: ["text"],
        },
      },
      {
        name: "read_screen",
        description: "Read the current terminal screen. Returns the rendered text with ANSI escape sequences preserved so you can see colors and styles — e.g. `\\x1b[31mX\\x1b[0m` means character X is red. Parse these to verify color-dependent behavior. Cursor-movement and clear sequences are already resolved by the terminal.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    ];
    tools.push(...this.shared.definitions());
    return tools;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    logger: EvidenceLogger
  ): Promise<ToolResult> {
    // See WebAdapter.executeTool for the rationale: validate the LLM's
    // argument shape once, upfront, before dispatching to a handler that
    // would otherwise `as` the types and crash on bad input.
    if (!this.toolSchemas) {
      this.toolSchemas = new Map(
        this.toolDefinitions().map((t) => [t.name, t.parameters] as const),
      );
    }
    const schema = this.toolSchemas.get(name);
    if (schema) {
      const check = validateToolArgs(name, args, schema);
      if (!check.ok) {
        return textResult(`Error: invalid args for ${name}: ${check.reason}`);
      }
    }

    if (name === "bash") this.guard(name, args, logger);

    if (this.shared.canExecute(name)) {
      return this.shared.execute(name, args, logger);
    }

    switch (name) {
      case "type": {
        await this.type(args.text as string);
        return textResult("typed");
      }
      case "press": {
        await this.press(args.key as string);
        return textResult("pressed");
      }
      case "type_and_submit": {
        await this.typeAndSubmit(args.text as string);
        return textResult("typed and submitted");
      }
      case "read_screen": {
        const screen = await this.readScreen();
        // Parse on the server so the UI can render a layout-correct
        // 2D grid without re-parsing on every view. Both the raw ANSI
        // and the parsed JSON land under captures/.
        const parsed = await this.captureParser.parse(
          screen,
          TUI_GRID.width,
          TUI_GRID.height,
        );
        const capturePath = logger.saveCapture(screen, JSON.stringify(parsed));
        // Stream a `tui_capture` event over the existing WS channel.
        // Using logEvent (rather than a bespoke broadcaster call) lets
        // the observer plumbing already wired in run.ts forward this to
        // any subscribed clients — one mechanism, not two.
        logger.logEvent("tui_capture", {
          path: capturePath,
          cols: parsed.cols,
          rows: parsed.rows,
        });
        // LLM still sees the full ANSI via `text`; the logger will
        // substitute `capturePath` for `text` when writing the
        // tool_result row to run.jsonl.
        return { kind: "capture", text: screen, capturePath };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

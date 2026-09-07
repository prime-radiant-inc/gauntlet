import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUIAdapter } from "../../../src/adapters/tui/adapter";
import { EvidenceLogger } from "../../../src/evidence/logger";

const tmuxAvailable = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;

async function waitUntil(predicate: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function preparedFixture(scriptBody: string, descendantGraceMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "prepared subject-"));
  const runDir = join(root, "run");
  const workspace = join(root, "workspace with spaces");
  const launcherPath = join(root, "launcher with spaces");
  const socketPath = join(root, "tmux.sock");
  mkdirSync(runDir);
  mkdirSync(workspace);
  writeFileSync(launcherPath, `#!/bin/sh\n${scriptBody}`, { mode: 0o755 });
  const adapter = new TUIAdapter({
    runDir,
    descendantGraceMs,
    preparedSubject: { launcherPath, workspace, socketPath },
  });
  return { adapter, launcherPath, root, runDir, socketPath, workspace };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function closeAndRemove(adapter: TUIAdapter, socketPath: string, root: string): Promise<void> {
  try {
    await adapter.close();
    const server = Bun.spawnSync(["tmux", "-S", socketPath, "list-sessions"]);
    expect(server.exitCode).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!tmuxAvailable)("TUIAdapter prepared subject", () => {
  test("executes the exact launcher once and retains its final delivery", async () => {
    const fixture = preparedFixture(`
base=$(dirname "$0")
printf 'launch\\n' >> "$base/launch-count"
printf 'Question: What should we charge?\\n'
IFS= read -r answer
printf 'Delivered: %s\\n' "$answer"
`);
    const marker = join(fixture.root, "should-not-exist");
    try {
      await fixture.adapter.start("");
      expect(Bun.spawnSync([
        "tmux", "-S", fixture.socketPath, "has-session", "-t", fixture.adapter.sessionName,
      ]).exitCode).toBe(0);
      expect(await fixture.adapter.hasSubjectExited()).toBe(false);
      await waitUntil(
        async () => (await fixture.adapter.readScreen()).includes("Question: What should we charge?"),
        "the prepared subject question",
      );

      await fixture.adapter.typeAndSubmit("Charge full price.");
      await waitUntil(() => fixture.adapter.hasSubjectExited(), "the prepared subject to exit");

      expect(await fixture.adapter.hasSubjectExited()).toBe(true);
      expect(await fixture.adapter.readScreen()).toContain("Delivered: Charge full price.");
      await expect(fixture.adapter.type(`touch ${marker}`)).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
      await expect(fixture.adapter.start("")).rejects.toThrow();
      expect(readFileSync(join(fixture.root, "launch-count"), "utf8").trim().split("\n"))
        .toEqual(["launch"]);
      await fixture.adapter.close();
      await expect(fixture.adapter.start("")).rejects.toThrow();
    } finally {
      await closeAndRemove(fixture.adapter, fixture.socketPath, fixture.root);
    }
  });

  test("retains the screen when the launcher refuses immediately", async () => {
    const fixture = preparedFixture("printf 'Refused: no conversation available\\n'\nexit 7\n");
    try {
      await fixture.adapter.start("");
      await waitUntil(() => fixture.adapter.hasSubjectExited(), "the refusing subject to exit");

      expect(await fixture.adapter.readScreen()).toContain("Refused: no conversation available");
    } finally {
      await closeAndRemove(fixture.adapter, fixture.socketPath, fixture.root);
    }
  });

  test("close reaps a prepared child after its launcher exits without touching unrelated processes", async () => {
    const fixture = preparedFixture(`
base=$(dirname "$0")
(trap '' HUP TERM; exec sleep 30) </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!" > "$base/owned-pid"
printf 'Launcher exited with child alive\\n'
`, 100);
    const unrelated = Bun.spawn(["sleep", "30"]);
    let ownedPid: number | undefined;
    try {
      await fixture.adapter.start("");
      await waitUntil(() => fixture.adapter.hasSubjectExited(), "the child-launching subject to exit");
      ownedPid = Number(readFileSync(join(fixture.root, "owned-pid"), "utf8").trim());
      expect(processIsAlive(ownedPid)).toBe(true);
      expect(processIsAlive(unrelated.pid)).toBe(true);

      await fixture.adapter.close();
      await waitUntil(async () => !processIsAlive(ownedPid!), "the prepared subject child to be reaped");

      expect(processIsAlive(unrelated.pid)).toBe(true);
    } finally {
      if (ownedPid && processIsAlive(ownedPid)) process.kill(ownedPid, "SIGKILL");
      if (processIsAlive(unrelated.pid)) unrelated.kill();
      await unrelated.exited;
      await closeAndRemove(fixture.adapter, fixture.socketPath, fixture.root);
    }
  });

  test("finishInput closes every prepared-subject input route", async () => {
    const fixture = preparedFixture("printf 'Waiting for input\\n'\nIFS= read -r answer\nprintf 'Unexpected: %s\\n' \"$answer\"\n");
    const logger = new EvidenceLogger(join(fixture.root, "logs"));
    try {
      await fixture.adapter.start("");
      await waitUntil(
        async () => (await fixture.adapter.readScreen()).includes("Waiting for input"),
        "the prepared subject input prompt",
      );
      expect(fixture.adapter.toolDefinitions().map((tool) => tool.name)).not.toContain("bash");

      fixture.adapter.finishInput();

      await expect(fixture.adapter.type("text")).rejects.toThrow();
      await expect(fixture.adapter.press("Enter")).rejects.toThrow();
      await expect(fixture.adapter.typeAndSubmit("text")).rejects.toThrow();
      await expect(fixture.adapter.executeTool("type", { text: "text" }, logger)).rejects.toThrow();
      expect(await fixture.adapter.hasSubjectExited()).toBe(false);
    } finally {
      await closeAndRemove(fixture.adapter, fixture.socketPath, fixture.root);
    }
  });

  test("validates the prepared launcher and workspace before creating tmux", async () => {
    const fixture = preparedFixture("exit 0\n");
    const relative = new TUIAdapter({
      runDir: fixture.runDir,
      preparedSubject: {
        launcherPath: "relative-launcher",
        workspace: fixture.workspace,
        socketPath: fixture.socketPath,
      },
    });
    const missingWorkspace = new TUIAdapter({
      runDir: fixture.runDir,
      preparedSubject: {
        launcherPath: fixture.launcherPath,
        workspace: join(fixture.root, "missing-workspace"),
        socketPath: fixture.socketPath,
      },
    });
    const relativeWorkspace = new TUIAdapter({
      runDir: fixture.runDir,
      preparedSubject: {
        launcherPath: fixture.launcherPath,
        workspace: "relative-workspace",
        socketPath: fixture.socketPath,
      },
    });
    const nonExecutable = new TUIAdapter({
      runDir: fixture.runDir,
      preparedSubject: {
        launcherPath: fixture.launcherPath,
        workspace: fixture.workspace,
        socketPath: fixture.socketPath,
      },
    });
    try {
      await expect(relative.start("")).rejects.toThrow(/launcher.*absolute/i);
      await expect(missingWorkspace.start("")).rejects.toThrow(/workspace/i);
      await expect(relativeWorkspace.start("")).rejects.toThrow(/workspace.*absolute/i);
      chmodSync(fixture.launcherPath, 0o644);
      await expect(nonExecutable.start("")).rejects.toThrow(/launcher.*executable/i);
      expect(existsSync(fixture.socketPath)).toBe(false);
    } finally {
      await relative.close();
      await missingWorkspace.close();
      await relativeWorkspace.close();
      await nonExecutable.close();
      await closeAndRemove(fixture.adapter, fixture.socketPath, fixture.root);
    }
  });
});

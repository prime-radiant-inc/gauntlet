import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUIAdapter } from "../../../src/adapters/tui/adapter";
import { EvidenceLogger } from "../../../src/evidence/logger";
import { parseArgs } from "../../../src/cli/args";
import { run } from "../../../src/cli/run";
import { makeConfig } from "../../helpers/make-config";
import { makeScriptedClient, step, report } from "../../integration/helpers";

const dirs: string[] = [];
const adapters: TUIAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(timeoutMs = 10_000) {
  const dir = mkdtempSync(join(tmpdir(), "input-guard-"));
  dirs.push(dir);
  const guard = join(dir, "guard");
  const record = join(dir, "captured.jsonl");
  const block = join(dir, "block");
  writeFileSync(guard, `#!/bin/sh
IFS= read -r request
[ ! -f '${block}' ] || exit 7
printf '%s\\n' "$request" >> '${record}'
`, { mode: 0o755 });
  const logger = new EvidenceLogger(join(dir, "logs"));
  const adapter = new TUIAdapter({ runDir: dir, logger, inputGuard: { path: guard, timeoutMs } });
  adapters.push(adapter);
  await adapter.start("");
  return { dir, guard, record, block, logger, adapter };
}

test("CLI accepts the explicit guard only for a TUI run", () => {
  const args = parseArgs(["bun", "gauntlet", "run", "story.md", "--target", "local", "--adapter", "tui", "--tui-input-guard", "/guard"]);
  expect(args.command === "run" && args.tuiInputGuardPath).toBe("/guard");
  expect(() => parseArgs(["bun", "gauntlet", "run", "story.md", "--target", "local", "--adapter", "cli", "--tui-input-guard", "/guard"])).toThrow();
});

test("a missing or empty guard value cannot resolve to the true command on PATH", () => {
  const base = ["bun", "gauntlet", "run", "story.md", "--target", "local", "--adapter", "tui", "--tui-input-guard"];
  for (const suffix of [[], [""], ["true"], ["relative/path"]]) {
    expect(() => parseArgs([...base, ...suffix])).toThrow("absolute");
  }
});

for (const route of ["type_and_submit", "split", "newline", "bash"] as const) {
  test(`captures before delivering an unprompted approval through ${route}`, async () => {
    const f = await fixture();
    // The local subject accepts input only if evidence already exists. No
    // actor call to a capture command appears in this tool sequence.
    const delivered = join(f.dir, "delivered");
    const command = `test -s '${f.record}' && printf accepted > '${delivered}.tmp' && mv '${delivered}.tmp' '${delivered}'`;
    if (route === "split") {
      await f.adapter.executeTool("type", { text: command }, f.logger);
      await f.adapter.executeTool("press", { key: "Enter" }, f.logger);
    } else if (route === "newline") {
      await f.adapter.executeTool("type", { text: command + "\n" }, f.logger);
    } else if (route === "bash") {
      await f.adapter.executeTool("bash", { command }, f.logger);
    } else {
      await f.adapter.executeTool(route, { text: command }, f.logger);
    }
    for (let n = 0; n < 500 && !existsSync(delivered); n++) await Bun.sleep(20);
    expect(readFileSync(delivered, "utf8")).toBe("accepted");
    expect(readFileSync(f.record, "utf8").trim().split("\n").map((line) => JSON.parse(line)).length).toBeGreaterThan(0);
  }, 30_000);
}

test("failed captures block every input route while cancellation remains available", async () => {
  const f = await fixture();
  writeFileSync(f.block, "");
  const delivered = join(f.dir, "delivered");
  for (const [name, args] of [
    ["type", { text: `touch '${delivered}'\n` }],
    ["type_and_submit", { text: `touch '${delivered}'` }],
    ["press", { key: "Enter" }],
    ["bash", { command: `touch '${delivered}'` }],
  ] as const) {
    await expect(f.adapter.executeTool(name, args, f.logger)).rejects.toThrow("Input guard");
  }
  await f.adapter.executeTool("press", { key: "Escape" }, f.logger);
  await f.adapter.executeTool("press", { key: "Ctrl+C" }, f.logger);
  expect(existsSync(delivered)).toBe(false);
}, 30_000);

test("a guard that hangs cannot submit input", async () => {
  const f = await fixture(100);
  writeFileSync(f.guard, "#!/bin/sh\nexec sleep 60\n");
  await expect(f.adapter.executeTool("type_and_submit", { text: "true" }, f.logger)).rejects.toThrow("Input guard");
  expect(existsSync(f.record)).toBe(false);
});

test("parsed run options reach the real adapter even when the actor never requests capture", async () => {
  const f = await fixture();
  const story = join(f.dir, "story.md");
  writeFileSync(story, "---\nid: input-guard-integration\ntitle: Input capture\nstatus: ready\n---\nObserve the local subject.\n");
  const delivered = join(f.dir, "delivered-by-run");
  const args = parseArgs(["bun", "gauntlet", "run", story, "--target", "local", "--adapter", "tui", "--tui-input-guard", f.guard, "--silent"]);
  if (args.command !== "run") throw new Error("Expected run");
  await run({
    ...args, target: "local", adapterType: args.adapter,
    config: makeConfig(f.dir),
    clientFactory: () => makeScriptedClient([
      step("reply", "type_and_submit", { text: `test -s '${f.record}' && printf accepted > '${delivered}'` }),
      report("pass", "local input delivered", "checked capture"),
    ]),
  });
  expect(readFileSync(delivered, "utf8")).toBe("accepted");
}, 30_000);

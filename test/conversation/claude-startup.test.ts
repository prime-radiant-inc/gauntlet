import { expect, test } from "bun:test";
import { isClaudeReady } from "../../src/conversation/claude-startup";

const composerScreen = `╭─── Claude Code v2.1.209 ─────────────────────────╮
│                    Welcome back!                 │
╰──────────────────────────────────────────────────╯

────────────────────────────────────────────────────
❯  
────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)`;

test("recognizes only the observed Claude composer signature", () => {
  expect(isClaudeReady("Choose your preferred theme\n❯ Dark mode")).toBe(false);
  expect(
    isClaudeReady(
      "Claude Code v2.1.209\nBypass Permissions mode\n❯ Yes, I accept\nbypass permissions on",
    ),
  ).toBe(false);
  expect(
    isClaudeReady(
      "Claude Code v2.1.209\nNot logged in\n❯ \nbypass permissions on",
    ),
  ).toBe(false);
  expect(isClaudeReady("Claude Code v2.1.209\n❯ ")).toBe(false);
  expect(isClaudeReady("❯ \nbypass permissions on")).toBe(false);
  expect(isClaudeReady(composerScreen)).toBe(true);
});

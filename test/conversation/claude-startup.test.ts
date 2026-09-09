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
  expect(
    isClaudeReady(
      "\x1b[1m╭─── Claude Code \x1b[38;5;111mv2.1.209\x1b[0m ───╮\n\x1b[38;5;111m❯\x1b[0m  \n\x1b[2m⏵⏵ bypass permissions on\x1b[0m",
    ),
  ).toBe(true);
});

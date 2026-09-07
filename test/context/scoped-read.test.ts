import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFile } from "../../src/context/scoped-read";

describe("readWorkspaceFile", () => {
  test("reads a regular file inside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "conversation-read-"));
    try {
      writeFileSync(join(root, "answer.md"), "Here is the implementation.");
      expect(readWorkspaceFile(root, "answer.md")).toBe("Here is the implementation.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects traversal outside the workspace", () => {
    const parent = mkdtempSync(join(tmpdir(), "conversation-read-"));
    const root = join(parent, "workspace");
    mkdirSync(root);
    writeFileSync(join(parent, "private-rubric.md"), "secret");
    try {
      expect(() => readWorkspaceFile(root, "../private-rubric.md")).toThrow(/workspace/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects a symlink whose target escapes the workspace", () => {
    const parent = mkdtempSync(join(tmpdir(), "conversation-read-"));
    const root = join(parent, "workspace");
    mkdirSync(root);
    writeFileSync(join(parent, "private-rubric.md"), "secret");
    symlinkSync(join(parent, "private-rubric.md"), join(root, "answer.md"));
    try {
      expect(() => readWorkspaceFile(root, "answer.md")).toThrow(/workspace/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects directories and absolute paths", () => {
    const root = mkdtempSync(join(tmpdir(), "conversation-read-"));
    try {
      mkdirSync(join(root, "directory"));
      expect(() => readWorkspaceFile(root, "directory")).toThrow(/regular file/i);
      expect(() => readWorkspaceFile(root, join(root, "answer.md"))).toThrow(/relative/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

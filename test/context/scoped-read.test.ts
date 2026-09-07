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
import { readEvidenceFile, readWorkspaceFile } from "../../src/context/scoped-read";

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

describe("readEvidenceFile", () => {
  test("reads only regular files named by the exact evidence index", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-evidence-read-"));
    try {
      mkdirSync(join(root, "visible"));
      writeFileSync(join(root, "visible", "001.txt"), "visible evidence");
      writeFileSync(join(root, "unlisted.txt"), "private role history");
      const index = { files: ["visible/001.txt"] };

      expect(readEvidenceFile(root, index, "visible/001.txt")).toBe("visible evidence");
      expect(() => readEvidenceFile(root, index, "unlisted.txt")).toThrow(/not listed/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects traversal, duplicate, absolute, and symlink index entries", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-evidence-read-"));
    const outside = mkdtempSync(join(tmpdir(), "gauntlet-evidence-outside-"));
    try {
      writeFileSync(join(root, "evidence.txt"), "evidence");
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));

      expect(() => readEvidenceFile(root, { files: ["../secret.txt"] }, "../secret.txt"))
        .toThrow(/traversal|relative|escape/i);
      expect(() => readEvidenceFile(root, { files: [join(root, "evidence.txt")] }, join(root, "evidence.txt")))
        .toThrow(/relative|absolute/i);
      expect(() => readEvidenceFile(root, { files: ["evidence.txt", "evidence.txt"] }, "evidence.txt"))
        .toThrow(/duplicate/i);
      expect(() => readEvidenceFile(root, { files: ["link.txt"] }, "link.txt"))
        .toThrow(/symbolic link|symlink/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

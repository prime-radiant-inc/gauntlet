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
import { readEvidenceFile, readEvidenceRange, searchEvidence, readWorkspaceFile } from "../../src/context/scoped-read";

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


describe("bounded evidence inspection", () => {
  function withEvidence(run: (root: string, index: {files: string[]}) => void) {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-evidence-range-"));
    try {
      mkdirSync(join(root, "visible"));
      writeFileSync(join(root, "visible/review.md"), "one\ntwo\nthree\nfour");
      run(root, {files: ["visible/review.md"]});
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  test("returns exact line positions and literal search matches", () => withEvidence((root, index) => {
    expect(readEvidenceRange(root, index, {path: "visible/review.md", startLine: 2, maxLines: 2}))
      .toEqual({path: "visible/review.md", startLine: 2, endLine: 3, totalLines: 4,
        text: "two\nthree", truncated: true, nextLine: 4});
    expect(searchEvidence(root, index, {query: "three"})).toEqual({
      matches: [{path: "visible/review.md", line: 3, text: "three"}], truncated: false, unavailable: [],
    });
    expect(searchEvidence(root, index, {query: "THREE"}).matches).toEqual([]);
    expect(searchEvidence(root, index, {query: ".*"}).matches).toEqual([]);
  }));

  test("rejects invalid ranges and searches", () => withEvidence((root, index) => {
    for (const request of [{startLine: 0}, {startLine: 5}, {startLine: 1.5},
      {maxLines: 0}, {maxLines: 1001}, {maxLines: NaN}, {startColumn: 0}, {startColumn: 5}]) {
      expect(() => readEvidenceRange(root, index, {path: "visible/review.md", ...request})).toThrow();
    }
    for (const request of [{query: ""}, {query: "one", maxMatches: 0},
      {query: "one", maxMatches: 101}, {query: "one", maxMatches: 1.5}]) {
      expect(() => searchEvidence(root, index, request)).toThrow();
    }
  }));

  test("keeps confinement and reports unavailable files including corrupt UTF-8", () => withEvidence((root, index) => {
    writeFileSync(join(root, "private.txt"), "secret");
    symlinkSync(tmpdir(), join(root, "escape"));
    for (const path of ["private.txt", "../private.txt", join(root, "private.txt"), "escape/secret"]) {
      const scoped = path === "private.txt" ? index : {files: [path]};
      expect(() => readEvidenceRange(root, scoped, {path})).toThrow();
      expect(searchEvidence(root, scoped, {query: "secret", path}).unavailable).toHaveLength(1);
    }
    for (const path of ["missing.txt", "bad.txt"]) {
      if (path === "bad.txt") writeFileSync(join(root, path), Buffer.from([0xff]));
      expect(() => readEvidenceRange(root, {files: [path]}, {path})).toThrow();
      expect(searchEvidence(root, {files: [path]}, {query: "x"})).toMatchObject({matches: [], unavailable: [{path}]});
    }
  }));

  test("reconstructs a long JSON line using UTF-16 continuation without splitting Unicode", () => withEvidence((root, index) => {
    const source = "\ufeff" + JSON.stringify({claim: "a😀é".repeat(40000)});
    const path = index.files[0];
    writeFileSync(join(root, path), source);
    let startColumn = 1;
    let reconstructed = "";
    while (true) {
      const range = readEvidenceRange(root, index, {path, startLine: 1, startColumn});
      expect(Buffer.byteLength(range.text)).toBeLessThanOrEqual(65536);
      expect(range.text).not.toContain("�");
      reconstructed += range.text;
      if (!range.truncated) { expect(range.nextLine).toBeNull(); break; }
      expect(range.nextLine).toBe(1);
      expect(range.nextColumn).toBe(startColumn + range.text.length);
      startColumn = range.nextColumn!;
    }
    expect(Buffer.from(reconstructed)).toEqual(Buffer.from(source));
    writeFileSync(join(root, path), "😀");
    expect(() => readEvidenceRange(root, index, {path, startColumn: 2})).toThrow();
  }));

  test("continues correctly across byte caps at separators and Unicode boundaries", () => withEvidence((root, index) => {
    const path = index.files[0];
    writeFileSync(join(root, path), "a".repeat(65536) + "\nlast");
    const first = readEvidenceRange(root, index, {path});
    expect(first).toMatchObject({endLine: 1, nextLine: 2, truncated: true});
    expect(first.nextColumn).toBeUndefined();
    expect(readEvidenceRange(root, index, {path, startLine: first.nextLine!}).text).toBe("last");
    writeFileSync(join(root, path), "a".repeat(65535) + "😀\nlast");
    const partial = readEvidenceRange(root, index, {path});
    expect(partial).toMatchObject({endLine: 1, nextLine: 1, nextColumn: 65536});
    const rest = readEvidenceRange(root, index, {path, startLine: partial.nextLine!, startColumn: partial.nextColumn});
    expect(rest).toMatchObject({text: "😀\nlast", endLine: 2, truncated: false, nextLine: null});
  }));

  test("search counts exact limits and bounds unavailable results", () => withEvidence((root, index) => {
    const path = index.files[0];
    writeFileSync(join(root, path), Array(100).fill("match").join("\n"));
    expect(searchEvidence(root, index, {query: "match", maxMatches: 100})).toMatchObject({truncated: false});
    expect(searchEvidence(root, index, {query: "match", maxMatches: 100}).matches).toHaveLength(100);
    const missing = {files: Array.from({length: 100}, (_, i) => `${i}-${"x".repeat(1000)}`)};
    const found = searchEvidence(root, missing, {query: "match"});
    expect(found.truncated).toBe(true);
    expect(found.unavailable.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(65536);
  }));

  test("bounds lines, matches, excerpts and serialized search output", () => withEvidence((root, index) => {
    const path = index.files[0];
    writeFileSync(join(root, path), ("😀".repeat(600) + "\n").repeat(1100));
    expect(readEvidenceRange(root, index, {path}).truncated).toBe(true);
    const search = searchEvidence(root, index, {query: "😀", maxMatches: 100});
    expect(search.truncated).toBe(true);
    expect(search.matches.length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(search))).toBeLessThanOrEqual(65536);
    for (const match of search.matches) expect([...match.text]).toHaveLength(512);
    expect(searchEvidence(root, index, {query: "😀"}).matches).toHaveLength(20);
    writeFileSync(join(root, path), "x\n".repeat(1100));
    expect(readEvidenceRange(root, index, {path}).endLine).toBe(200);
    expect(readEvidenceRange(root, index, {path, maxLines: 1000}).nextLine).toBe(1001);
    writeFileSync(join(root, path), "");
    expect(readEvidenceRange(root, index, {path})).toMatchObject({text: "", totalLines: 1, truncated: false, nextLine: null});
  }));
});

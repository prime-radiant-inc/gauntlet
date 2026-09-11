import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";

export type EvidenceIndex = { files: string[] };

function containedRegularFile(root: string, path: string, label: string): string {
  if (isAbsolute(path)) {
    throw new Error(`${label} path must be relative`);
  }

  const workspace = realpathSync(root);
  const target = realpathSync(resolve(workspace, path));
  const fromWorkspace = relative(workspace, target);
  if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromWorkspace)) {
    throw new Error(`${label} path escapes the workspace`);
  }
  if (!statSync(target).isFile()) {
    throw new Error(`${label} target must be a regular file`);
  }
  return target;
}

export function readWorkspaceFile(root: string, path: string): string {
  return readFileSync(containedRegularFile(root, path, "read_workspace_file"), "utf8");
}

function assertNormalizedEvidencePath(path: string): void {
  if (path === "" || isAbsolute(path)) {
    throw new Error("Evidence index paths must be nonempty relative paths");
  }
  if (normalize(path) !== path || path === "." || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Evidence index path must be normalized without traversal: ${path}`);
  }
}

export function parseEvidenceIndex(value: unknown): EvidenceIndex {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { files?: unknown }).files)) {
    throw new Error("Evidence index must be an object with a files array");
  }
  const files = (value as { files: unknown[] }).files;
  if (!files.every((path) => typeof path === "string")) {
    throw new Error("Evidence index files must contain only strings");
  }
  return { files: files as string[] };
}

export function validateEvidenceIndex(root: string, index: EvidenceIndex): void {
  const seen = new Set<string>();
  for (const path of index.files) {
    assertNormalizedEvidencePath(path);
    if (seen.has(path)) throw new Error(`Evidence index contains duplicate path: ${path}`);
    seen.add(path);

    const lexicalTarget = resolve(realpathSync(root), path);
    if (lstatSync(lexicalTarget).isSymbolicLink()) {
      throw new Error(`Evidence index path must not be a symbolic link: ${path}`);
    }
    containedRegularFile(root, path, "read_evidence");
  }
}

export function readEvidenceFile(root: string, index: EvidenceIndex, path: string): string {
  assertNormalizedEvidencePath(path);
  if (!index.files.includes(path)) {
    throw new Error(`Evidence path is not listed in the index: ${path}`);
  }
  validateEvidenceIndex(root, index);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    readFileSync(containedRegularFile(root, path, "read_evidence")),
  );
}


export type EvidenceRange = {
  path: string; startLine: number; endLine: number; totalLines: number;
  text: string; truncated: boolean; nextLine: number | null; nextColumn?: number;
};

const EVIDENCE_BYTE_LIMIT = 65536;

export function readEvidenceRange(root: string, index: EvidenceIndex,
  request: {path: string; startLine?: number; maxLines?: number; startColumn?: number}): EvidenceRange {
  const source = readEvidenceFile(root, index, request.path);
  const lines = source.split("\n");
  const startLine = request.startLine ?? 1;
  const maxLines = request.maxLines ?? 200;
  const startColumn = request.startColumn ?? 1;
  if (!Number.isSafeInteger(startLine) || startLine < 1 || startLine > lines.length ||
      !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 1000 ||
      !Number.isSafeInteger(startColumn) || startColumn < 1 || startColumn > lines[startLine - 1].length + 1) {
    throw new Error("invalid evidence range");
  }
  const firstLine = lines[startLine - 1];
  // A UTF-16 position inside a surrogate pair is not a source character boundary.
  const previous = firstLine.charCodeAt(startColumn - 2);
  const current = firstLine.charCodeAt(startColumn - 1);
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
    throw new Error("invalid evidence range: startColumn splits a Unicode code point");
  }
  const selectedEnd = Math.min(lines.length, startLine + maxLines - 1);
  const selected = lines.slice(startLine - 1, selectedEnd).join("\n").slice(startColumn - 1);
  let text = "";
  let bytes = 0;
  let line = startLine;
  let column = startColumn;
  for (const character of selected) {
    const size = Buffer.byteLength(character);
    if (bytes + size > EVIDENCE_BYTE_LIMIT) break;
    text += character;
    bytes += size;
    if (character === "\n") { line++; column = 1; }
    else column += character.length;
  }
  const partial = text.length < selected.length;
  // If the byte cap falls immediately before a line separator, the current
  // line is complete; callers join whole-line ranges with that separator.
  const partialLine = partial && column <= lines[line - 1].length;
  const nextLine = partialLine ? line : partial ? line + 1 : selectedEnd < lines.length ? selectedEnd + 1 : null;
  return {
    path: request.path, startLine, endLine: line, totalLines: lines.length,
    text, truncated: nextLine !== null, nextLine,
    ...(partialLine ? {nextColumn: column} : {}),
  };
}

export function searchEvidence(root: string, index: EvidenceIndex,
  request: {query: string; path?: string; maxMatches?: number}): {
    matches: {path: string; line: number; text: string}[];
    truncated: boolean; unavailable: {path: string; reason: string}[];
  } {
  const maxMatches = request.maxMatches ?? 20;
  if (typeof request.query !== "string" || request.query.length === 0 ||
      !Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 100) {
    throw new Error("invalid evidence search");
  }
  const result: ReturnType<typeof searchEvidence> = { matches: [], truncated: false, unavailable: [] };
  // Reserve the larger boolean spelling so toggling truncation cannot exceed the cap.
  let bytes = Buffer.byteLength(JSON.stringify(result));
  function fits(entry: unknown, count: number): boolean {
    const size = Buffer.byteLength(JSON.stringify(entry)) + (count > 0 ? 1 : 0);
    if (bytes + size > EVIDENCE_BYTE_LIMIT) { result.truncated = true; return false; }
    bytes += size;
    return true;
  }
  for (const path of request.path !== undefined ? [request.path] : index.files) {
    let source: string;
    try { source = readEvidenceFile(root, index, path); }
    catch (error) {
      const unavailable = {path, reason: error instanceof Error ? error.message : String(error)};
      if (!fits(unavailable, result.unavailable.length)) break;
      result.unavailable.push(unavailable);
      continue;
    }
    for (const [offset, line] of source.split("\n").entries()) {
      if (!line.includes(request.query)) continue;
      if (result.matches.length === maxMatches) { result.truncated = true; return result; }
      let text = "";
      let characters = 0;
      for (const character of line) {
        if (characters === 512) break;
        text += character;
        characters++;
      }
      const match = {path, line: offset + 1, text};
      if (!fits(match, result.matches.length)) return result;
      result.matches.push(match);
      if (text.length < line.length) result.truncated = true;
    }
  }
  return result;
}

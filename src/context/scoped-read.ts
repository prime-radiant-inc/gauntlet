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
  return readFileSync(containedRegularFile(root, path, "read_evidence"), "utf8");
}

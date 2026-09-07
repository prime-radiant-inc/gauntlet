import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function readWorkspaceFile(root: string, path: string): string {
  if (isAbsolute(path)) {
    throw new Error("read_workspace_file path must be relative to the workspace");
  }

  const workspace = realpathSync(root);
  const target = realpathSync(resolve(workspace, path));
  const fromWorkspace = relative(workspace, target);
  if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromWorkspace)) {
    throw new Error("read_workspace_file path escapes the workspace");
  }
  if (!statSync(target).isFile()) {
    throw new Error("read_workspace_file target must be a regular file");
  }
  return readFileSync(target, "utf8");
}

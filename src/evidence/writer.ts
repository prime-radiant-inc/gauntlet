import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { VetResult, Observation } from "../types";

export function writeResultFiles(
  outDir: string,
  result: VetResult,
  writeFile: (path: string, text: string) => void = writeFileSync,
): void {
  // Write result.json
  writeFile(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");

  // Write result.md — human-readable summary
  writeFile(join(outDir, "result.md"), renderResultMarkdown(result));

  // Write individual issue files
  if (result.observations.length > 0) {
    const issuesDir = join(outDir, "issues");
    mkdirSync(issuesDir, { recursive: true });
    for (let i = 0; i < result.observations.length; i++) {
      const obs = result.observations[i];
      const num = String(i + 1).padStart(3, "0");
      const slug = obs.description.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
      const filename = `${num}-${obs.kind}-${slug}.md`;
      writeFile(join(issuesDir, filename), renderObservationMarkdown(obs, result));
    }
  }
}

function renderResultMarkdown(result: VetResult): string {
  const lines: string[] = [];
  lines.push(`# Test Result: ${result.scenario}`);
  lines.push("");
  lines.push(`**Status:** ${result.status}`);
  lines.push(`**Duration:** ${(result.duration_ms / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(result.summary);
  lines.push("");
  lines.push(`## Reasoning`);
  lines.push("");
  lines.push(result.reasoning);
  if (result.observations.length > 0) {
    lines.push("");
    lines.push(`## Observations (${result.observations.length})`);
    lines.push("");
    for (const obs of result.observations) {
      lines.push(`- **[${obs.kind}]** ${obs.description}`);
    }
  }
  if (result.evidence.screenshots.length > 0) {
    lines.push("");
    lines.push(`## Evidence`);
    lines.push("");
    for (const s of result.evidence.screenshots) {
      lines.push(`- ${s}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderObservationMarkdown(obs: Observation, result: VetResult): string {
  const lines: string[] = [];
  lines.push(`# ${obs.kind.charAt(0).toUpperCase() + obs.kind.slice(1)}: ${obs.description}`);
  lines.push("");
  lines.push(`**Kind:** ${obs.kind}`);
  lines.push(`**Scenario:** ${result.scenario}`);
  lines.push(`**Scenario Status:** ${result.status}`);
  lines.push("");
  lines.push(`## Description`);
  lines.push("");
  lines.push(obs.description);
  if (obs.evidence && obs.evidence.length > 0) {
    lines.push("");
    lines.push(`## Evidence`);
    lines.push("");
    for (const e of obs.evidence) {
      lines.push(`- ${e}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

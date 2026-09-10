import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLogger } from "../../src/evidence/logger";
import { createAssessmentAttemptJournal } from "../../src/models/assessment-request";
import type { LLMClient, Provider } from "../../src/models/provider";

export function attemptRows(outDir: string, file = "assessment-attempts.jsonl") {
  const path = join(outDir, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

// Real pinned SDKs, with every network request confined to this local server.
export function withAssessmentFixture(options: {
  provider: Provider;
  env(baseURL: string): Record<string, string | undefined>;
  createClient(model: string): LLMClient;
  model: string;
}) {
  return async (
    handler: (request: Request, index: number) => Response | Promise<Response>,
    run: (fixture: {
      client: LLMClient;
      outDir: string;
      journal: ReturnType<typeof createAssessmentAttemptJournal>;
      expire(): void;
    }) => Promise<void>,
  ) => {
    let requests = 0;
    let time = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler(request, requests++) });
    const environment = options.env(String(server.url));
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    const outDir = mkdtempSync(join(tmpdir(), `${options.provider}-assessment-`));
    try {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      const client = options.createClient(options.model);
      const journal = createAssessmentAttemptJournal({
        outDir, provider: options.provider, model: options.model,
        workDeadlineAtMs: 115_000, now: () => time, fetch, maxPhysicalAttempts: 3,
        captureBodies: true, logger: new EvidenceLogger(outDir),
      });
      await run({ client, journal, outDir, expire() { time = 115_000; } });
    } finally {
      server.stop(true);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(outDir, { recursive: true, force: true });
    }
  };
}

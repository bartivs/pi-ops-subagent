/**
 * Shared hermetic runner test harness: builds a temp config/catalog and an
 * invocation override pointed at the fake pi relay, plus snapshot assertions.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/config.ts";
import { discoverCatalog } from "../extensions/catalog.ts";
import type { ChildInvocation, TaskRunRequest, RunOutcome } from "../extensions/runner.ts";
import { runOneTask } from "../extensions/runner.ts";
import { snapshotRuns, resetRegistry } from "../extensions/observability.ts";

export const FAKE_PI = path.join(import.meta.dirname, "fixtures", "fake-pi.mjs");

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-runner-"));
}

export interface FixtureEnv {
  root: string;
  config: ReturnType<typeof loadConfig>;
  catalog: ReturnType<typeof discoverCatalog>;
  bundledDir: string;
  userDir: string;
}

export function makeFixture(agentOverrides: Record<string, string> = {}): FixtureEnv {
  const root = tmpdir();
  const bundledDir = path.join(root, "agents");
  const userDir = path.join(root, "user-agents");
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  writeAgent(bundledDir, "probe-host", {
    kind: "probe",
    tools: "read, grep, find, ls, probe_exec",
    ...(agentOverrides["probe-host"] ? { promptBody: agentOverrides["probe-host"] } : {}),
  });
  writeAgent(bundledDir, "general", { kind: "general", tools: "read, bash", description: "general agent" });
  if (agentOverrides["general"]) {
    writeAgent(bundledDir, "general", { kind: "general", tools: "read, bash", description: "general agent", promptBody: agentOverrides["general"] });
  }
  const config = loadConfig(root);
  const catalog = discoverCatalog(config, true, { bundledAgentsDir: bundledDir, userAgentsDir: userDir });
  return { root, config, catalog, bundledDir, userDir };
}

export function writeAgent(dir: string, name: string, opts: { kind?: string; tools?: string; description?: string; model?: string; timeoutSeconds?: number; promptBody?: string } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [
    `name: ${name}`,
    `description: ${opts.description ?? `${name} agent`}`,
  ];
  if (opts.kind) lines.push(`kind: ${opts.kind}`);
  if (opts.tools) lines.push(`tools: ${opts.tools}`);
  if (opts.timeoutSeconds !== undefined) lines.push(`timeoutSeconds: ${opts.timeoutSeconds}`);
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---\n${lines.join("\n")}\n---\n\n${opts.promptBody ?? `You are the ${name} agent.`}\n`);
  return file;
}

/** Invocation override: run the fake pi relay so it sees the real child argv. */
export function fakeInvocation(): ChildInvocation {
  return { command: process.execPath, prefixArgs: [FAKE_PI] };
}

export function tmpReport(root: string, name: string): string {
  return path.join(root, `report-${name}.json`);
}

export function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export interface ExecResult {
  outcome: RunOutcome;
  lifecycle: string[];
  snapshotsAfter: ReturnType<typeof snapshotRuns>;
}

/** Run one task with fixture env and optional abort signal; resets registry. */
export async function execReq(
  req: TaskRunRequest,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const lifecycle: string[] = [];
  const saved = { ...process.env };
  let snapshotsAfter: ReturnType<typeof snapshotRuns> = [];
  try {
    Object.assign(process.env, env);
    const outcome = await runOneTask(req, signal, (runId) => {
      const snap = snapshotRuns().find((r) => r.runId === runId);
      if (snap) lifecycle.push(snap.state);
    });
    snapshotsAfter = snapshotRuns();
    return { outcome, lifecycle, snapshotsAfter };
  } finally {
    process.env = saved;
    resetRegistry();
  }
}
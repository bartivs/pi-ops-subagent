/**
 * Background jobs and scheduler (background-jobs spec, design D6).
 *
 * - `runAsync: true` creates a durable job record (registry.json) BEFORE the
 *   jobId is returned; work runs under the owning pi process.
 * - Exact durable registry: version 1, per-job records with immutable spec,
 *   agent names, timestamps, owner pid, schedule, `nextRunAt`,
 *   `resumedFromJobId`, and artifact directory. Writes are same-directory
 *   temp file + fsync + atomic rename; corrupt registries fail closed with
 *   the file preserved.
 * - Job states: queued | running | done | failed | interrupted | canceled.
 *   Startup reconciliation marks stale `running` records `interrupted` and
 *   preserves partial artifacts.
 * - Per-job artifacts `<runsDir>/<jobId>/{meta.json,digest.md,evidence.jsonl,
 *   usage.json}`, mode 0600.
 * - Schedules: exactly one of `intervalSec >= 60` or RFC3339 `at`; `nextRunAt`
 *   persisted; 10,000 ms tick only while pi runs; overdue runs fire once.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { JobId, JobRecord, JobSchedule, RunMode, UsageSummary } from "./types.ts";
import type { JobState } from "./constants.ts";
import type { OpsConfig } from "./config.ts";
import { resolveRunsDir } from "./config.ts";
import {
  JOB_ARTIFACT_FILES,
  JOB_ARTIFACT_MODE,
  JOB_ID_PREFIX,
  JOB_STATES,
  MIN_INTERVAL_SECONDS,
  REGISTRY_FILE,
  SCHEDULER_TICK_MS,
} from "./constants.ts";
import type { SubagentCall } from "./tool-schema.ts";
import { itemsOf } from "./runner.ts";

export class JobError extends Error {
  constructor(message: string, public readonly category: "registry" | "unknown" | "invalid-state" | "schedule") {
    super(message);
    this.name = "JobError";
  }
}

export function newJobId(): JobId {
  return `${JOB_ID_PREFIX}${randomUUID()}` as JobId;
}

export function isJobState(s: string): s is JobState {
  return (JOB_STATES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Registry (strict parser + atomic writer)
// ---------------------------------------------------------------------------

export interface JobRegistry {
  version: 1;
  jobs: JobRecord[];
}

export function emptyRegistry(): JobRegistry {
  return { version: 1, jobs: [] };
}

export function registryPath(runsDir: string): string {
  return path.join(runsDir, REGISTRY_FILE);
}

/** Strict parser: corrupt/version-mismatched registries fail closed. */
export function parseRegistry(runsDir: string): { registry: JobRegistry; error: string | null } {
  const file = registryPath(runsDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { registry: emptyRegistry(), error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { registry: emptyRegistry(), error: `registry.json is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1 || !Array.isArray((parsed as { jobs?: unknown }).jobs)) {
    return { registry: emptyRegistry(), error: "registry.json has an unsupported shape or version (expected version 1 with a jobs array)" };
  }
  const jobs = (parsed as { jobs: unknown[] }).jobs;
  const validJobs: JobRecord[] = [];
  for (const j of jobs) {
    if (!isJobRecord(j)) {
      return { registry: emptyRegistry(), error: "registry.json contains an invalid job record" };
    }
    validJobs.push(j);
  }
  return { registry: { version: 1, jobs: validJobs }, error: null };
}

function isJobRecord(j: unknown): j is JobRecord {
  if (typeof j !== "object" || j === null) return false;
  const r = j as Record<string, unknown>;
  return (
    typeof r["jobId"] === "string" &&
    isJobState(r["state"] as string) &&
    typeof r["spec"] === "object" &&
    Array.isArray(r["agents"])
  );
}

export function loadRegistry(runsDir: string): JobRegistry {
  return parseRegistry(runsDir).registry;
}

/** Same-directory temp file + fsync + atomic rename. */
export function saveRegistryAtomic(runsDir: string, registry: JobRegistry): void {
  fs.mkdirSync(runsDir, { recursive: true });
  const tmp = path.join(runsDir, `.registry.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w", JOB_ARTIFACT_MODE);
  try {
    fs.writeFileSync(fd, JSON.stringify(registry, null, 2), "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync not supported everywhere */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, registryPath(runsDir));
}

// ---------------------------------------------------------------------------
// Job record helpers
// ---------------------------------------------------------------------------

export function getJob(runsDir: string, jobId: string): JobRecord | null {
  const { registry, error } = parseRegistry(runsDir);
  if (error) throw new JobError(`registry unavailable: ${error}`, "registry");
  return registry.jobs.find((j) => j.jobId === jobId) ?? null;
}

function upsert(runsDir: string, job: JobRecord): JobRegistry {
  const { registry, error } = parseRegistry(runsDir);
  if (error) throw new JobError(`registry unavailable: ${error}`, "registry");
  const idx = registry.jobs.findIndex((j) => j.jobId === job.jobId);
  if (idx === -1) registry.jobs.push(job);
  else registry.jobs[idx] = job;
  saveRegistryAtomic(runsDir, registry);
  return registry;
}

export function setJobState(runsDir: string, jobId: string, state: JobState, patch: Partial<Pick<JobRecord, "startedAt" | "finishedAt" | "error" | "nextRunAt">> = {}): JobRecord | null {
  const job = getJob(runsDir, jobId);
  if (!job) throw new JobError(`Unknown job "${jobId}".`, "unknown");
  const next: JobRecord = { ...job, state, ...patch };
  if (state === "running" && !next.startedAt) next.startedAt = new Date().toISOString();
  if (state === "done" || state === "failed" || state === "canceled" || state === "interrupted") {
    next.finishedAt = patch.finishedAt ?? new Date().toISOString();
  }
  upsert(runsDir, next);
  return next;
}

// ---------------------------------------------------------------------------
// Job creation
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  runsDir: string;
  spec: SubagentCall;
  schedule: JobSchedule | null;
  resumedFromJobId: JobId | null;
  agentNames: string[];
  mode: RunMode;
}

export function createJobRecord(input: CreateJobInput): JobRecord {
  const job: JobRecord = {
    jobId: newJobId(),
    state: "queued",
    spec: input.spec as unknown as Record<string, unknown>,
    mode: input.mode,
    agents: input.agentNames,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    ownerPid: process.pid,
    schedule: input.schedule,
    nextRunAt: input.schedule ? computeNextRunAt(input.schedule) : null,
    resumedFromJobId: input.resumedFromJobId,
    artifactDir: null,
    error: null,
  };
  upsert(input.runsDir, job);
  return job;
}

export function computeNextRunAt(schedule: JobSchedule): string {
  if (schedule.kind === "once") return schedule.at;
  return new Date(Date.now() + schedule.intervalSec * 1000).toISOString();
}

export function scheduleIsValid(schedule: unknown): schedule is JobSchedule {
  if (typeof schedule !== "object" || schedule === null) return false;
  const s = schedule as Record<string, unknown>;
  const hasInterval = "intervalSec" in s;
  const hasAt = "at" in s;
  if (hasInterval === hasAt) return false;
  if (hasInterval) {
    return typeof s["intervalSec"] === "number" && Number.isInteger(s["intervalSec"]) && s["intervalSec"] >= MIN_INTERVAL_SECONDS;
  }
  if (hasAt) {
    return typeof s["at"] === "string" && !Number.isNaN(Date.parse(s["at"])) && /[Z]|[+-]\d{2}:\d{2}$/.test(s["at"]);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface JobArtifacts {
  digestText: string;
  evidenceLines: unknown[];
  usage: { perRun: UsageSummary[]; aggregate: UsageSummary };
  meta: Record<string, unknown>;
}

export function writeJobArtifacts(runsDir: string, job: JobRecord, artifacts: JobArtifacts): string {
  const dir = path.join(runsDir, job.jobId);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name: string, content: string) => {
    const file = path.join(dir, name);
    const fd = fs.openSync(file, "w", JOB_ARTIFACT_MODE);
    try {
      fs.writeFileSync(fd, content, "utf8");
      try {
        fs.fsyncSync(fd);
      } catch {
        /* ignore */
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  write("meta.json", JSON.stringify({ ...artifacts.meta, artifactDir: dir }, null, 2));
  write("digest.md", artifacts.digestText);
  write("evidence.jsonl", artifacts.evidenceLines.map((l) => JSON.stringify(l)).join("\n"));
  write("usage.json", JSON.stringify(artifacts.usage, null, 2));
  upsert(runsDir, { ...job, artifactDir: dir });
  return dir;
}

export function artifactPath(runsDir: string, jobId: string, file: string): string {
  return path.join(runsDir, jobId, file);
}

// ---------------------------------------------------------------------------
// Execution runtime (injected by index.ts to avoid import cycles)
// ---------------------------------------------------------------------------

export interface JobRuntime {
  runsDir: string;
  runCall: (spec: SubagentCall, signal: AbortSignal, parentJobId: JobId) => Promise<{
    digestText: string;
    evidenceLines: unknown[];
    usage: { perRun: UsageSummary[]; aggregate: UsageSummary };
  }>;
}

/** In-process controllers so `cancel` can abort live work. */
const jobControllers = new Map<string, AbortController>();
const cancelRequests = new Set<string>();
let tickTimer: NodeJS.Timeout | null = null;

export function activeJobCount(runtime: JobRuntime): number {
  void runtime;
  return 0;
}

/** Queue a job for execution under the owning pi process (fire-and-forget). */
export function queueJobExecution(job: JobRecord, runtime: JobRuntime): void {
  void executeJob(job.jobId, runtime);
}

async function executeJob(jobId: string, runtime: JobRuntime): Promise<void> {
  const initial = getJob(runtime.runsDir, jobId);
  if (!initial || initial.state !== "queued") return;

  const controller = new AbortController();
  jobControllers.set(jobId, controller);
  const running = setJobState(runtime.runsDir, jobId, "running", { startedAt: new Date().toISOString() })!;
  try {
    const result = await runtime.runCall(running.spec as unknown as SubagentCall, controller.signal, running.jobId);
    const job = getJob(runtime.runsDir, jobId);
    if (!job) return;
    const dir = writeJobArtifacts(runtime.runsDir, job, {
      digestText: result.digestText,
      evidenceLines: result.evidenceLines,
      usage: result.usage,
      meta: {
        jobId: job.jobId,
        spec: job.spec,
        state: job.state,
        mode: job.mode,
        agents: job.agents,
        createdAt: job.createdAt,
        resumedFromJobId: job.resumedFromJobId,
        schedule: job.schedule,
      },
    });
    if (cancelRequests.has(jobId)) {
      cancelRequests.delete(jobId);
      setJobState(runtime.runsDir, jobId, "canceled", { finishedAt: new Date().toISOString() });
      return;
    }
    const done = setJobState(runtime.runsDir, jobId, "done", { finishedAt: new Date().toISOString() })!;
    void dir;
    scheduleNext(jobId, done, runtime);
  } catch (e) {
    if (cancelRequests.has(jobId)) {
      cancelRequests.delete(jobId);
      setJobState(runtime.runsDir, jobId, "canceled", { finishedAt: new Date().toISOString() });
      return;
    }
    const msg = (e as Error).message.slice(0, 2000);
    setJobState(runtime.runsDir, jobId, "failed", { error: msg, finishedAt: new Date().toISOString() });
  } finally {
    jobControllers.delete(jobId);
  }
}

/** Interval jobs schedule their next run after completion. */
function scheduleNext(jobId: string, job: JobRecord, runtime: JobRuntime): void {
  if (job.schedule?.kind !== "interval") return;
  const nextRunAt = new Date(Date.now() + job.schedule.intervalSec * 1000).toISOString();
  const updated = getJob(runtime.runsDir, jobId);
  if (!updated) return;
  upsert(runtime.runsDir, { ...updated, nextRunAt });
}

// ---------------------------------------------------------------------------
// Cancel / resume / reconciliation
// ---------------------------------------------------------------------------

/** Cancel: queued never spawns; running receives the runner termination ladder. */
export function cancelJob(runsDir: string, jobId: string): JobRecord {
  const job = getJob(runsDir, jobId);
  if (!job) throw new JobError(`Unknown job "${jobId}". Use /ops:jobs list to see valid ids.`, "unknown");
  if (job.state === "queued") {
    return setJobState(runsDir, jobId, "canceled", { finishedAt: new Date().toISOString() })!;
  }
  if (job.state === "running") {
    cancelRequests.add(jobId);
    jobControllers.get(jobId)?.abort();
    return getJob(runsDir, jobId)!;
  }
  throw new JobError(`Cannot cancel job "${jobId}" in state ${job.state}.`, "invalid-state");
}

/** Resume: new id + `resumedFromJobId`, from the immutable stored spec. */
export function resumeJob(runsDir: string, jobId: string, mode: RunMode, agentNames: string[]): JobRecord {
  const job = getJob(runsDir, jobId);
  if (!job) throw new JobError(`Unknown job "${jobId}". Use /ops:jobs list to see valid ids.`, "unknown");
  if (job.state !== "interrupted" && job.state !== "failed") {
    throw new JobError(`Cannot resume job "${jobId}" in state ${job.state} (interrupted/failed only).`, "invalid-state");
  }
  return createJobRecord({
    runsDir,
    spec: job.spec as unknown as SubagentCall,
    schedule: job.schedule,
    resumedFromJobId: job.jobId,
    agentNames,
    mode,
  });
}

/** Startup reconciliation: stale `running` records become `interrupted`. */
export function reconcileStartup(runsDir: string): Array<{ jobId: string; from: JobState; to: "interrupted" }> {
  const { registry, error } = parseRegistry(runsDir);
  if (error) return [];
  let changed = false;
  const results: Array<{ jobId: string; from: JobState; to: "interrupted" }> = [];
  for (const job of registry.jobs) {
    if (job.state === "running" && job.ownerPid !== process.pid) {
      job.state = "interrupted";
      job.finishedAt = new Date().toISOString();
      changed = true;
      results.push({ jobId: job.jobId, from: "running", to: "interrupted" });
    }
  }
  if (changed) saveRegistryAtomic(runsDir, registry);
  return results;
}

/** Overdue schedule trigger: exactly one run per overdue job, then advance. */
export function triggerDueJobs(runsDir: string, modeFor: (spec: SubagentCall) => { mode: RunMode; agentNames: string[] }): JobRecord[] {
  const { registry, error } = parseRegistry(runsDir);
  if (error) return [];
  const due: JobRecord[] = [];
  const now = Date.now();
  for (const job of registry.jobs) {
    if (!job.schedule || job.nextRunAt === null) continue;
    if (Date.parse(job.nextRunAt) > now) continue;
    if (job.schedule.kind === "interval") {
      // overdue intervals fire once and advance from the current time
      const { mode, agentNames } = modeFor(job.spec as unknown as SubagentCall);
      const next = createJobRecord({
        runsDir,
        spec: job.spec as unknown as SubagentCall,
        schedule: job.schedule,
        resumedFromJobId: null,
        agentNames,
        mode,
      });
      upsert(runsDir, { ...job, nextRunAt: new Date(now + job.schedule.intervalSec * 1000).toISOString() });
      due.push(next);
    } else {
      // overdue one-shot fires once and the schedule completes
      const { mode, agentNames } = modeFor(job.spec as unknown as SubagentCall);
      const next = createJobRecord({
        runsDir,
        spec: job.spec as unknown as SubagentCall,
        schedule: null,
        resumedFromJobId: null,
        agentNames,
        mode,
      });
      upsert(runsDir, { ...job, nextRunAt: null });
      due.push(next);
    }
  }
  return due;
}

// ---------------------------------------------------------------------------
// Scheduler tick (session-scoped; index.ts starts/stops it)
// ---------------------------------------------------------------------------

export function startScheduler(runtime: JobRuntime, modeFor: (spec: SubagentCall) => { mode: RunMode; agentNames: string[] }): void {
  stopScheduler();
  tickTimer = setInterval(() => {
    try {
      const due = triggerDueJobs(runtime.runsDir, modeFor);
      for (const job of due) queueJobExecution(job, runtime);
    } catch {
      /* tick errors must not kill pi */
    }
  }, SCHEDULER_TICK_MS);
  tickTimer.unref?.();
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// ---------------------------------------------------------------------------
// /ops:jobs report (pure formatter)
// ---------------------------------------------------------------------------

export function formatJobsReport(runsDir: string): string {
  const { registry, error } = parseRegistry(runsDir);
  const lines: string[] = [];
  if (error) {
    lines.push(`ops:jobs — registry unavailable: ${registryPath(runsDir)}`);
    lines.push(`  parse error: ${error}`);
    lines.push("  The corrupt file was preserved; scheduling is disabled until it is repaired or removed.");
    return lines.join("\n");
  }
  const jobs = [...registry.jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (jobs.length === 0) {
    lines.push("ops:jobs — no jobs (run the subagent tool with runAsync: true to create one).");
    return lines.join("\n");
  }
  lines.push("ops:jobs — durable registry");
  for (const job of jobs) {
    lines.push(`# ${job.jobId} [${job.state}]`);
    lines.push(`  agents: ${job.agents.join(", ")}`);
    lines.push(`  created: ${job.createdAt}`);
    lines.push(`  started: ${job.startedAt ?? "-"}`);
    lines.push(`  finished: ${job.finishedAt ?? "-"}`);
    if (job.schedule) {
      const s = job.schedule.kind === "interval" ? `interval ${job.schedule.intervalSec}s` : `at ${job.schedule.at}`;
      lines.push(`  schedule: ${s}`);
      lines.push(`  next run: ${job.nextRunAt ?? "complete"}`);
    }
    lines.push(`  artifacts: ${job.artifactDir ?? "-"}`);
    if (job.resumedFromJobId) lines.push(`  resumed from: ${job.resumedFromJobId}`);
    if (job.error) lines.push(`  error: ${job.error}`);
  }
  return lines.join("\n");
}

export function formatJobInspect(runsDir: string, jobId: string): string {
  const job = getJob(runsDir, jobId);
  if (!job) return `ops:jobs — unknown job "${jobId}". Use /ops:jobs list to see valid ids.`;
  return JSON.stringify(job, null, 2);
}

export function assertJobArtifactsExist(runsDir: string, jobId: string): void {
  for (const file of JOB_ARTIFACT_FILES) {
    const p = artifactPath(runsDir, jobId, file);
    if (!fs.existsSync(p)) {
      throw new JobError(`Job "${jobId}" artifact missing: ${file}`, "invalid-state");
    }
  }
}

export function jobsForReconciliation(runsDir: string): JobRecord[] {
  return loadRegistry(runsDir).jobs;
}
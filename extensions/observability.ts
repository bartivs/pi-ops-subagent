/**
 * Fleet observability registry (design D8 / fleet-cockpit + subagent-runner
 * structured run details).
 *
 * - Stable `run-<UUID v4>` identity per delegated task.
 * - Normalized lifecycle with the exact transition table:
 *   `queued -> starting -> running -> finalizing -> done`; any non-terminal
 *   state MAY move to `failed | timed_out | aborted`; terminal states never
 *   transition (immutable terminal snapshots).
 * - Bounded redacted activity (200 events) and output tail (100 lines x
 *   2,000 bytes per line).
 * - Stale flagging, retention/dismissal (display only — durable job records
 *   are untouched), and a snapshot API used by the widget, overlay, tool
 *   renderer, `/ops:status`, and headless tool details.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentSourceKind,
  JobId,
  RunId,
  RunMode,
  RunSnapshot,
  StopReason,
  UsageSummary,
} from "./types.ts";
import type { FleetState } from "./constants.ts";
import {
  ACTIVITY_LIMIT,
  FLEET_STATES,
  OUTPUT_TAIL_LINE_BYTES,
  OUTPUT_TAIL_LINES,
  RUN_ID_PREFIX,
  TERMINAL_FLEET_STATES,
} from "./constants.ts";
import { emptyUsage } from "./types.ts";
import { redactSensitive } from "./redact.ts";

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

const FAILURE_STATES: ReadonlySet<FleetState> = new Set(["failed", "timed_out", "aborted"]);

function isValidState(s: string): s is FleetState {
  return (FLEET_STATES as readonly string[]).includes(s);
}

const TRANSITIONS: Record<FleetState, ReadonlySet<FleetState>> = {
  queued: new Set(["starting", "failed", "timed_out", "aborted"]),
  starting: new Set(["running", "failed", "timed_out", "aborted"]),
  running: new Set(["finalizing", "failed", "timed_out", "aborted"]),
  finalizing: new Set(["done", "failed", "timed_out", "aborted"]),
  done: new Set(),
  failed: new Set(),
  timed_out: new Set(),
  aborted: new Set(),
};

export interface RunInit {
  mode: RunMode;
  agent: string;
  agentSource: AgentSourceKind | null;
  manifestPath: string | null;
  taskLabel: string;
  cwd: string;
  model: string | null;
  timeoutRequestedSeconds: number | null;
  timeoutEffectiveSeconds: number | null;
  timeoutClamped: boolean;
  inputIndex?: number | null;
  chainStep?: number | null;
  queueReason?: string | null;
  parentJobId?: string | null;
  sessionKey?: string | null;
}

export function newRunId(): RunId {
  return `${RUN_ID_PREFIX}${randomUUID()}` as RunId;
}

export function makeRunSnapshot(init: RunInit): RunSnapshot {
  return {
    runId: newRunId(),
    state: "queued",
    mode: init.mode,
    inputIndex: init.inputIndex ?? null,
    chainStep: init.chainStep ?? null,
    agent: init.agent,
    agentSource: init.agentSource,
    manifestPath: init.manifestPath,
    taskLabel: init.taskLabel,
    cwd: init.cwd,
    model: init.model,
    timeoutRequestedSeconds: init.timeoutRequestedSeconds,
    timeoutEffectiveSeconds: init.timeoutEffectiveSeconds,
    timeoutClamped: init.timeoutClamped,
    queueReason: init.queueReason ?? null,
    parentJobId: init.parentJobId ?? null,
    sessionKey: init.sessionKey ?? null,
    startedAt: null,
    finishedAt: null,
    lastActivityAt: null,
    elapsedMs: null,
    stopReason: null,
    usage: emptyUsage(),
    activity: [],
    outputTail: [],
    digest: null,
    error: null,
    resultArtifactPath: null,
    stale: false,
    terminal: false,
  };
}

// Registry is session-scoped. index.ts resets it on session_start and
// reconciles durable job state there.
let runs = new Map<RunId, RunSnapshot>();
let dismissed = new Set<RunId>();

export function resetRegistry(): void {
  runs = new Map();
  dismissed = new Set();
}

export function getRun(runId: string): RunSnapshot | undefined {
  const r = runs.get(runId as RunId);
  return r ? structuredClone(r) : undefined;
}

export function snapshotRuns(): RunSnapshot[] {
  return [...runs.values()].map((r) => structuredClone(r));
}

/** Display list: active + retained, minus user-dismissed entries. */
export function displayRuns(): RunSnapshot[] {
  return snapshotRuns().filter((r) => !dismissed.has(r.runId));
}

export function dismissRun(runId: string): boolean {
  if (!runs.has(runId as RunId)) return false;
  dismissed.add(runId as RunId);
  return true;
}

export function createRun(init: RunInit): RunSnapshot {
  const snap = makeRunSnapshot(init);
  runs.set(snap.runId, snap);
  return structuredClone(snap);
}

/**
 * Transition a run's lifecycle. Enforces the exact transition table; terminal
 * snapshots never transition again. Returns the updated snapshot or undefined
 * when the run id is unknown.
 */
export function transition(runId: string, next: FleetState): RunSnapshot | undefined {
  const run = runs.get(runId as RunId);
  if (!run) return undefined;
  if (!TRANSITIONS[run.state as FleetState]?.has(next)) {
    throw new LifecycleError(`Invalid transition ${run.state} -> ${next} for ${runId}`);
  }
  run.state = next;
  if (TERMINAL_FLEET_STATES.has(next)) {
    run.terminal = true;
    run.finishedAt = new Date().toISOString();
    run.elapsedMs = run.startedAt ? Date.now() - Date.parse(run.startedAt) : 0;
    run.stale = false;
  }
  return structuredClone(run);
}

/** Record a bounded, redacted activity event and bump last-activity. */
export function pushActivity(runId: string, kind: string, detail: string): void {
  const run = runs.get(runId as RunId);
  if (!run) return;
  const red = redactSensitive(detail);
  run.activity.push({ timestamp: new Date().toISOString(), kind, detail: red.text });
  if (run.activity.length > ACTIVITY_LIMIT) {
    run.activity.splice(0, run.activity.length - ACTIVITY_LIMIT);
  }
  run.lastActivityAt = new Date().toISOString();
}

/** Append redacted lines to the bounded output tail (100 lines x 2,000 bytes). */
export function pushOutputTail(runId: string, text: string): void {
  const run = runs.get(runId as RunId);
  if (!run) return;
  for (const line of redactSensitive(text).text.split("\n")) {
    let l = line;
    const bytes = Buffer.byteLength(l, "utf8");
    if (bytes > OUTPUT_TAIL_LINE_BYTES) {
      // leave room for a 3-byte ellipsis so the stored line stays in budget
      const budget = OUTPUT_TAIL_LINE_BYTES - 3;
      const buf = Buffer.from(l, "utf8");
      let cut = budget;
      while (cut > 0 && (buf[cut - 1]! & 0xc0) === 0x80) cut--; // back off continuation bytes
      while (cut > 0 && (buf[cut - 1]! & 0xc0) === 0xc0) cut--; // drop a partial lead byte
      l = buf.subarray(0, cut).toString("utf8") + "…";
    }
    run.outputTail.push(l);
  }
  if (run.outputTail.length > OUTPUT_TAIL_LINES) {
    run.outputTail.splice(0, run.outputTail.length - OUTPUT_TAIL_LINES);
  }
}

/** Merge one child usage record into the run total. */
export function addUsage(runId: string, usage: Partial<UsageSummary>): void {
  const run = runs.get(runId as RunId);
  if (!run) return;
  const u = run.usage;
  u.turns += usage.turns ?? 0;
  u.input += usage.input ?? 0;
  u.output += usage.output ?? 0;
  u.cacheRead += usage.cacheRead ?? 0;
  u.cacheWrite += usage.cacheWrite ?? 0;
  u.total += usage.total ?? 0;
  u.reasoning += usage.reasoning ?? 0;
  u.cost += usage.cost ?? 0;
}

export interface FinishInfo {
  state: FleetState;
  stopReason?: StopReason | null;
  digest?: string | null;
  error?: string | null;
  resultArtifactPath?: string | null;
}

/** Terminal transition with final details. Returns false when already terminal. */
export function finishRun(runId: string, info: FinishInfo): boolean {
  const run = runs.get(runId as RunId);
  if (!run) return false;
  if (run.terminal) {
    // Merge final details into the immutable terminal snapshot; the state
    // itself never changes again.
    if (info.state !== run.state) return false;
  } else {
    if (!TERMINAL_FLEET_STATES.has(info.state)) {
      throw new LifecycleError(`finishRun requires a terminal state, got ${info.state}`);
    }
    run.state = info.state;
    run.terminal = true;
    run.finishedAt = new Date().toISOString();
    run.elapsedMs = run.startedAt ? Date.now() - Date.parse(run.startedAt) : 0;
  }
  if (info.stopReason !== undefined && info.stopReason !== null) run.stopReason = info.stopReason;
  if (typeof info.digest === "string" && info.digest.length > 0) {
    run.digest = boundedDigest(info.digest);
  }
  if (typeof info.error === "string") run.error = redactSensitive(info.error).text;
  if (typeof info.resultArtifactPath === "string") run.resultArtifactPath = info.resultArtifactPath;
  return true;
}

/** Non-model-visible storage cap keeps registry memory bounded. */
function boundedDigest(digest: string): string {
  const MAX = 51200; // bytes
  const buf = Buffer.from(digest, "utf8");
  if (buf.length <= MAX) return digest;
  let cut = MAX;
  while (cut > 0 && (buf[cut - 1]! & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8");
}

/** Patch non-terminal metadata (e.g. timeout clamp details). */
export function setRunMeta(
  runId: string,
  patch: Partial<
    Pick<
      RunSnapshot,
      | "model"
      | "mode"
      | "agent"
      | "agentSource"
      | "manifestPath"
      | "taskLabel"
      | "cwd"
      | "inputIndex"
      | "chainStep"
      | "parentJobId"
      | "sessionKey"
      | "startedAt"
      | "lastActivityAt"
      | "queueReason"
      | "timeoutEffectiveSeconds"
      | "timeoutRequestedSeconds"
      | "timeoutClamped"
    >
  >,
): void {
  const run = runs.get(runId as RunId);
  if (!run || run.terminal) return;
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    if (patch[key] !== undefined) (run as unknown as Record<string, unknown>)[key] = patch[key];
  }
}

/**
 * Flag non-terminal runs stale after `staleAfterMs` without a progress event.
 * Returns run ids that newly became stale.
 */
export function updateStaleness(nowMs: number, staleAfterMs: number): Set<string> {
  const newlyStale = new Set<string>();
  for (const run of runs.values()) {
    if (TERMINAL_FLEET_STATES.has(run.state)) {
      if (run.stale) run.stale = false;
      continue;
    }
    const lastMs = run.lastActivityAt
      ? Date.parse(run.lastActivityAt)
      : run.startedAt
        ? Date.parse(run.startedAt)
        : nowMs; // freshly queued: not stale yet
    const isStale = nowMs - lastMs > staleAfterMs;
    if (isStale && !run.stale) newlyStale.add(run.runId);
    run.stale = isStale;
  }
  return newlyStale;
}

/** Test seam: backdate a run's last-activity (staleness aging). */
export function setLastActivityForTest(runId: string, iso: string): void {
  const run = runs.get(runId as RunId);
  if (run) run.lastActivityAt = iso;
}

/**
 * Retention eviction: drop display entries beyond age/count limits, oldest
 * finished first. Never evicts active runs; durable job records untouched.
 * Returns evicted run ids.
 */
export function formatFleetStatus(runs: readonly RunSnapshot[] = displayRuns(), nowMs = Date.now()): string {
  const active = runs.filter((r) => !TERMINAL_FLEET_STATES.has(r.state));
  const terminal = runs.filter((r) => TERMINAL_FLEET_STATES.has(r.state));
  const lines = [`ops:status — active=${active.length} retained=${terminal.length}`];
  for (const run of runs) {
    const elapsed = run.elapsedMs ?? (run.startedAt ? nowMs - Date.parse(run.startedAt) : 0);
    lines.push(`${run.runId} ${run.agent} [${run.state}] elapsed=${(elapsed / 1000).toFixed(1)}s last=${run.lastActivityAt ?? "-"} result=${run.resultArtifactPath ?? "-"}${run.error ? ` error=${run.error}` : ""}`);
  }
  if (runs.length === 0) lines.push("No active or retained runs.");
  return lines.join("\\n");
}

export function evictRetained(nowMs: number, retentionMs: number, retentionCount: number): RunId[] {
  const evicted: RunId[] = [];
  for (const run of runs.values()) {
    if (run.terminal && !dismissed.has(run.runId)) {
      const tooOld = run.finishedAt !== null && (retentionMs === 0 || nowMs - Date.parse(run.finishedAt) > retentionMs);
      const zeroCount = retentionCount === 0;
      if (tooOld || zeroCount) {
        runs.delete(run.runId);
        evicted.push(run.runId);
      }
    }
  }
  const finished = [...runs.values()]
    .filter((r) => r.terminal && !dismissed.has(r.runId))
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  if (finished.length > retentionCount) {
    for (const r of finished.slice(0, finished.length - retentionCount)) {
      runs.delete(r.runId);
      evicted.push(r.runId);
    }
  }
  return evicted;
}
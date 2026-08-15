/**
 * Subagent runner (design D2 / subagent-runner spec).
 *
 * Spawns isolated `pi --mode json -p --no-session` children (named-session
 * calls use the named-session flags instead), parses complete NDJSON lines for
 * `message_end` / `tool_result_end`, ignores unknown event types, accounts
 * usage, enforces the deterministic TERM->KILL ladder, caps model-visible
 * output at 51,200 bytes / 2,000 lines, and runs single/parallel/chain modes
 * with deterministic queueing. Structured details flow through the
 * observability registry; preflight errors throw before any child spawns.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { FleetState } from "./constants.ts";
import type {
  AgentSourceKind,
  CatalogEntry,
  CatalogSnapshot,
  RunMode,
  StopReason,
  UsageSummary,
} from "./types.ts";
import type { OpsConfig } from "./config.ts";
import { KILL_COOLDOWN_MS, OUTPUT_CAP_BYTES, OUTPUT_CAP_LINES } from "./constants.ts";
import { emptyUsage } from "./types.ts";
import { redactSensitive } from "./redact.ts";
import {
  addUsage,
  createRun,
  finishRun,
  getRun,
  pushActivity,
  pushOutputTail,
  setRunMeta,
  transition,
} from "./observability.ts";
import type { SubagentCall } from "./tool-schema.ts";

// ===========================================================================
// Timeout resolution (call > manifest > config{env>default}; clamp to ceiling)
// ===========================================================================

export interface ResolvedTimeout {
  requestedSeconds: number;
  effectiveSeconds: number;
  clamped: boolean;
}

export function resolveTimeout(
  callSeconds: number | undefined,
  manifestSeconds: number | undefined,
  config: OpsConfig,
): ResolvedTimeout {
  const requested = callSeconds ?? manifestSeconds ?? config.timeoutSeconds;
  const ceiling = config.timeoutCeilingSeconds;
  const effective = Math.min(requested, ceiling);
  return { requestedSeconds: requested, effectiveSeconds: Math.max(1, effective), clamped: effective < requested };
}

// ===========================================================================
// Child process invocation
// ===========================================================================

export interface ChildInvocation {
  command: string;
  /** Extra argv placed before the built child args (tests: fake pi relay). */
  prefixArgs?: string[];
}

/** Port of the canonical subagent invocation resolution (pi examples). */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

/** Assemble the final invocation for a child. */
export function assembleInvocation(built: { args: string[] }, override?: ChildInvocation): { command: string; args: string[] } {
  if (override) return { command: override.command, args: [...(override.prefixArgs ?? []), ...built.args] };
  return getPiInvocation(built.args);
}

export interface BuildChildArgsOptions {
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  sessionDir?: string;
  sessionName?: string;
  sessionPath?: string;
  probePolicyPath?: string;
  systemPrompt: string;
}

export interface BuiltChildArgs {
  args: string[];
  tempPromptFile: string | null;
  tempDir: string | null;
}

/**
 * Ephemeral children: `--mode json -p --no-session`. Named calls: the session
 * flags (first-use `--session-dir` + `--name`; continuation `--session`). The
 * system prompt goes into a mode-0600 temp file; the delegated task is passed
 * as the final positional argument.
 */
export function buildChildArgs(opts: BuildChildArgsOptions, task: string): BuiltChildArgs {
  const args: string[] = ["--mode", "json", "-p"];
  if (opts.sessionPath) {
    args.push("--session", opts.sessionPath);
  } else if (opts.sessionDir && opts.sessionName) {
    args.push("--session-dir", opts.sessionDir, "--name", opts.sessionName);
  } else {
    args.push("--no-session");
  }
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
  if (opts.probePolicyPath) args.push("--probe-policy", opts.probePolicyPath);

  let tempPromptFile: string | null = null;
  let tempDir: string | null = null;
  if (opts.systemPrompt.trim().length > 0) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ops-prompt-"));
    const safe = (opts.model ?? "agent").replace(/[^\w.-]+/g, "_");
    tempPromptFile = path.join(tempDir, `prompt-${safe}.md`);
    fs.writeFileSync(tempPromptFile, opts.systemPrompt, { mode: 0o600 });
    args.push("--append-system-prompt", tempPromptFile);
  }
  args.push(`Task: ${task}`);
  return { args, tempPromptFile, tempDir };
}

function cleanupTemp(tempDir: string | null, tempPromptFile: string | null): void {
  if (tempPromptFile) {
    try {
      fs.unlinkSync(tempPromptFile);
    } catch {
      /* ignore */
    }
  }
  if (tempDir) {
    try {
      fs.rmdirSync(tempDir);
    } catch {
      /* ignore */
    }
  }
}

// ===========================================================================
// NDJSON line protocol
// ===========================================================================

export interface ChildEvent {
  type: string;
  message?: Message;
}
export interface LineConsumer {
  onEvent: (event: ChildEvent) => void;
  onMalformed: (line: string) => void;
}

/** Parse one complete NDJSON line; continuation on malformed lines. */
export function readLine(raw: string, consumer: LineConsumer): void {
  if (!raw.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    consumer.onMalformed(raw);
    return;
  }
  const obj = parsed as { type?: unknown; message?: unknown };
  if (typeof obj.type !== "string") {
    consumer.onMalformed(raw);
    return;
  }
  consumer.onEvent({ type: obj.type, message: obj.message as Message | undefined });
}

// ===========================================================================
// Usage accounting
// ===========================================================================

export function parseUsage(message: Message): { usage: Partial<UsageSummary>; malformed: boolean } {
  const u = (message as { usage?: Record<string, unknown> }).usage;
  const out: Partial<UsageSummary> = {};
  let malformed = false;
  if (!u || typeof u !== "object") return { usage: out, malformed: false };
  const pick = (key: string, fallbacks: string[] = []): number => {
    const v = u[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "number" && (Number.isNaN(v) || v < 0)) {
      malformed = true;
      return 0;
    }
    for (const f of fallbacks) {
      const fv = u[f];
      if (typeof fv === "number" && Number.isFinite(fv) && fv >= 0) return fv;
    }
    if (v !== undefined) malformed = true;
    return 0;
  };
  out.input = pick("input", ["inputTokens", "promptTokens", "prompt_tokens"]);
  out.output = pick("output", ["outputTokens", "completionTokens", "completion_tokens"]);
  out.cacheRead = pick("cacheRead", ["cacheReadTokens"]);
  out.cacheWrite = pick("cacheWrite", ["cacheWriteTokens"]);
  out.total = pick("total", ["totalTokens", "total_tokens"]);
  out.reasoning = pick("reasoning", ["reasoningTokens"]);
  const cost = u["cost"];
  if (cost && typeof cost === "object" && typeof (cost as { total?: unknown }).total === "number") {
    out.cost = (cost as { total: number }).total;
  } else if (typeof cost === "number") {
    out.cost = cost;
  } else if (cost !== undefined) {
    malformed = true;
  }
  out.cost ??= 0;
  out.turns = 1;
  return { usage: out, malformed };
}

// ===========================================================================
// Output bounds (exact truncation marker)
// ===========================================================================

export interface TruncationResult {
  text: string;
  omittedBytes: number;
  omittedLines: number;
}

/**
 * Model-visible output cap: 51,200 UTF-8 bytes or 2,000 lines, whichever is
 * reached first. Keeps the beginning of the digest at a UTF-8 boundary and
 * appends the exact omission marker pointing at the full output location.
 */
export function truncateOutput(digest: string, fullLocation: string): TruncationResult {
  const totalBytes = Buffer.byteLength(digest, "utf8");
  const lines = digest.split("\n");
  const totalLines = lines.length;

  let kept = digest;
  if (totalLines > OUTPUT_CAP_LINES) kept = lines.slice(0, OUTPUT_CAP_LINES).join("\n");
  const keptBytes = Buffer.byteLength(kept, "utf8");
  if (keptBytes > OUTPUT_CAP_BYTES) {
    const buf = Buffer.from(kept, "utf8");
    let n = OUTPUT_CAP_BYTES;
    while (n > 0 && (buf[n - 1]! & 0xc0) === 0x80) n--; // back off continuation bytes
    while (n > 0 && (buf[n - 1]! & 0xc0) === 0xc0) n--; // drop a dangling lead byte
    kept = buf.subarray(0, n).toString("utf8");
  }
  const omittedLines = totalLines - kept.split("\n").length;
  const omittedBytes = totalBytes - Buffer.byteLength(kept, "utf8");

  let text = kept;
  if (omittedBytes > 0 || omittedLines > 0) {
    text += `\n[Output truncated: ${omittedBytes} bytes and ${omittedLines} lines omitted. Full output: ${fullLocation}.]`;
  }
  return { text, omittedBytes, omittedLines };
}

// ===========================================================================
// Message helpers
// ===========================================================================

export function textOf(message: Message | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) =>
        part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Final assistant text = the digest source (bounded later by truncateOutput). */
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const t = textOf(m);
      if (t.trim().length > 0) return t;
    }
  }
  return "";
}

function toolNameOf(message: Message): string {
  const n = (message as { toolName?: unknown }).toolName;
  return typeof n === "string" && n.length > 0 ? n : "tool";
}

// ===========================================================================
// Probe tool narrowing (probe-protocol 4.1)
// ===========================================================================

/**
 * Probe children receive `read | grep | find | ls | probe_exec` subject to
 * manifest narrowing; built-in `bash`, `write`, and `edit` are never granted
 * (nor is any other mutation tool). General agents use their manifest tools.
 */
export function effectiveChildTools(entry: CatalogEntry | null): string[] {
  if (!entry || entry.kind !== "probe") {
    return entry && entry.tools.length > 0 ? entry.tools : [];
  }
  const denied = new Set(["bash", "write", "edit"]);
  const allowed = new Set(["read", "grep", "find", "ls", "probe_exec"]);
  const source = entry.tools.length > 0 ? entry.tools : ["read", "grep", "find", "ls"];
  const out: string[] = [];
  for (const t of source) {
    if (!allowed.has(t) || denied.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  if (!out.includes("probe_exec")) out.push("probe_exec");
  return out;
}

// ===========================================================================
// Concurrency governor
// ===========================================================================

export function resolveConcurrency(config: OpsConfig): number {
  const c = config.concurrency;
  return Number.isInteger(c) && c >= 1 && c <= 8 ? c : 2;
}

/** Mapper with at most `concurrency` live workers; results in input order. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!, current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ===========================================================================
// Per-task run
// ===========================================================================

export interface TaskRunRequest {
  task: { agent: string; task: string; cwd?: string };
  entry: CatalogEntry;
  inputIndex: number;
  chainStep: number | null;
  mode: RunMode;
  cwdBase: string;
  timeout: ResolvedTimeout;
  dispatchModel: string | null;
  dispatchThinking: string | undefined;
  contractsPrompt: string | undefined;
  session?: { dir?: string; name?: string; path?: string };
  parentJobId: string | null;
  sessionKey: string | null;
  probePolicyPath: string | undefined;
  childrenInvocationOverride?: ChildInvocation;
  precreatedRunId?: string;
  queueReason?: string | null;
  /** Test seam: TERM->KILL cooldown override (default KILL_COOLDOWN_MS). */
  killCooldownMs?: number;
}

export interface RunOutcome {
  runId: string;
  state: FleetState;
  agent: string;
  agentSource: AgentSourceKind | null;
  manifestPath: string | null;
  mode: RunMode;
  inputIndex: number;
  chainStep: number | null;
  taskLabel: string;
  cwd: string;
  exitCode: number | null;
  model: string | null;
  stopReason: StopReason | null;
  requestedSeconds: number;
  effectiveSeconds: number;
  clamped: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  usage: UsageSummary;
  digest: string;
  fullDigest: string;
  errorMessage: string | null;
  malformedLineCount: number;
  artifactPath: string | null;
}

/**
 * Run one task to its terminal snapshot. Never throws after the run exists —
 * failures are structured outcomes so successful siblings and collected
 * details are preserved. A parent abort before spawn ends the queued run as
 * `aborted` without creating a child.
 */
export async function runOneTask(
  req: TaskRunRequest,
  signal: AbortSignal | undefined,
  emit: (runId: string) => void,
): Promise<RunOutcome> {
  const cwd = path.resolve(req.cwdBase, req.task.cwd ?? ".");
  let runId: string;
  if (req.precreatedRunId) {
    runId = req.precreatedRunId;
    setRunMeta(runId, {
      mode: req.mode,
      agent: req.entry.name,
      agentSource: req.entry.source,
      manifestPath: req.entry.canonicalPath,
      taskLabel: req.task.task,
      cwd,
    });
  } else {
    runId = createRun({
      mode: req.mode,
      agent: req.entry.name,
      agentSource: req.entry.source,
      manifestPath: req.entry.canonicalPath,
      taskLabel: req.task.task.length > 80 ? `${req.task.task.slice(0, 77)}...` : req.task.task,
      cwd,
      model: req.entry.model ?? req.dispatchModel,
      timeoutRequestedSeconds: req.timeout.requestedSeconds,
      timeoutEffectiveSeconds: req.timeout.effectiveSeconds,
      timeoutClamped: req.timeout.clamped,
      inputIndex: req.inputIndex,
      chainStep: req.chainStep,
      parentJobId: req.parentJobId,
      sessionKey: req.sessionKey,
      queueReason: req.queueReason ?? null,
    }).runId;
  }
  const emitNow = () => emit(runId);

  // Parent abort before spawn: queued work never spawns.
  if (signal?.aborted) {
    pushActivity(runId, "abort", "parent abort before spawn; task cancelled");
    transition(runId, "aborted");
    finishRun(runId, { state: "aborted", stopReason: "aborted" });
    emitNow();
    return finishOutcome(runId, null, 0);
  }

  transition(runId, "starting");
  setRunMeta(runId, { startedAt: new Date().toISOString() });
  pushActivity(runId, "phase", "starting");
  emitNow();

  // With contracts, the contract blocks are followed by the unchanged
  // `<delegated_task>` wrapper produced by env-contracts; without them a plain
  // task line is used.
  const blocks = [req.entry.systemPrompt.trim(), req.contractsPrompt?.trim()].filter((b): b is string => Boolean(b));
  const prompt = req.contractsPrompt
    ? [...blocks, `<delegated_task>${req.task.task}</delegated_task>`].join("\n\n")
    : [...blocks, `Delegated task: ${req.task.task}`].join("\n\n");

  const built = buildChildArgs(
    {
      model: req.entry.model ?? req.dispatchModel ?? undefined,
      thinkingLevel: req.dispatchThinking,
      tools: effectiveChildTools(req.entry),
      sessionDir: req.session?.dir,
      sessionName: req.session?.name,
      sessionPath: req.session?.path,
      probePolicyPath: req.probePolicyPath,
      systemPrompt: prompt,
    },
    req.task.task,
  );

  const invocation = assembleInvocation(built, req.childrenInvocationOverride);

  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Gate the running transition on successful spawn; async spawn errors
  // transition starting -> failed without a running phase.
  const spawned = await new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("spawn", () => resolve(true));
  });
  if (!spawned) {
    const msg = redactSensitive(`spawn failed: ${invocation.command} ${invocation.args.join(" ")}`).text;
    pushActivity(runId, "error", msg);
    transition(runId, "failed");
    finishRun(runId, { state: "failed", stopReason: "error", error: msg });
    cleanupTemp(built.tempDir, built.tempPromptFile);
    emitNow();
    return finishOutcome(runId, 1, 0);
  }
  transition(runId, "running");
  pushActivity(runId, "phase", "running");
  emitNow();

  let stdoutBuffer = "";
  let stderr = "";
  let malformedCount = 0;
  let assistantTurns = 0;
  let toolResults = 0;
  let lastStopReason: StopReason | null = null;
  let childError: string | null = null;
  let childModel: string | null = null;
  const messages: Message[] = [];

  const processLine = (raw: string) => {
    readLine(raw, {
      onEvent: (event) => {
        if (event.type === "message_end" && event.message) {
          messages.push(event.message);
          if (event.message.role === "assistant") {
            assistantTurns++;
            lastStopReason = event.message.stopReason ?? null;
            if (event.message.errorMessage) childError = event.message.errorMessage;
            if (typeof event.message.model === "string" && event.message.model) childModel = event.message.model;
            const { usage, malformed } = parseUsage(event.message);
            if (malformed) malformedCount++;
            addUsage(runId, usage);
            pushActivity(runId, "assistant", `turn ${assistantTurns}`);
          }
          pushOutputTail(runId, textOf(event.message));
        } else if (event.type === "tool_result_end" && event.message) {
          messages.push(event.message);
          toolResults++;
          pushActivity(runId, "tool_result", `${toolNameOf(event.message)} #${toolResults}`);
          pushOutputTail(runId, textOf(event.message));
        } else {
          // Unknown child event: continue; bounded diagnostic recorded.
          malformedCount++;
          pushActivity(runId, "unknown_event", String(event.type));
        }
      },
      onMalformed: () => {
        malformedCount++;
      },
    });
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-200_000);
  });

  let timedOut = false;
  let aborted = false;
  let termSent = false;
  let killTimer: NodeJS.Timeout | undefined;

  const escalate = () => {
    if (termSent) return;
    termSent = true;
    pushActivity(runId, "termination", `SIGTERM ${new Date().toISOString()}`);
    try {
      child.kill("SIGTERM");
    } catch {
      /* nothing to send */
    }
    killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        pushActivity(runId, "termination", `SIGKILL ${new Date().toISOString()} (${req.killCooldownMs ?? KILL_COOLDOWN_MS} ms cooldown)`);
        try {
          child.kill("SIGKILL");
        } catch {
          /* already closed */
        }
      }
    }, req.killCooldownMs ?? KILL_COOLDOWN_MS);
  };

  const deadlineTimer =
    req.timeout.effectiveSeconds > 0
      ? setTimeout(() => {
          timedOut = true;
          pushActivity(runId, "timeout", `effective deadline ${req.timeout.effectiveSeconds}s reached`);
          escalate();
        }, req.timeout.effectiveSeconds * 1000)
      : undefined;

  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    pushActivity(runId, "abort", "parent abort: termination ladder");
    escalate();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const exitCode = await new Promise<number>((resolve) => {
    child.once("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      resolve(code ?? 0);
    });
    child.once("error", (err) => {
      if (!childError) childError = `spawn error: ${err.message}`;
      resolve(1);
    });
  });

  const finalText = getFinalOutput(messages);
  const bounded = truncateOutput(finalText, `details (${runId})`);

  const state: FleetState = aborted
    ? "aborted"
    : timedOut
      ? "timed_out"
      : exitCode !== 0 || lastStopReason === "error" || Boolean(childError)
        ? "failed"
        : "done";
  const stopReason: StopReason = state === "aborted" ? "aborted" : state === "timed_out" ? "error" : state === "failed" ? "error" : lastStopReason ?? "end";

  const errorMessage =
    childError
      ? redactSensitive(childError).text
      : exitCode !== 0 && stderr
        ? redactSensitive(stderr.slice(0, 2000)).text
        : exitCode !== 0
          ? `child exited with code ${exitCode}`
          : null;

  finishRun(runId, { state, stopReason, digest: finalText, error: errorMessage });
  cleanupTemp(built.tempDir, built.tempPromptFile);
  emitNow();

  return {
    runId,
    state,
    agent: req.entry.name,
    agentSource: req.entry.source,
    manifestPath: req.entry.canonicalPath,
    mode: req.mode,
    inputIndex: req.inputIndex,
    chainStep: req.chainStep,
    taskLabel: getRun(runId)?.taskLabel ?? req.task.task,
    cwd,
    exitCode,
    model: childModel ?? req.entry.model ?? req.dispatchModel,
    stopReason,
    requestedSeconds: req.timeout.requestedSeconds,
    effectiveSeconds: req.timeout.effectiveSeconds,
    clamped: req.timeout.clamped,
    startedAt: getRun(runId)?.startedAt ?? null,
    finishedAt: getRun(runId)?.finishedAt ?? null,
    elapsedMs: getRun(runId)?.elapsedMs ?? null,
    usage: getRun(runId)?.usage ?? emptyUsage(),
    digest: bounded.text,
    fullDigest: finalText,
    errorMessage,
    malformedLineCount: malformedCount,
    artifactPath: null,
  };
}

/** Outcome assembled from the registry for runs that never reached spawn. */
function finishOutcome(runId: string, exitCode: number | null, malformed: number): RunOutcome {
  const s = getRun(runId);
  return {
    runId: s?.runId ?? runId,
    state: s?.state ?? "failed",
    agent: s?.agent ?? "",
    agentSource: s?.agentSource ?? null,
    manifestPath: s?.manifestPath ?? null,
    mode: s?.mode ?? "single",
    inputIndex: s?.inputIndex ?? 0,
    chainStep: s?.chainStep ?? null,
    taskLabel: s?.taskLabel ?? "",
    cwd: s?.cwd ?? "",
    exitCode,
    model: s?.model ?? null,
    stopReason: (s?.stopReason ?? "error") as StopReason,
    requestedSeconds: s?.timeoutRequestedSeconds ?? 0,
    effectiveSeconds: s?.timeoutEffectiveSeconds ?? 0,
    clamped: s?.timeoutClamped ?? false,
    startedAt: s?.startedAt ?? null,
    finishedAt: s?.finishedAt ?? null,
    elapsedMs: s?.elapsedMs ?? 0,
    usage: s?.usage ?? emptyUsage(),
    digest: "",
    fullDigest: "",
    errorMessage: s?.error ?? null,
    malformedLineCount: malformed,
    artifactPath: null,
  };
}

// ===========================================================================
// Foreground orchestration (single / parallel / chain)
// ===========================================================================

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

export function itemsOf(call: SubagentCall): Array<{ agent: string; task: string; cwd?: string }> {
  if (call.mode === "single") return [{ agent: call.agent!, task: call.task!, cwd: call.cwd }];
  if (call.mode === "parallel") return call.tasks ?? [];
  return call.chain ?? [];
}

export interface ApprovalGate {
  /** Throws with actionable guidance when the entry is not approved. */
  ensureApproved: (entry: CatalogEntry) => Promise<void> | void;
}

export interface CallEnvironment {
  config: OpsConfig;
  catalog: CatalogSnapshot;
  cwdBase: string;
  dispatchModel: string | null;
  dispatchThinking: string | undefined;
  signal: AbortSignal | undefined;
  approvalGate?: ApprovalGate;
  sessionFirstUse?: { dir: string; name: string };
  sessionContinuePath?: string;
  /** Per-agent named-session wiring (parallel/chain with a shared handle). */
  sessionsByAgent?: Map<string, { firstUse?: { dir: string; name: string }; continuePath?: string; key: string }>;
  contractsPrompt?: string;
  probePolicyPath?: string;
  parentJobId?: string | null;
  sessionKey?: string | null;
  childrenInvocationOverride?: ChildInvocation;
  /** Validated contract names for this invocation (env-contracts 5.2). */
  knownContractNames?: string[];
  onSnapshot: (runId: string) => void;
}

export interface CallInput extends CallEnvironment {
  call: SubagentCall;
}

export interface ForegroundResult {
  outcomes: RunOutcome[];
  aggregate: UsageSummary;
  durationMs: number;
}

/** Preflight (throws before spawn): unknown agents + contract list validity. */
export function selectEntries(input: CallInput): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>();
  for (const item of itemsOf(input.call)) {
    const entry = input.catalog.entries.find((e) => e.name === item.agent) ?? null;
    if (!entry) {
      const available = input.catalog.entries.map((e) => e.name).join(", ") || "none";
      const searched = input.catalog.sourceOrder.map((s) => s.split(":")[1]).filter(Boolean).join(", ") || "(no sources)";
      throw new PreflightError(
        `Unknown agent: "${item.agent}". Valid agents: ${available}. Searched: ${searched}. Add a manifest or re-enable bundled agents (includeBundledAgents).`,
      );
    }
    entries.set(item.agent, entry);
  }
  const contracts = input.call.contracts;
  if (contracts && contracts.length > 0) {
    if (new Set(contracts).size !== contracts.length) {
      throw new PreflightError("contracts must be unique.");
    }
    const known = input.knownContractNames ?? [];
    const missing = contracts.filter((c) => !known.includes(c));
    if (missing.length > 0) {
      throw new PreflightError(`Unknown contract(s): ${missing.join(", ")}.`);
    }
  }
  return entries;
}

export async function runForeground(input: CallInput): Promise<ForegroundResult> {
  const startedMs = Date.now();
  const call = input.call;
  const entries = selectEntries(input);
  const items = itemsOf(call);

  // Approvals for project-controlled entries, before any spawn.
  if (input.approvalGate) {
    const seen = new Set<string>();
    for (const entry of entries.values()) {
      if (entry.source !== "project" && entry.source !== "configured") continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      await input.approvalGate.ensureApproved(entry);
    }
  }

  const makeReq = (
    item: { agent: string; task: string; cwd?: string },
    inputIndex: number,
    chainStep: number | null,
    precreatedRunId?: string,
    queueReason?: string | null,
  ): TaskRunRequest => {
    const entry = entries.get(item.agent)!;
    const timeout = resolveTimeout(call.timeoutSeconds, entry.timeoutSeconds, input.config);
    return {
      task: item,
      entry,
      inputIndex,
      chainStep,
      mode: call.mode,
      cwdBase: input.cwdBase,
      timeout,
      dispatchModel: input.dispatchModel,
      dispatchThinking: input.dispatchThinking,
      contractsPrompt: input.contractsPrompt,
      session: input.sessionsByAgent?.get(item.agent)
        ? (() => {
            const s = input.sessionsByAgent!.get(item.agent)!;
            return s.continuePath ? { path: s.continuePath } : { dir: s.firstUse!.dir, name: s.firstUse!.name };
          })()
        : input.sessionContinuePath
          ? { path: input.sessionContinuePath }
          : input.sessionFirstUse
            ? { dir: input.sessionFirstUse.dir, name: input.sessionFirstUse.name }
            : undefined,
      parentJobId: input.parentJobId ?? null,
      sessionKey: input.sessionKey ?? null,
      probePolicyPath: input.probePolicyPath,
      childrenInvocationOverride: input.childrenInvocationOverride,
      precreatedRunId,
      queueReason,
    };
  };

  let outcomes: RunOutcome[];
  if (call.mode === "chain") {
    outcomes = [];
    let previousDigest = "";
    let step = 0;
    for (const item of items) {
      step++;
      const taskText = item.task.replace(/\{previous\}/g, previousDigest);
      const outcome = await runOneTask(makeReq({ ...item, task: taskText }, step - 1, step), input.signal, input.onSnapshot);
      outcomes.push(outcome);
      previousDigest = outcome.digest;
      if (outcome.state !== "done") break;
    }
  } else {
    const concurrency = resolveConcurrency(input.config);
    outcomes = await mapWithConcurrencyLimit(items, concurrency, async (item, index) => {
      const pre = preCreatedQueuedRun(input, item, index, concurrency, call.mode, entries);
      return runOneTask(makeReq(item, index, null, pre.runId), input.signal, input.onSnapshot);
    });
  }

  const aggregate = emptyUsage();
  for (const o of outcomes) {
    aggregate.turns += o.usage.turns;
    aggregate.input += o.usage.input;
    aggregate.output += o.usage.output;
    aggregate.cacheRead += o.usage.cacheRead;
    aggregate.cacheWrite += o.usage.cacheWrite;
    aggregate.total += o.usage.total;
    aggregate.reasoning += o.usage.reasoning;
    aggregate.cost += o.usage.cost;
  }
  return { outcomes, aggregate, durationMs: Date.now() - startedMs };
}

/** Build the queued snapshot for a parallel task before it acquires a slot. */
function preCreatedQueuedRun(
  input: CallInput,
  item: { agent: string; task: string; cwd?: string },
  index: number,
  concurrency: number,
  mode: RunMode,
  entries: Map<string, CatalogEntry>,
) {
  const entry = entries.get(item.agent);
  const timeout = entry
    ? resolveTimeout(input.call.timeoutSeconds, entry.timeoutSeconds, input.config)
    : resolveTimeout(undefined, undefined, input.config);
  return createRun({
    mode,
    agent: entry?.name ?? item.agent,
    agentSource: entry?.source ?? null,
    manifestPath: entry?.canonicalPath ?? null,
    taskLabel: item.task.length > 80 ? `${item.task.slice(0, 77)}...` : item.task,
    cwd: path.resolve(input.cwdBase, item.cwd ?? "."),
    model: entry?.model ?? input.dispatchModel,
    timeoutRequestedSeconds: timeout.requestedSeconds,
    timeoutEffectiveSeconds: timeout.effectiveSeconds,
    timeoutClamped: timeout.clamped,
    inputIndex: index,
    chainStep: null,
    parentJobId: input.parentJobId ?? null,
    sessionKey: input.sessionKey ?? null,
    queueReason: `concurrency: ${concurrency} live; waiting for a slot`,
  });
}
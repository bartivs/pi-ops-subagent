/**
 * pi-ops-subagent — extension entrypoint.
 *
 * Wires registrations and lifecycle only. All heavy lifting lives in the
 * sibling modules (config, catalog, runner, probe, contracts, jobs, sessions,
 * observability, tool-renderer, fleet-widget, fleet-overlay, artifacts).
 */
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.ts";
import {
  discoverCatalog,
  formatCatalogReport,
  grantApproval,
  isApproved,
  loadTrust,
  persistTrust,
  defaultTrustFile,
} from "./catalog.ts";
import type { CatalogSnapshot } from "./types.ts";
import type { OpsConfig } from "./config.ts";
import { resolveRunsDir } from "./config.ts";
import {
  buildContractBlocks,
  checkContractSecrets,
  discoverContracts,
  selectContracts,
  contractDetails,
} from "./contracts.ts";
import {
  createJobRecord,
  queueJobExecution,
  cancelJob,
  resumeJob,
  reconcileStartup,
  triggerDueJobs,
  startScheduler,
  stopScheduler,
  formatJobsReport,
  formatJobInspect,
  getJob,
  type JobRuntime,
} from "./jobs.ts";
import {
  acquireLock,
  deriveKey,
  endSession,
  cleanupSessionFiles,
  captureChildSessionPath,
  findSessionByHandle,
  formatSessionsReport,
  formatSessionInfo,
  listSessions,
  refreshLock,
  releaseLock,
  resolveSession,
  validateHandle,
  SessionError,
  type SessionResolutionResult,
} from "./sessions.ts";
import { resolveSessionsDir, resolveRunsDir as rrDir } from "./config.ts";
import { checkSubagentInput, subagentParameters, type SubagentCall } from "./tool-schema.ts";
import {
  PreflightError,
  itemsOf,
  runForeground,
  type CallEnvironment,
  type CallInput,
  type RunOutcome,
} from "./runner.ts";
import { displayRuns, evictRetained, formatFleetStatus, snapshotRuns, updateStaleness } from "./observability.ts";
import { renderCall as renderSubagentCall, renderResult as renderSubagentResult } from "./tool-renderer.ts";
import { renderFleetWidget } from "./fleet-widget.ts";
import { createFleetOverlay } from "./fleet-overlay.ts";
import type { CatalogEntry } from "./types.ts";
import { registerAgentInitializer } from "./agent-init.ts";
import { executeSsh, SSHPARAMETERS, SSH_TOOL } from "./ssh-tool.ts";

/** Custom entry type used to render TUI-only catalog reports. */
export const AGENTS_REPORT_ENTRY = "ops:agents-report" as const;

export default function (pi: ExtensionAPI): void {
  registerOpsAgentsCommand(pi);
  registerAgentInitializer(pi);
  registerSubagentTool(pi);
  registerSshTool(pi);
  registerOpsJobsCommand(pi);
  registerOpsSessionCommand(pi);
  registerOpsStatusCommand(pi);
  wireFleetLifecycle(pi);
  wireJobsLifecycle(pi);
}

/** /ops:session list|info|end|cleanup */
/** Minimal runtime `ssh` tool so generated SSH probes/generals are runnable. */
function registerSshTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SSH_TOOL,
    label: "SSH",
    description: "Run a remote command over SSH against a host (read-only commands recommended). Requires a trusted project and opens a direct connection.",
    parameters: SSHPARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const env = {
        hasUI: ctx.hasUI,
        isProjectTrusted: () => ctx.isProjectTrusted(),
        uiConfirm: (title: string, body: string) => ctx.ui.confirm(title, body),
        signal: _signal,
      };
      const r = await executeSsh(params as never, env);
      return {
        content: [{ type: "text" as const, text: r.summary }],
        details: { exitCode: r.exitCode, timedOut: r.timedOut, output: r.output, error: r.error },
      };
    },
  });
}

function registerOpsSessionCommand(pi: ExtensionAPI): void {
  pi.registerCommand("ops:session", {
    description: "Manage named child sessions: list, info <handle|key>, end <handle|key>, cleanup <handle|key>.",
    handler: async (args, ctx) => {
      const config = loadConfig(ctx.cwd, process.env, ctx.isProjectTrusted());
      const sessionsDir = resolveSessionsDir(config);
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const verb = parts[0] ?? "list";
      try {
        if (verb === "list" || verb === "") {
          ctx.ui.notify("ops:session — report rendered above", "info");
          pi.appendEntry(AGENTS_REPORT_ENTRY, { content: formatSessionsReport(sessionsDir) });
          return;
        }
        const id = parts[1];
        if (!id) {
          ctx.ui.notify(`ops:session ${verb} requires a handle or key.`, "error");
          return;
        }
        const found = findSessionByHandle(sessionsDir, id);
        if (!found) {
          ctx.ui.notify(`ops:session — no session matching "${id}". Use /ops:session list.`, "error");
          return;
        }
        if (verb === "info") {
          ctx.ui.notify(formatSessionInfo(found), "info");
          return;
        }
        if (verb === "end") {
          const summary = endSession(sessionsDir, found.key);
          ctx.ui.notify(`ops:session — ended ${summary.handle} [${summary.state}].`, "info");
          return;
        }
        if (verb === "cleanup") {
          const removed = cleanupSessionFiles(sessionsDir, found.key);
          ctx.ui.notify(`ops:session — cleanup removed ${removed.length} file(s) for ${found.key}.`, "info");
          return;
        }
        ctx.ui.notify(`ops:session — unknown verb "${verb}". Supported: list, info, end, cleanup.`, "error");
      } catch (e) {
        ctx.ui.notify(`ops:session — ${(e as Error).message}`, "error");
      }
    },
  });
}

/** /ops:status — textual snapshot in all modes. */
function registerOpsStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("ops:status", {
    description: "Show active and retained subagent fleet runs.",
    handler: async (_args, ctx) => {
      const config = loadConfig(ctx.cwd, process.env, ctx.isProjectTrusted());
      const report = formatFleetStatus(displayRuns());
      ctx.ui.notify(report, "info");
      if (ctx.mode === "tui") pi.appendEntry(AGENTS_REPORT_ENTRY, { content: report });
      // Apply configured retention at command time as well as lifecycle time.
      evictRetained(Date.now(), config.fleetRetentionMs, config.fleetRetentionCount);
    },
  });
}

/** /ops:jobs list|inspect|resume|cancel */
function registerOpsJobsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("ops:jobs", {
    description: "Manage durable background jobs: list, inspect <id>, resume <id>, cancel <id>.",
    handler: async (args, ctx) => {
      const config = loadConfig(ctx.cwd, process.env, ctx.isProjectTrusted());
      const runsDir = resolveRunsDir(config);
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const verb = parts[0] ?? "list";
      try {
        if (verb === "list" || verb === "") {
          ctx.ui.notify(formatJobsReport(runsDir).split("\n")[0] ?? "ops:jobs", "info");
          pi.appendEntry(AGENTS_REPORT_ENTRY, { content: formatJobsReport(runsDir) });
          return;
        }
        if (verb === "inspect") {
          const id = parts[1];
          if (!id) {
            ctx.ui.notify("ops:jobs inspect requires a job id.", "error");
            return;
          }
          const job = getJob(runsDir, id);
          if (!job) {
            ctx.ui.notify(`ops:jobs — unknown job "${id}". Use /ops:jobs list to see valid ids.`, "error");
            return;
          }
          ctx.ui.notify(formatJobInspect(runsDir, id), "info");
          return;
        }
        if (verb === "resume") {
          const id = parts[1];
          if (!id) {
            ctx.ui.notify("ops:jobs resume requires a job id.", "error");
            return;
          }
          const job = getJob(runsDir, id);
          if (!job) {
            ctx.ui.notify(`ops:jobs — unknown job "${id}".`, "error");
            return;
          }
          const mode = job.mode;
          const agentNames = job.agents;
          const next = resumeJob(runsDir, id, mode, agentNames);
          const runtime = makeJobRuntime(envFor(ctx));
          queueJobExecution(next, runtime);
          ctx.ui.notify(`ops:jobs — resumed ${id} as ${next.jobId} (${next.state}).`, "info");
          return;
        }
        if (verb === "cancel") {
          const id = parts[1];
          if (!id) {
            ctx.ui.notify("ops:jobs cancel requires a job id.", "error");
            return;
          }
          const job = cancelJob(runsDir, id);
          ctx.ui.notify(`ops:jobs — canceled ${job.jobId} (${job.state}).`, "info");
          return;
        }
        ctx.ui.notify(`ops:jobs — unknown verb "${verb}". Supported: list, inspect <id>, resume <id>, cancel <id>.`, "error");
      } catch (e) {
        ctx.ui.notify(`ops:jobs — ${(e as Error).message}`, "error");
      }
    },
  });
}

function envFor(ctx: ExtensionContext | ExtensionCommandContext): ToolEnv {
  return {
    cwd: ctx.cwd,
    mode: ctx.mode,
    hasUI: ctx.hasUI,
    isProjectTrusted: () => ctx.isProjectTrusted(),
    signal: ctx.signal,
    dispatchModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    dispatchThinking: ctx.thinkingLevel,
    contracts: makeContractsResolver(),
  };
}

// ===========================================================================
// /ops:agents
// ===========================================================================

function registerOpsAgentsCommand(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(AGENTS_REPORT_ENTRY, (entry, _options, theme) => {
    const content = (entry.data as { content?: string } | undefined)?.content ?? "";
    return new Text(theme.fg("dim", content), 0, 0);
  });

  pi.registerCommand("ops:agents", {
    description: "Show the effective agent catalog: sources, precedence, provenance, trust and validation diagnostics.",
    handler: async (_args, ctx) => {
      const trusted = ctx.isProjectTrusted();
      const config = loadConfig(ctx.cwd, process.env, trusted);
      let snapshot: CatalogSnapshot;
      try {
        snapshot = discoverCatalog(config, trusted);
      } catch (e) {
        ctx.ui.notify(`ops:agents — catalog discovery failed: ${(e as Error).message}`, "error");
        return;
      }
      const report = formatCatalogReport(snapshot, config);
      pi.appendEntry(AGENTS_REPORT_ENTRY, { content: report });
      const entries = snapshot.entries.length;
      ctx.ui.notify(`ops:agents — ${entries} effective agent${entries === 1 ? "" : "s"} (report above)`, "info");
    },
  });
}

// ===========================================================================
// subagent tool
// ===========================================================================

/** Testable environment adapter for the tool executor. */
export interface ToolEnv {
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  isProjectTrusted: () => boolean;
  signal?: AbortSignal;
  /** Interactive approval prompt (ui.confirm). Undefined in headless modes. */
  uiConfirm?: (title: string, body: string) => Promise<boolean>;
  /** ctx.model `${provider}/${id}` when available. */
  dispatchModel?: string | null;
  dispatchThinking?: string | undefined;
  /** Optional catalog discovery overrides (tests). */
  bundledAgentsDir?: string;
  userAgentsDir?: string;
  trustFile?: string;
  /** Child invocation override (tests: fake pi relay). */
  childrenInvocationOverride?: import("./runner.ts").ChildInvocation;
  /** Injected by index.ts to stream partial results. */
  onUpdate?: (partial: AgentToolResult<Record<string, unknown>>) => void;
  /** TUI notification adapter; never called in headless modes. */
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  /** For runAsync/scheduled delegation (wired by background-jobs). */
  queueBackground?: (call: SubagentCall, env: ToolEnv) => Promise<{ jobId: string }>;
  /** For named-session wiring (wired by named-sessions). */
  sessionResolution?: (
    call: SubagentCall,
    env: ToolEnv,
  ) => Promise<{ byAgent: Map<string, { firstUse?: { dir: string; name: string }; continuePath?: string; key: string }>; statuses: Map<string, "created" | "continued">; release: () => void } | null>;
  /** True when the parent session is persisted (named children require it). */
  sessionPersisted?: boolean;
  parentSessionId?: string | null;
  /** Contracts resolution (wired by env-contracts): blocks + selected details. */
  contracts?: (call: SubagentCall, config: OpsConfig, catalog: CatalogSnapshot) => Promise<{ blocks: string; knownNames: string[]; selected: Array<{ name: string; canonicalPath: string; contentHash: string }> }>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export function makeApprovalGate(env: ToolEnv, config: OpsConfig) {
  const trustFile = env.trustFile ?? defaultTrustFile();
  return {
    ensureApproved: async (entry: CatalogEntry) => {
      const record = loadTrust(trustFile);
      if (isApproved(record, config.projectRoot, entry.canonicalPath, entry.contentHash)) return;
      // Headless (json/print): fail closed unless the CI override is present.
      if (!env.hasUI) {
        if (config.allowProjectAgentsByEnv) return;
        throw new PreflightError(
          `Project agent "${entry.name}" is not approved. Run once interactively, or set PI_OPS_ALLOW_PROJECT_AGENTS=1 for CI/headless.`,
        );
      }
      const ok = await env.uiConfirm?.(
        "Approve project agent?",
        `${entry.name}\n${entry.canonicalPath}\n\nRepo-controlled content requires approval before execution.`,
      );
      if (!ok) throw new PreflightError(`Approval required for project agent "${entry.name}".`);
      persistTrust(grantApproval(record, config.projectRoot, entry.canonicalPath, entry.contentHash), trustFile);
    },
  };
}

/** The subagent tool executor — exported so tests run the real logic. */
export async function subagentExecute(params: unknown, env: ToolEnv): Promise<ToolResult> {
  const call = checkSubagentInput(params);
  const trusted = env.isProjectTrusted();
  const config = loadConfig(env.cwd, process.env, trusted);
  const catalog = discoverCatalog(config, trusted, {
    bundledAgentsDir: env.bundledAgentsDir,
    userAgentsDir: env.userAgentsDir,
    trustFile: env.trustFile,
  });

  let contractsPrompt: string | undefined;
  let knownContracts: string[] = [];
  let selectedContracts: Array<{ name: string; canonicalPath: string; contentHash: string }> = [];
  if (env.contracts) {
    const resolved = await env.contracts(call, config, catalog);
    contractsPrompt = resolved.blocks;
    knownContracts = resolved.knownNames;
    selectedContracts = resolved.selected;
  }

  const base: CallEnvironment = {
    config,
    catalog,
    cwdBase: env.cwd,
    dispatchModel: env.dispatchModel ?? null,
    dispatchThinking: env.dispatchThinking,
    signal: env.signal,
    approvalGate: makeApprovalGate(env, config),
    contractsPrompt,
    knownContractNames: knownContracts,
    childrenInvocationOverride: env.childrenInvocationOverride,
    onSnapshot: () => {
      emitPartial(env);
    },
  };

  if (call.runAsync) {
    if (!env.queueBackground) {
      throw new PreflightError("runAsync requires the background-jobs registry, which is initialized during bootstrap (task 6.x).");
    }
    const { jobId } = await env.queueBackground(call, env);
    return {
      content: [{ type: "text", text: `Queued background job ${jobId}. Use /ops:jobs to track it.` }],
      details: { jobId },
    };
  }

  let input: CallInput;
  let releaseSession: (() => void) | null = null;
  let sessionStatuses: Map<string, "created" | "continued"> = new Map();
  if (env.sessionResolution && call.session) {
    const s = await env.sessionResolution(call, env);
    if (s) {
      input = {
        ...base,
        call,
        sessionsByAgent: s.byAgent,
        sessionKey: s.byAgent.size === 1 ? [...s.byAgent.values()][0]!.key : null,
      };
      sessionStatuses = s.statuses;
      releaseSession = s.release;
    } else {
      input = { ...base, call };
    }
  } else {
    input = { ...base, call };
  }

  let res;
  try {
    res = await runForeground(input);
    if (input.sessionsByAgent) {
      for (const session of input.sessionsByAgent.values()) {
        if (session.firstUse) captureChildSessionPath(resolveSessionsDir(config), session.key, session.firstUse.dir);
      }
    }
  } finally {
    releaseSession?.();
  }
  const result = resultFromOutcomes(call, res.outcomes, res.aggregate, res.durationMs);
  if (selectedContracts.length > 0) {
    result.details.contracts = selectedContracts;
  }
  if (sessionStatuses.size > 0) {
    const statuses = Object.fromEntries(sessionStatuses);
    result.details.sessionStatus = sessionStatuses.size === 1 ? [...sessionStatuses.values()][0] : statuses;
    result.details.session = { handle: call.session, statuses, keys: [...sessionStatuses.keys()].map((agent) => input.sessionsByAgent?.get(agent)?.key).filter(Boolean) };
  }
  const failed = res.outcomes.filter((outcome) => outcome.state !== "done");
  if (failed.length > 0 && env.mode === "tui") {
    env.notify?.(`subagent ${failed.length} run(s) failed or stopped; use Alt+O fleet for details.`, "warning");
  }
  return result;
}

function emitPartial(env: ToolEnv): void {
  if (!env.onUpdate) return;
  const runs = snapshotRuns().map((r) => ({
    runId: r.runId,
    state: r.state,
    agent: r.agent,
    taskLabel: r.taskLabel,
    elapsedMs: r.elapsedMs,
    digest: r.digest,
  }));
  const active = runs.filter((r) => r.state !== "done" && r.state !== "failed" && r.state !== "timed_out" && r.state !== "aborted");
  const text = active.length > 0 ? `subagent: ${active.length} active run(s)` : "subagent: finalizing";
  env.onUpdate({
    content: [{ type: "text", text }],
    details: { runs },
  });
}

export function resultFromOutcomes(call: SubagentCall, outcomes: RunOutcome[], aggregate: { turns: number; cost: number }, durationMs: number): ToolResult {
  const ok = outcomes.filter((o) => o.state === "done").length;
  const err = outcomes.length - ok;
  const lines: string[] = [];
  if (call.mode === "parallel") {
    lines.push(`parallel: ok=${ok} err=${err} time=${ms(aggregate, durationMs)} turns=${aggregate.turns} cost=$${aggregate.cost.toFixed(4)}`);
  } else if (call.mode === "chain") {
    lines.push(`chain: ${outcomes.length} step(s), ok=${ok} err=${err}`);
  } else {
    lines.push(`single: ${outcomes[0]?.state ?? "none"}`);
  }
  for (const o of outcomes) {
    const tag = o.state === "done" ? "[OK]" : o.state === "failed" ? "[ERR]" : o.state === "timed_out" ? "[TIME]" : o.state === "aborted" ? "[ABRT]" : `[${o.state.toUpperCase()}]`;
    const reason = o.state === "done" ? "" : ` ${o.errorMessage ?? o.stopReason ?? ""}`.trim();
    lines.push(`  ${tag} ${o.agent} ${shortRunId(o.runId)} ${ms(o, o.elapsedMs ?? 0)}${reason ? ` — ${reason}` : ""}`);
    if (o.digest && o.state === "done") {
      const preview = o.digest.split("\n")[0]?.slice(0, 160) ?? "";
      if (preview) lines.push(`    ${preview}`);
    }
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { mode: call.mode, outcomes: outcomes.map((o) => ({ ...o })), aggregate, durationMs },
  };
}

function ms(_a: unknown, ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function shortRunId(runId: string): string {
  return runId.slice(0, 13);
}

/** Default env-contracts wiring used by the real tool. */
export function makeContractsResolver() {
  return async (call: SubagentCall, config: OpsConfig, catalog: CatalogSnapshot) => {
    const ccat = discoverContracts(config);
    const requested = itemsOf(call)
      .map((i) => catalog.entries.find((e) => e.name === i.agent))
      .filter((e): e is CatalogEntry => Boolean(e));
    const manifestNames = [...new Set(requested.map((e) => e.contract).filter((c): c is string => Boolean(c)))];
    const selection = selectContracts(call.contracts, manifestNames, config.defaultContract, ccat);
    if (selection.source === "none") {
      return { blocks: "", knownNames: [], selected: [] };
    }
    for (const doc of selection.contracts) checkContractSecrets(doc);
    return {
      blocks: buildContractBlocks(selection.contracts),
      knownNames: selection.contracts.map((c) => c.name),
      selected: contractDetails(selection.contracts),
    };
  };
}

/** Named-session resolver wired to the tool executor. */
export function makeSessionResolver(toolEnv: ToolEnv) {
  return async (call: SubagentCall, env: ToolEnv) => {
    if (!call.session) return null;
    if (!env.sessionPersisted || !env.parentSessionId) {
      throw new SessionError(
        "Named child sessions require a persisted parent session. Omit the session field, or run the parent pi with session persistence (do not use --no-session).",
        "parent",
      );
    }
    if (!validateHandle(call.session)) {
      throw new SessionError(`Invalid session handle "${call.session}".`, "handle");
    }
    const config = loadConfig(env.cwd, process.env, env.isProjectTrusted());
    const sessionsDir = resolveSessionsDir(config);
    const requestedAgents = itemsOf(call).map((i) => i.agent);
    // Parallel duplicate derived keys are rejected before any child spawn;
    // chain repeats are sequential steps and intentionally reuse the key.
    const agents = call.mode === "parallel" ? requestedAgents : [...new Set(requestedAgents)];
    const seen = new Map<string, string>();
    const byAgent = new Map<string, { firstUse?: { dir: string; name: string }; continuePath?: string; key: string }>();
    const statuses = new Map<string, "created" | "continued">();
    const locks: Array<{ dir: string; key: string }> = [];
    const heartbeats: NodeJS.Timeout[] = [];
    try {
      for (const agent of agents) {
        const key = deriveKey(env.parentSessionId, env.cwd, agent, call.session);
        if (seen.has(key)) {
          throw new PreflightError(
            `Parallel tasks resolve duplicate session keys for handle "${call.session}" (agents "${agent}" and "${seen.get(key)}").`,
          );
        }
        seen.set(key, agent);
        const res = resolveSession({
          sessionsDir,
          parentSessionId: env.parentSessionId,
          effectiveCwd: env.cwd,
          agent,
          handle: call.session,
          restartExpired: call.restartExpired,
          sessionExpiryMs: config.sessionExpiryMs,
        });
        const lock = acquireLock(sessionsDir, key, { pid: process.pid, runId: null }, Date.now());
        if (!lock.ok) {
          throw new PreflightError(
            `Named session "${call.session}" (${key}) is busy: ${lock.reason ?? "locked"}. Wait for the owner or use /ops:session end.`,
          );
        }
        locks.push({ dir: sessionsDir, key });
        statuses.set(agent, res.status);
        if (res.status === "created") byAgent.set(agent, { firstUse: res.firstUse, key });
        else byAgent.set(agent, { continuePath: res.continuePath, key });
      }
      const hb = setInterval(() => {
        for (const l of locks) refreshLock(l.dir, l.key, process.pid, Date.now());
      }, 5000);
      hb.unref?.();
      heartbeats.push(hb);
      return {
        byAgent,
        statuses,
        release: () => {
          for (const h of heartbeats) clearInterval(h);
          for (const l of locks) releaseLock(l.dir, l.key, process.pid);
        },
      };
    } catch (e) {
      for (const l of locks) releaseLock(l.dir, l.key, process.pid);
      throw e;
    }
  };
}

/** Background queue wired to a real JobRuntime for the tool executor. */
export function makeBackgroundQueue(toolEnv: ToolEnv) {
  return async (call: SubagentCall, _env?: ToolEnv): Promise<{ jobId: string }> => {
    const env = _env ?? toolEnv;
    const runtime = makeJobRuntime(env);
    const config = loadConfig(env.cwd, process.env, env.isProjectTrusted());
    const runsDir = resolveRunsDir(config);
    const mode = call.mode;
    const agentNames = itemsOf(call).map((i) => i.agent);
    const schedule = call.schedule
      ? call.schedule.intervalSec !== undefined
        ? ({ kind: "interval", intervalSec: call.schedule.intervalSec } as const)
        : ({ kind: "once", at: call.schedule.at! } as const)
      : null;
    const job = createJobRecord({
      runsDir,
      spec: call,
      schedule,
      resumedFromJobId: null,
      agentNames,
      mode,
    });
    queueJobExecution(job, runtime);
    return { jobId: job.jobId };
  };
}

/** JobRuntime: foreground execution under the owning pi process. */
export function makeJobRuntime(env: ToolEnv): JobRuntime {
  return {
    runsDir: resolveRunsDir(loadConfig(env.cwd, process.env, env.isProjectTrusted())),
    runCall: async (spec, signal, parentJobId) => {
      const trusted = env.isProjectTrusted();
      const config = loadConfig(env.cwd, process.env, trusted);
      const catalog = discoverCatalog(config, trusted, {
        bundledAgentsDir: env.bundledAgentsDir,
        userAgentsDir: env.userAgentsDir,
        trustFile: env.trustFile,
      });
      let contractsPrompt: string | undefined;
      let knownNames: string[] = [];
      if (env.contracts && (spec.contracts?.length ?? 0) > 0) {
        const resolved = await env.contracts(spec, config, catalog);
        contractsPrompt = resolved.blocks;
        knownNames = resolved.knownNames;
      }
      const input: CallInput = {
        config,
        catalog,
        cwdBase: env.cwd,
        dispatchModel: env.dispatchModel ?? null,
        dispatchThinking: env.dispatchThinking,
        signal,
        approvalGate: makeApprovalGate(env, config),
        contractsPrompt,
        knownContractNames: knownNames,
        childrenInvocationOverride: env.childrenInvocationOverride,
        parentJobId,
        sessionKey: null,
        onSnapshot: () => emitPartial(env),
        call: spec,
      };
      const res = await runForeground(input);
      const digestText = res.outcomes
        .map((o) => `## ${o.agent} [${o.state}]\n\n${o.digest || "(no output)"}`)
        .join("\n\n---\n\n");
      const evidenceLines = res.outcomes.map((o) => ({
        runId: o.runId,
        state: o.state,
        agent: o.agent,
        usage: o.usage,
        error: o.errorMessage ?? undefined,
      }));
      return { digestText, evidenceLines, usage: { perRun: res.outcomes.map((o) => o.usage), aggregate: res.aggregate } };
    },
  };
}

/** Session-scoped jobs/scheduler lifecycle wiring. */
export function wireJobsLifecycle(pi: ExtensionAPI): void {
  let envRef: ToolEnv | null = null;
  let runtime: JobRuntime | null = null;
  pi.on("session_start", (_event, ctx) => {
    const env: ToolEnv = {
      cwd: ctx.cwd,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      isProjectTrusted: () => ctx.isProjectTrusted(),
      signal: ctx.signal,
      dispatchModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      dispatchThinking: ctx.thinkingLevel,
      bundledAgentsDir: undefined,
      userAgentsDir: undefined,
      contracts: makeContractsResolver(),
    };
    envRef = env;
    const config = loadConfig(ctx.cwd, process.env, ctx.isProjectTrusted());
    const runsDir = resolveRunsDir(config);
    reconcileStartup(runsDir);
    runtime = makeJobRuntime(env);
    const due = triggerDueJobs(runsDir, (spec) => ({ mode: spec.mode, agentNames: itemsOf(spec).map((i) => i.agent) }));
    for (const job of due) queueJobExecution(job, runtime);
    startScheduler(runtime, (spec) => ({ mode: spec.mode, agentNames: itemsOf(spec).map((i) => i.agent) }));
  });
  pi.on("session_shutdown", () => {
    stopScheduler();
    runtime = null;
    envRef = null;
  });
}

/** Session-scoped fleet widget/overlay lifecycle. TUI components are never created headlessly. */
function wireFleetLifecycle(pi: ExtensionAPI): void {
  let pulse: NodeJS.Timeout | null = null;
  let clearWidget: (() => void) | null = null;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const config = loadConfig(ctx.cwd, process.env, ctx.isProjectTrusted());
    ctx.ui.setWidget("ops-fleet", (tui) => {
      if (!pulse) pulse = setInterval(() => {
        updateStaleness(Date.now(), config.fleetStaleAfterMs);
        evictRetained(Date.now(), config.fleetRetentionMs, config.fleetRetentionCount);
        tui.requestRender();
      }, 250);
      pulse.unref?.();
      return {
        render: (width: number) => renderFleetWidget(displayRuns(), width, { lines: config.fleetWidgetLines }),
        invalidate: () => {},
      };
    });
    clearWidget = () => ctx.ui.setWidget("ops-fleet", undefined);
    pi.registerShortcut(config.fleetShortcut as any, {
      description: "Open the focused subagent fleet overlay.",
      handler: async (shortcutCtx) => {
        if (shortcutCtx.mode !== "tui") return;
        await shortcutCtx.ui.custom<void>((tui, _theme, _keybindings, done) =>
          createFleetOverlay(() => done(), () => tui.requestRender()),
          { overlay: true, overlayOptions: { width: "100%", maxHeight: "90%" } },
        );
      },
    });
  });
  pi.on("session_shutdown", () => {
    if (pulse) clearInterval(pulse);
    pulse = null;
    clearWidget?.();
    clearWidget = null;
  });
}

function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate tasks to isolated pi subagents (single, parallel, or chain). See the parameter schema for modes, units, defaults, and dependency rules.",
    parameters: subagentParameters,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const env: ToolEnv = {
        cwd: ctx.cwd,
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        isProjectTrusted: () => ctx.isProjectTrusted(),
        signal,
        dispatchModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
        dispatchThinking: ctx.thinkingLevel,
        uiConfirm: (title, body) => ctx.ui.confirm(title, body),
        onUpdate: (partial) => onUpdate?.(partial),
        notify: (message, level) => ctx.ui.notify(message, level ?? "info"),
        contracts: makeContractsResolver(),
        queueBackground: (call, env) => makeBackgroundQueue(env)(call),
        sessionPersisted: ctx.sessionManager.getSessionFile() !== undefined,
        parentSessionId: ctx.sessionManager.getSessionId() ?? null,
        sessionResolution: (call, env) => makeSessionResolver(env)(call, env),
      };
      return await subagentExecute(params, env);
    },
  });
}
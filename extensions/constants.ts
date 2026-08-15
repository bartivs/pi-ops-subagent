/**
 * Shared exact v1 constants for pi-ops-subagent.
 *
 * All public vocabulary, defaults, caps, state values, and persistent-state
 * paths live here so behavioral changes require a spec update first.
 */

// --- Timeout ladder (subagent-runner) ---
/** Public tool/manifest field name for per-call timeout, in integer seconds. */
export const TIMEOUT_FIELD = "timeoutSeconds" as const;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const DEFAULT_CEILING_SECONDS = 900;
export const MIN_TIMEOUT_SECONDS = 1;
/** Cooldown between SIGTERM and SIGKILL in the termination ladder. */
export const KILL_COOLDOWN_MS = 5000;

// --- Concurrency governance (subagent-runner) ---
export const DEFAULT_CONCURRENCY = 2;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
export const MAX_PARALLEL_TASKS = 8;

// --- Output bounds (subagent-runner) ---
export const OUTPUT_CAP_BYTES = 51200;
export const OUTPUT_CAP_LINES = 2000;

// --- Fleet lifecycle (fleet-cockpit / subagent-runner) ---
export const FLEET_STATES = [
  "queued",
  "starting",
  "running",
  "finalizing",
  "done",
  "failed",
  "timed_out",
  "aborted",
] as const;
export type FleetState = (typeof FLEET_STATES)[number];

export const TERMINAL_FLEET_STATES: ReadonlySet<FleetState> = new Set([
  "done",
  "failed",
  "timed_out",
  "aborted",
]);

/** Run history retained after finish. */
export const FLEET_RETENTION_MS = 900000; // 15 minutes
export const FLEET_RETENTION_COUNT = 50;
export const MIN_FLEET_RETENTION_MS = 0;
export const MAX_FLEET_RETENTION_COUNT = 500;

/** An active run without a progress event for this long is flagged stale. */
export const FLEET_STALE_AFTER_MS = 30000;
export const MIN_FLEET_STALE_AFTER_MS = 5000;

/** Bounded/redacted activity + output-tail storage. */
export const ACTIVITY_LIMIT = 200;
export const OUTPUT_TAIL_LINES = 100;
export const OUTPUT_TAIL_LINE_BYTES = 2000;

/** Passive widget budget. */
export const DEFAULT_FLEET_WIDGET_LINES = 3;
export const MIN_FLEET_WIDGET_LINES = 1;
export const MAX_FLEET_WIDGET_LINES = 8;
export const DEFAULT_FLEET_SHORTCUT = "alt+o";

/** Wide/narrow overlay breakpoints (fleet-cockpit ASCII templates). */
export const OVERLAY_WIDE_WIDTH = 100;
export const OVERLAY_NARROW_WIDTH = 40;

/** Exact ASCII-only status tags. */
export const FLEET_STATUS_TAGS: Record<FleetState, string> = {
  queued: "[WAIT]",
  starting: "[START]",
  running: "[RUN]",
  finalizing: "[FINAL]",
  done: "[OK]",
  failed: "[ERR]",
  timed_out: "[TIME]",
  aborted: "[ABRT]",
};

// --- Jobs (background-jobs) ---
export const JOB_STATES = [
  "queued",
  "running",
  "done",
  "failed",
  "interrupted",
  "canceled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const REGISTRY_FILE = "registry.json" as const;
export const JOB_ARTIFACT_FILES = ["meta.json", "digest.md", "evidence.jsonl", "usage.json"] as const;
export const SCHEDULER_TICK_MS = 10000;
export const MIN_INTERVAL_SECONDS = 60;
export const JOB_ARTIFACT_MODE = 0o600;

// --- Sessions (named-sessions) ---
export const SESSION_EXPIRY_MS = 604_800_000; // 7 days idle
export const MIN_SESSION_EXPIRY_MS = 60_000;
export const LOCK_HEARTBEAT_MS = 5000;
export const LOCK_STALE_MS = 30000;
export const SESSION_META_FILE = "meta.json" as const;
export const SESSION_LOCK_FILE = "lock.json" as const;
export const SESSION_DERIVATION_PREFIX = "ops/v1" as const;

// --- Project state layout ---
/** Conventional hidden project ops directory (state root when no config file). */
export const OPS_DIR_NAME = ".ops" as const;
export const CONFIG_FILE_NAME = "config.json" as const;
/** Conventional project agent folder name, resolved against the project root. */
export const DEFAULT_CONTRACTS_DIR = "contracts" as const;
export const DEFAULT_RUNS_DIR = "runs" as const;
export const DEFAULT_SESSIONS_DIR = "sessions" as const;

/** Trust approval file location: `<getAgentDir()>/pi-ops-subagent/trust.json`. */
export const TRUST_SUBDIR = "pi-ops-subagent" as const;
export const TRUST_FILE_NAME = "trust.json" as const;

// --- Environment variables ---
export const ENV_TIMEOUT_MS = "PI_OPS_TIMEOUT_MS" as const;
export const ENV_TIMEOUT_CEILING_MS = "PI_OPS_TIMEOUT_CEILING_MS" as const;
export const ENV_CONCURRENCY = "PI_OPS_CONCURRENCY" as const;
export const ENV_ALLOW_PROJECT_AGENTS = "PI_OPS_ALLOW_PROJECT_AGENTS" as const;
export const ENV_ALLOW_PROJECT_AGENTS_VALUE = "1" as const;

// --- Identity ---
/** Stable run id prefix: `run-<UUID v4>`. */
export const RUN_ID_PREFIX = "run-" as const;
/** Stable evidence id prefix: `ev-<UUID v4>`. */
export const EVIDENCE_ID_PREFIX = "ev-" as const;
/** Stable job id prefix. */
export const JOB_ID_PREFIX = "job-" as const;

/** Session display name template. */
export const SESSION_DISPLAY_PREFIX = "ops: " as const;
export const SESSION_DISPLAY_SEPARATOR = " \u00B7 "; // "ops: <agent> · <handle>"

// --- Config defaults (config.ts) ---
export const CONFIG_DEFAULTS = {
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  timeoutCeilingSeconds: DEFAULT_CEILING_SECONDS,
  concurrency: DEFAULT_CONCURRENCY,
  includeBundledAgents: true,
  agentDirs: [] as string[],
  defaultContract: null as string | null,
  contractsDir: DEFAULT_CONTRACTS_DIR,
  runsDir: DEFAULT_RUNS_DIR,
  sessionsDir: DEFAULT_SESSIONS_DIR,
  sessionExpiryMs: SESSION_EXPIRY_MS,
  fleetShortcut: DEFAULT_FLEET_SHORTCUT,
  fleetWidgetLines: DEFAULT_FLEET_WIDGET_LINES,
  fleetRetentionMs: FLEET_RETENTION_MS,
  fleetRetentionCount: FLEET_RETENTION_COUNT,
  fleetStaleAfterMs: FLEET_STALE_AFTER_MS,
} as const;

export const CONFIG_KEYS = Object.freeze(Object.keys(CONFIG_DEFAULTS));
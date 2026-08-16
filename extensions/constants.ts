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

// --- Initializer (agent-init) ---
/** Public command name. */
export const INIT_COMMAND_NAME = "/ops:agent-init" as const;
/** Custom message type carrying the natural-language prompt to the current agent. */
export const INIT_MESSAGE_TYPE = "ops:agent-init-request" as const;
/** Stable initialization id prefix: `init-<UUID v4>`. */
export const INIT_ID_PREFIX = "init-" as const;
/** Stable immutable preview id prefix: `preview-<64 lowercase sha256 hex>`. */
export const INIT_PREVIEW_ID_PREFIX = "preview-" as const;

/** Exact initializer tool names registered once and kept inactive outside initialization. */
export const INIT_SCOPE_TOOL = "ops_agent_init_scope" as const;
export const INIT_STAGE_TOOL = "ops_agent_init_stage" as const;
export const INIT_COMMIT_TOOL = "ops_agent_init_commit" as const;
export const INIT_CANCEL_TOOL = "ops_agent_init_cancel" as const;

// --- Initializer lifecycle ---
export const INIT_STATES = [
  "resolving_scope",
  "researching",
  "staged",
  "committing",
  "completed",
  "cancelled",
  "failed",
] as const;
export type InitState = (typeof INIT_STATES)[number];

export const TERMINAL_INIT_STATES: ReadonlySet<InitState> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

// --- Bounds (v1 contract) ---
export const INIT_PROMPT_MIN_BYTES = 1;
export const INIT_PROMPT_MAX_BYTES = 20_000;
export const INIT_CONTEXT_ROOTS_MIN = 1;
export const INIT_CONTEXT_ROOTS_MAX = 8;
export const INIT_OUTPUT_ROOTS = 1;
export const INIT_MANIFESTS_MIN = 1;
export const INIT_MANIFESTS_MAX = 32;
export const INIT_BLUEPRINT_PROMPT_MIN_BYTES = 1;
export const INIT_BLUEPRINT_PROMPT_MAX_BYTES = 51_200;
export const INIT_BLUEPRINT_TEXT_MAX_BYTES = 1_000;
export const INIT_AGENTS_MD_MAX_BYTES = 1_048_576;
export const INIT_GUIDANCE_DISPLAY_BYTES = 300;
export const INIT_DIAGNOSTIC_BOUND_ENTRIES = 100;
export const INIT_DIAGNOSTIC_BOUND_BYTES = 51_200;
export const INIT_DIR_MODE = 0o755;
export const INIT_MANIFEST_MODE = 0o644;

// --- Guided-managed section markers ---
export const INIT_MARKER_START = "<!-- pi-ops-subagent:init:start -->" as const;
export const INIT_MARKER_END = "<!-- pi-ops-subagent:init:end -->" as const;

// --- Tool policy sets ---
/** The four initializer tools active from command start until terminal state. */
export const INIT_TOOLS: readonly string[] = [
  INIT_SCOPE_TOOL,
  INIT_STAGE_TOOL,
  INIT_COMMIT_TOOL,
  INIT_CANCEL_TOOL,
];
/** Least-privilege read-only inspection tools made callable after scope acceptance. */
export const INIT_READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
/** Exact optional network tools that MAY be activated when scope confirms `allowNetwork`. */
export const INIT_NETWORK_TOOLS: readonly string[] = [
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
];

// --- Managed / generated directory names ---
/** Conventional project agent folder name, resolved against the project root. */
export const DEFAULT_AGENTS_DIR = "agents" as const;
/** Trusted current-project blueprint directory name under the ops state dir. */
export const OPS_AGENT_BLUEPRINTS_DIR = "ops-agent-blueprints" as const;
/** The user blueprint root subdir under the agent dir: `pi-ops-subagent/blueprints`. */
export const USER_BLUEPRINTS_SUBDIR = `${TRUST_SUBDIR}/blueprints` as const;
/** Bundled blueprint assets subdir within the package root. */
export const BUNDLED_BLUEPRINTS_DIR = "blueprints" as const;

// --- Generic bundled blueprint pack (exact eight assets) ---
export const INIT_BUNDLED_BLUEPRINT_NAMES: readonly string[] = [
  "architecture-review",
  "testing-quality-review",
  "security-review",
  "data-persistence-review",
  "api-integrations-review",
  "performance-review",
  "deployment-operations-review",
  "documentation-review",
];
export const RECOMMENDED_BLUEPRINT_NAMES: ReadonlySet<string> = new Set([
  "architecture-review",
  "testing-quality-review",
  "security-review",
]);
export const BLUEPRINT_DEFAULT_KIND = "general" as const;
export const BLUEPRINT_DEFAULT_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
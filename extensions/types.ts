/**
 * Shared exact v1 types for pi-ops-subagent.
 *
 * Public field names, units, and shapes must match the spec vocabulary.
 * Do not add aliases; do not invent fallbacks.
 */

import type {
  FLEET_STATES,
  JOB_STATES,
  RUN_ID_PREFIX,
} from "./constants.ts";

// --- Identity ---
/** `run-<UUID v4>` per task. */
export type RunId = `${typeof RUN_ID_PREFIX}${string}`;
export type EvidenceId = `ev-${string}`;
export type JobId = `job-${string}`;

export interface Timing {
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  elapsedMs: number;
}

// --- Usage accounting (exact per-run numbers) ---
export interface UsageSummary {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  reasoning: number;
  cost: number;
}

export function emptyUsage(): UsageSummary {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0, cost: 0 };
}

/** Result-level stop reason: `done` for success; other values are terminal failures. */
export type StopReason = "end" | "stop" | "length" | "error" | "aborted" | "canceled" | (string & {});

// --- Catalog ---
export type AgentKind = "general" | "probe" | "artifact";
export type AgentSourceKind = "bundled" | "user" | "project" | "configured";

export interface CatalogShadow {
  name: string;
  source: AgentSourceKind;
  canonicalPath: string;
}

export interface CatalogEntry {
  name: string;
  description: string;
  kind: AgentKind;
  tools: string[];
  model?: string;
  timeoutSeconds?: number;
  thresholds?: ThresholdSpec[];
  contract?: string;
  systemPrompt: string;
  source: AgentSourceKind;
  canonicalPath: string;
  /** SHA-256 hex of the file content. */
  contentHash: string;
  body: string;
}

export interface CatalogDiagnostics {
  /** Canonical path -> per-file validation problems. */
  invalidFiles: Array<{ canonicalPath: string; message: string }>;
  /** Duplicate names within one source directory. */
  duplicateNames: Array<{ name: string; canonicalPaths: string[] }>;
  /** Directory read failures. */
  directoryErrors: Array<{ dir: string; message: string }>;
  /** Trust exclusions for project/configured sources. */
  trustExclusions: Array<{ canonicalPath: string; reason: string }>;
}

export interface CatalogSnapshot {
  entries: CatalogEntry[];
  /** Ordered source classes actually scanned (configured dirs, project, user, bundled). */
  sourceOrder: string[];
  shadowed: Array<{ name: string; source: AgentSourceKind; canonicalPath: string }>;
  configPath: string | null;
  includeBundledAgents: boolean;
  diagnostics: CatalogDiagnostics;
  /** Canonical path -> approval state for project/configured entries. */
  approvedByPath: Map<string, boolean>;
  /** Project/configured entries that require (re)approval before execution. */
  unapprovedEntries: Array<CatalogEntry & { approved: boolean }>;
}

// --- Probe protocol ---
export type ThresholdOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
export type ThresholdSeverity = "warning" | "critical";
export type ThresholdResult = "normal" | "warning" | "critical" | "not_evaluated";

export interface ThresholdSpec {
  id: string;
  metric: string;
  operator: ThresholdOperator;
  value: number;
  unit: string;
  severity: ThresholdSeverity;
}

export type EvidenceStatus =
  | "collected"
  | "permission_denied"
  | "unavailable"
  | "policy_denied";

export interface EvidenceEntry {
  evidenceId: EvidenceId;
  timestamp: string;
  targetId: string | null;
  profile: string;
  args: string[];
  exitCode: number | null;
  status: EvidenceStatus;
  output: string;
  error?: string;
}

export type Confidence = "high" | "medium" | "low";

// --- Contracts (env-contracts) ---
export interface ContractDoc {
  name: string;
  version: 1;
  targetId: string;
  expectedIdentity: string;
  verifyProfile: string;
  connectionProfile: string;
  naming: Record<string, string>;
  runbooks: string[];
  baselines: Record<string, string | number>;
  notes: string;
  canonicalPath: string;
  contentHash: string;
}

// --- Runner / observability ---
export type RunMode = "single" | "parallel" | "chain";

export interface TaskRef {
  agent: string;
  task: string;
  cwd?: string;
}

export interface RunActivityEvent {
  t: string;
  kind: string;
  detail: string;
}export interface RunSnapshot {
  runId: RunId;
  state: (typeof FLEET_STATES)[number];
  mode: RunMode;
  inputIndex: number | null;
  chainStep: number | null;
  agent: string;
  agentSource: AgentSourceKind | null;
  manifestPath: string | null;
  taskLabel: string;
  cwd: string;
  model: string | null;
  timeoutRequestedSeconds: number | null;
  timeoutEffectiveSeconds: number | null;
  timeoutClamped: boolean;
  queueReason: string | null;
  parentJobId: string | null;
  sessionKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  elapsedMs: number | null;
  stopReason: StopReason | null;
  usage: UsageSummary;
  activity: ActivityEvent[];
  outputTail: string[];
  digest: string | null;
  error: string | null;
  resultArtifactPath: string | null;
  stale: boolean;
  /** Immutable from first terminal transition. */
  terminal: boolean;
}

export interface ActivityEvent {
  timestamp: string;
  kind: string;
  detail: string;
}

// Run write budget shorthand — mirrors `RunSnapshot` slice used by renderers.
export interface RunDetailsBrief {
  runId: RunId;
  agent: string;
  source: AgentSourceKind | null;
  state: (typeof FLEET_STATES)[number];
  taskLabel: string;
  model: string | null;
  cwd: string;
  elapsedMs: number | null;
  timeoutEffectiveSeconds: number | null;
  lastActivityAt: string | null;
  cost: number;
  turns: number;
  toolCalls: number;
  digest: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

// --- Jobs (background-jobs) ---
export type JobSchedule =
  | { kind: "interval"; intervalSec: number }
  | { kind: "once"; at: string };

export interface JobRecord {
  jobId: JobId;
  state: (typeof JOB_STATES)[number];
  /** Immutable run spec (the exact tool call payload that created it). */
  spec: Record<string, unknown>;
  mode: RunMode;
  agents: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  ownerPid: number | null;
  schedule: JobSchedule | null;
  nextRunAt: string | null;
  resumedFromJobId: JobId | null;
  artifactDir: string | null;
  error: string | null;
}

export interface RegisteredRegistry {
  version: 1;
  jobs: JobRecord[];
}

export interface RunJobsDependency {
  /** scheduled next runs checks tick every SCHEDULER_TICK_MS */
  schedulerTickMs: number;
  runAsyncMaxTtlMs: number;
}

// --- Sessions (named-sessions) ---
export type SessionState = "active" | "expired" | "ended";

export interface SessionMeta {
  version: 1;
  key: string;
  agent: string;
  handle: string;
  displayName: string;
  derivation: {
    parentSessionId: string;
    effectiveCwd: string;
    agent: string;
    handle: string;
  };
  childSessionPath: string | null;
  state: SessionState;
  createdAt: string;
  lastUsedAt: string;
}

export interface SessionLock {
  pid: number;
  runId: string | null;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface SessionSummary {
  key: string;
  handle: string;
  agent: string;
  displayName: string;
  canonicalCwd: string;
  state: SessionState;
  childSessionPath: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  lockOwnerPid: number | null;
  lockAgeMs: number | null;
}

// --- Artifacts (incident-artifacts) ---
export const ARTIFACT_TYPES = ["triage", "comms", "pir"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface SharedArtifactFields {
  schemaVersion: "1";
  artifactType: ArtifactType;
  generatedAt: string;
  missingInformation: string[];
  redactions: number;
}

export type ArtifactObject = SharedArtifactFields & Record<string, unknown>;

export interface ArtifactOutcome {
  status: "done" | "failed";
  artifact?: ArtifactObject;
  error?: string;
}

export type ArtifactComposition = Partial<Record<ArtifactType, ArtifactOutcome>>;
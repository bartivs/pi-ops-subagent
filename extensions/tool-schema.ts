/**
 * Strict TypeBox schema for the `subagent` tool (design D2 / subagent-runner
 * spec). Exactly one mode shape: single, parallel, or chain. Common optional
 * fields with exact descriptions naming modes, units, defaults, and dependency
 * rules. All objects reject unknown fields (`additionalProperties: false`).
 */
import { Type } from "typebox";
import { MAX_PARALLEL_TASKS, MIN_TIMEOUT_SECONDS } from "./constants.ts";

const NAME_PATTERN = "^[a-z][a-z0-9-]{0,63}$";
const HANDLE_PATTERN = "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$";
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const TaskItem = Type.Object(
  {
    agent: Type.String({ minLength: 1, description: `Name of a manifest in the effective catalog (pattern ${NAME_PATTERN}).` }),
    task: Type.String({ minLength: 1, description: "Delegated task for this child. Chain steps may use {previous}." }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the child process (default: parent cwd)." })),
  },
  { additionalProperties: false },
);

const ChainItem = Type.Object(
  {
    agent: Type.String({ minLength: 1, description: `Name of a manifest in the catalog (pattern ${NAME_PATTERN}).` }),
    task: Type.String({ minLength: 1, description: "Delegated task; every {previous} is replaced with the prior bounded digest." }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the child process." })),
  },
  { additionalProperties: false },
);

const IntervalSchedule = Type.Object(
  {
    intervalSec: Type.Integer({ minimum: 60, description: "Repeat interval in whole seconds (minimum 60)." }),
  },
  { additionalProperties: false },
);

const AtSchedule = Type.Object(
  {
    at: Type.String({ description: "One-shot RFC3339 timestamp with timezone, e.g. 2026-01-02T03:04:05Z." }),
  },
  { additionalProperties: false },
);

const CommonFields = {
  timeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: MIN_TIMEOUT_SECONDS,
      description: `Per-call timeout in integer seconds (minimum ${MIN_TIMEOUT_SECONDS}). Precedence: call > manifest > project config > PI_OPS_TIMEOUT_MS/1000 > 300; then clamped to the ceiling.`,
    }),
  ),
  contracts: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 0,
      maxItems: 4,
      description: "Explicit env-contract names in selection order (0-4, unique). Overrides manifest/config defaults.",
    }),
  ),
  session: Type.Optional(
    Type.String({
      pattern: HANDLE_PATTERN,
      description: `Named-session handle (pattern ${HANDLE_PATTERN}, max 64 chars). Continues one child pi session per agent+name+cwd+parent.`,
    }),
  ),
  restartExpired: Type.Optional(
    Type.Boolean({ description: "When true, expiry and a fresh child are allowed on the next call. Requires session." }),
  ),
  runAsync: Type.Optional(Type.Boolean({ description: "When true, queue as a durable background job and return a jobId immediately." })),
  schedule: Type.Optional(Type.Union([IntervalSchedule, AtSchedule], {
    description: "Requires runAsync: true. Exactly one of intervalSec (>= 60) or at (RFC3339 with timezone). No cron.",
  })),
};

const SingleParams = Type.Object(
  {
    agent: Type.String({ minLength: 1, description: "Name of the agent to invoke (single mode)." }),
    task: Type.String({ minLength: 1, description: "Task to delegate (single mode)." }),
    ...CommonFields,
  },
  { additionalProperties: false },
);

const ParallelParams = Type.Object(
  {
    tasks: Type.Array(TaskItem, {
      minItems: 1,
      maxItems: MAX_PARALLEL_TASKS,
      description: `Parallel mode: 1-${MAX_PARALLEL_TASKS} {agent, task} objects; results return in input order.`,
    }),
    ...CommonFields,
  },
  { additionalProperties: false },
);

const ChainParams = Type.Object(
  {
    chain: Type.Array(ChainItem, {
      minItems: 1,
      maxItems: MAX_PARALLEL_TASKS,
      description: `Chain mode: 1-${MAX_PARALLEL_TASKS} sequential {agent, task} steps; stops after the first non-done step.`,
    }),
    ...CommonFields,
  },
  { additionalProperties: false },
);

/** The shape exposed to models. Exactly one of the three mode objects matches. */
export const subagentParameters = Type.Union([SingleParams, ParallelParams, ChainParams], {
  description: [
    "Delegate one or more tasks to isolated pi subagents.",
    "Modes (exactly one):",
    "- single: {agent, task, cwd?}",
    "- parallel: {tasks: [1-8 x {agent, task, cwd?}]}",
    "- chain: {chain: [1-8 x {agent, task, cwd?}]}",
    "Common fields: timeoutSeconds (int >= 1, seconds), contracts (0-4 names), session (handle), restartExpired, runAsync, schedule.",
    "schedule requires runAsync: true. restartExpired requires session. More than 8 tasks is rejected before spawn.",
  ].join(" "),
});

export type SubagentParameters = typeof subagentParameters;

/** Runtime-checkable plain shape consumed by the runner. */
export interface SubagentCall {
  mode: "single" | "parallel" | "chain";
  agent?: string;
  task?: string;
  cwd?: string;
  tasks?: Array<{ agent: string; task: string; cwd?: string }>;
  chain?: Array<{ agent: string; task: string; cwd?: string }>;
  timeoutSeconds?: number;
  contracts?: string[];
  session?: string;
  restartExpired?: boolean;
  runAsync?: boolean;
  schedule?: { intervalSec?: number; at?: string };
}

export interface InputValidationError extends Error {
  kind: string;
}

function fail(kind: InputValidationError["kind"], message: string): never {
  const e = new Error(message) as InputValidationError;
  e.kind = kind;
  throw e;
}

/**
 * Runtime validation. Model-generated arguments can be invalid even when the
 * schema is supplied (DeepSeek API guidance), so the runner validates again
 * before any child or job is created. Validates exactly-one-mode, empty
 * arrays, > 8 items (hard max, not configurable), unknown fields, and
 * dependent fields (schedule → runAsync; restartExpired → session).
 */
export function checkSubagentInput(input: unknown): SubagentCall {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("invalid-mode", 'subagent input must be an object with exactly one of "agent"/"tasks"/"chain".');
  }
  const raw = input as Record<string, unknown>;
  const KNOWN = new Set(["agent", "task", "cwd", "tasks", "chain", "timeoutSeconds", "contracts", "session", "restartExpired", "runAsync", "schedule"]);
  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key)) {
      fail("invalid-field", `Unknown field: "${key}".`);
    }
  }
  const hasSingle = "agent" in raw;
  const hasTasks = "tasks" in raw;
  const hasChain = "chain" in raw;
  const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);
  if (modeCount === 0) fail("invalid-mode", 'Provide exactly one mode: "agent" (single), "tasks" (parallel), or "chain" (chain).');
  if (modeCount > 1) fail("invalid-mode", 'Provide exactly one mode; "agent", "tasks", and "chain" are mutually exclusive.');

  const common = pickCommon(raw);
  if (raw["agent"] !== undefined) {
    if (typeof raw["agent"] !== "string" || raw["agent"].length === 0) fail("invalid-mode", '"agent" must be a non-empty string.');
    if (typeof raw["task"] !== "string" || raw["task"].length === 0) fail("invalid-mode", 'Single mode requires "task".');
    return { mode: "single", agent: raw["agent"], task: raw["task"], ...common, cwd: asOptionalString(raw["cwd"]) };
  }
  if (hasTasks) {
    const items = validateItems(raw["tasks"], "tasks");
    return { mode: "parallel", tasks: items, ...common };
  }
  const items = validateItems(raw["chain"], "chain");
  return { mode: "chain", chain: items, ...common };
}

function validateItems(value: unknown, field: "tasks" | "chain") {
  if (!Array.isArray(value)) fail("invalid-mode", `"${field}" must be an array.`);
  if (value.length === 0) fail("invalid-items", `"${field}" must contain at least one item.`);
  if (value.length > MAX_PARALLEL_TASKS) {
    fail("max-count", `"${field}" exceeds the hard maximum of ${MAX_PARALLEL_TASKS} items.`);
  }
  return value.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail("invalid-items", `${field}[${i}] must be an object with "agent" and "task".`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r["agent"] !== "string" || r["agent"].length === 0) fail("invalid-items", `${field}[${i}].agent must be a non-empty string.`);
    if (typeof r["task"] !== "string" || r["task"].length === 0) fail("invalid-items", `${field}[${i}].task must be a non-empty string.`);
    return { agent: r["agent"], task: r["task"], cwd: asOptionalString(r["cwd"]) };
  });
}

function asOptionalString(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) fail("invalid-mode", "cwd must be a non-empty string.");
  return v;
}

function pickCommon(raw: Record<string, unknown>) {
  const out: {
    timeoutSeconds?: number;
    contracts?: string[];
    session?: string;
    restartExpired?: boolean;
    runAsync?: boolean;
    schedule?: { intervalSec?: number; at?: string };
  } = {};
  const push = <K extends keyof typeof out>(key: K, validate: (v: unknown) => void) => {
    if (raw[key] !== undefined) {
      validate(raw[key]);
      out[key] = raw[key] as never;
    }
  };
  push("timeoutSeconds", (v) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_TIMEOUT_SECONDS) {
      fail("invalid-mode", `timeoutSeconds must be an integer >= ${MIN_TIMEOUT_SECONDS}.`);
    }
  });
  push("contracts", (v) => {
    if (!Array.isArray(v) || v.length > 4 || v.some((x) => typeof x !== "string" || x.length === 0)) {
      fail("invalid-mode", "contracts must be an array of 0-4 non-empty unique names.");
    }
    if (new Set(v as string[]).size !== (v as string[]).length) {
      fail("invalid-mode", "contracts entries must be unique.");
    }
  });
  push("session", (v) => {
    if (typeof v !== "string" || !new RegExp(HANDLE_PATTERN).test(v)) {
      fail("invalid-mode", `session handle must match ${HANDLE_PATTERN}.`);
    }
  });
  push("restartExpired", (v) => {
    if (typeof v !== "boolean") fail("invalid-mode", "restartExpired must be a boolean.");
  });
  push("runAsync", (v) => {
    if (typeof v !== "boolean") fail("invalid-mode", "runAsync must be a boolean.");
  });
  if (raw["schedule"] !== undefined) {
    const s = raw["schedule"];
    if (typeof s !== "object" || s === null || Array.isArray(s)) fail("invalid-mode", "schedule must be an object.");
    const r = s as Record<string, unknown>;
    const hasInterval = "intervalSec" in r;
    const hasAt = "at" in r;
    if (hasInterval === hasAt) {
      fail("invalid-mode", 'schedule must contain exactly one of "intervalSec" or "at" (no cron in v1).');
    }
    if (hasInterval) {
      if (typeof r["intervalSec"] !== "number" || !Number.isInteger(r["intervalSec"]) || r["intervalSec"] < 60) {
        fail("invalid-mode", "schedule.intervalSec must be an integer >= 60.");
      }
      out.schedule = { intervalSec: r["intervalSec"] };
    } else {
      if (typeof r["at"] !== "string" || !RFC3339_RE.test(r["at"])) {
        fail("invalid-mode", "schedule.at must be an RFC3339 timestamp with timezone.");
      }
      out.schedule = { at: r["at"] };
    }
  }
  if (out.schedule !== undefined && out.runAsync !== true) {
    fail("invalid-dependency", "schedule requires runAsync: true.");
  }
  if (out.restartExpired === true && out.session === undefined) {
    fail("invalid-dependency", "restartExpired requires session.");
  }
  return out;
}

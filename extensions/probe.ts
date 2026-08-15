/**
 * Probe protocol (probe-protocol spec, design D4).
 *
 * - `kind: probe` manifests receive a runtime preamble and tool narrowing
 *   (read/grep/find/ls/probe_exec; never bash/write/edit).
 * - `probe_exec` accepts `{profile, args, target}` and spawns the fixed
 *   executable with `shell: false` after policy validation; denial evidence is
 *   recorded with status `policy_denied`.
 * - Contract-backed probes verify the target FIRST with `verifyProfile`;
 *   exact expected/observed identity matching with no local fallback.
 * - Threshold evaluation with unit normalization and explicit
 *   `not_evaluated`; digests are evidence-linked.
 * - Mutation is proposal-only in v1.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Confidence,
  EvidenceEntry,
  EvidenceStatus,
  ThresholdResult,
  ThresholdSpec,
} from "./types.ts";
import { EVIDENCE_ID_PREFIX } from "./constants.ts";
import { redactSensitive } from "./redact.ts";
import { executableFor, getProfile, validateProfileArgs, registeredProfileIds, ProfileError } from "./probe-profiles.ts";

export class ProbeError extends Error {
  constructor(message: string, public readonly category: "policy" | "target" | "exec" | "contract") {
    super(message);
    this.name = "ProbeError";
  }
}

// ---------------------------------------------------------------------------
// 4.1 Runtime preamble + tool narrowing
// ---------------------------------------------------------------------------

export const PROBE_PREAMBLE = [
  "PROBE PROTOCOL (read-only):",
  "- You are a read-only diagnostic agent. You may use read, grep, find, ls, and probe_exec only.",
  "- You have NO bash, write, edit, or any mutation tool. Never attempt them.",
  "- Verify the target first: for a contract-backed probe, run the contract's verifyProfile and",
  "  confirm the observed identity exactly matches expectedIdentity before any other diagnostic.",
  "- Never fall back to the local machine when the target is unverified.",
  "- Cite evidenceIds from probe_exec output; never invent command output, values, or metrics.",
  "- Unknown or uncollected data is reported as 'not collected / not_evaluated', never guessed.",
  "- Mutations are proposal-only: describe them under 'Proposed actions' with approvalRequired: true.",
].join("\n");

/** Probe children never receive unrestricted shell or file-mutation tools. */
export const PROBE_TOOL_ALLOWLIST = ["read", "grep", "find", "ls", "probe_exec"] as const;
export const PROBE_DENIED_TOOLS = ["bash", "write", "edit"] as const;

// ---------------------------------------------------------------------------
// Probe policy file (parent -> child)
// ---------------------------------------------------------------------------

export interface ProbePolicy {
  version: 1;
  runId: string;
  targetId: string | null;
  expectedIdentity: string | null;
  verifyProfile: string | null;
  /** Absolute path where the child appends evidence JSONL. */
  evidenceFile: string;
  /** Absolute path where the child marks verification failure. */
  failMarker: string;
}

export function writeProbePolicy(dir: string, policy: ProbePolicy): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "probe-policy.json");
  fs.writeFileSync(file, JSON.stringify(policy, null, 2), { mode: 0o600 });
  return file;
}

export function readProbePolicy(file: string): ProbePolicy | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ProbePolicy;
    if (parsed.version !== 1 || typeof parsed.evidenceFile !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function newEvidenceId(): `ev-${string}` {
  return `${EVIDENCE_ID_PREFIX}${randomUUID()}` as `ev-${string}`;
}

// ---------------------------------------------------------------------------
// Evidence store
// ---------------------------------------------------------------------------

export function appendEvidence(evidenceFile: string, entry: EvidenceEntry): void {
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.appendFileSync(evidenceFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function readEvidence(evidenceFile: string): EvidenceEntry[] {
  try {
    const raw = fs.readFileSync(evidenceFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as EvidenceEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is EvidenceEntry => e !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 4.3 probe_exec: policy validation + execution
// ---------------------------------------------------------------------------

export interface ProbeExecRequest {
  profile: string;
  args: string[];
  target: string | null;
}

/** Strict input validation: registered profile, safe args, target match. */
export function validateProbeExecInput(req: unknown, policy: ProbePolicy | null): ProbeExecRequest {
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    throw new ProbeError('probe_exec input must be an object {profile, args, target}', "policy");
  }
  const raw = req as Record<string, unknown>;
  const profile = raw["profile"];
  const args = raw["args"];
  const target = raw["target"] ?? null;
  if (typeof profile !== "string" || profile.length === 0) {
    throw new ProbeError("probe_exec requires a registered profile name", "policy");
  }
  const prof = getProfile(profile);
  if (!prof) {
    throw new ProbeError(
      `Unknown profile "${profile}". Registered profiles: ${registeredProfileIds().join(", ")}`,
      "policy",
    );
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new ProbeError("probe_exec args must be a string array", "policy");
  }
  const argError = validateProfileArgs(prof, args);
  if (argError) {
    throw new ProbeError(`probe_exec denied: ${argError}`, "policy");
  }
  if (policy) {
    if (policy.targetId !== null && target !== policy.targetId) {
      throw new ProbeError(
        `probe_exec target mismatch: expected "${policy.targetId}", got "${String(target)}"`,
        "target",
      );
    }
  } else if (target !== null) {
    throw new ProbeError("probe_exec target requires a configured contract for this run", "contract");
  }
  return { profile, args: args as string[], target: target as string | null };
}

export interface ProbeRunContext {
  policy: ProbePolicy | null;
  /** Per-target verification state (in-process, one child per run). */
  verifiedTargets: Map<string, boolean>;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Abort support. */
  signal?: AbortSignal;
}

export interface ProbeExecResult {
  evidence: EvidenceEntry;
}

/**
 * Execute one approved diagnostic. Spawns the fixed executable with
 * `shell: false`, never an arbitrary path. Policy denials and target
 * mismatches are recorded as evidence and reported before any process
 * creation. A failed verification is marked so the run cannot continue.
 */
export async function runProbeExec(
  req: ProbeExecRequest,
  ctx: ProbeRunContext,
): Promise<ProbeExecResult> {
  const policy = ctx.policy;
  if (!policy) {
    throw new ProbeError(
      "probe_exec is unavailable: target not configured (no contract applies to this run).",
      "contract",
    );
  }
  // 1) Strict input validation first: registered profile, safe args, target
  //    match. Unknown profiles/shell/mutation arguments are rejected before
  //    any process creation; no policy evidence is recorded for invalid input.
  const validated = validateProbeExecInput(req, policy);
  const targetId = policy.targetId ?? null;
  const evidenceId = newEvidenceId();

  // 2) Target verification gate (4.4): the first executable diagnostic must
  //    be the contract's verifyProfile and its normalized output must exactly
  //    match expectedIdentity. Until verified, every other profile is denied
  //    with policy_denied evidence.
  if (policy?.verifyProfile && policy.expectedIdentity !== null) {
    const verified = policy.targetId ? ctx.verifiedTargets.get(policy.targetId) === true : false;
    if (!verified && validated.profile !== policy.verifyProfile) {
      const denied: EvidenceEntry = {
        evidenceId,
        timestamp: new Date().toISOString(),
        targetId,
        profile: validated.profile,
        args: validated.args,
        exitCode: null,
        status: "policy_denied",
        output: "",
        error: `target not verified: run ${policy.verifyProfile} first and match expectedIdentity`,
      };
      if (policy.evidenceFile) appendEvidence(policy.evidenceFile, denied);
      throw new ProbeError(
        `probe_exec denied: target not verified. Run "${policy.verifyProfile}" first; the observed identity must exactly match expectedIdentity.`,
        "target",
      );
    }
  }

  const exec = executableFor(validated.profile);
  let localEntry: EvidenceEntry | null = null;
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(exec, validated.args, { cwd: ctx.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let termSent = false;
    const killTimer = setTimeout(() => {
      termSent = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 5000);
    }, ctx.timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      out = (out + d.toString("utf8")).slice(-ctx.maxOutputBytes * 2);
    });
    child.stderr!.on("data", (d: Buffer) => {
      err = (err + d.toString("utf8")).slice(-16_384);
    });
    child.once("close", (code) => {
      clearTimeout(killTimer);
      const bounded = truncateUtf8(out, ctx.maxOutputBytes);
      const status: EvidenceStatus = code === 0 ? "collected" : code === null && termSent ? "unavailable" : "permission_denied";
      const entry: EvidenceEntry = {
        evidenceId,
        timestamp: new Date().toISOString(),
        targetId,
        profile: validated.profile,
        args: validated.args,
        exitCode: code,
        status,
        output: redactSensitive(bounded).text,
        error: err ? redactSensitive(err.slice(0, 2000)).text : undefined,
      };
      if (policy?.evidenceFile) appendEvidence(policy.evidenceFile, entry);
      localEntry = entry;
      resolve(code ?? 1);
    });
    child.once("error", (e) => {
      clearTimeout(killTimer);
      const entry: EvidenceEntry = {
        evidenceId,
        timestamp: new Date().toISOString(),
        targetId,
        profile: validated.profile,
        args: validated.args,
        exitCode: null,
        status: "unavailable",
        output: "",
        error: redactSensitive(e.message).text,
      };
      if (policy?.evidenceFile) appendEvidence(policy.evidenceFile, entry);
      localEntry = entry;
      resolve(1);
    });
  });

  // Verification: normalize the verifyProfile output and compare exactly.
  const alreadyVerified = policy.targetId ? ctx.verifiedTargets.get(policy.targetId) === true : false;
  if (policy?.verifyProfile && policy.expectedIdentity !== null && validated.profile === policy.verifyProfile && policy.targetId && !alreadyVerified) {
    const lastEv = readEvidence(policy.evidenceFile).at(-1);
    const observed = normalizeIdentity(lastEv?.output ?? "");
    const expected = policy.expectedIdentity;
    if (observed === expected) {
      ctx.verifiedTargets.set(policy.targetId, true);
    } else {
      if (policy.failMarker) {
        try {
          fs.writeFileSync(policy.failMarker, JSON.stringify({ evidenceId, expected, observed }, null, 2), { mode: 0o600 });
        } catch {
          /* ignore */
        }
      }
      throw new ProbeError(
        `Target verification FAILED: expected identity "${expected}", observed "${observed || "(empty)"}". No local fallback; probe aborted.`,
        "target",
      );
    }
  }

  return { evidence: localEntry! };
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let n = maxBytes;
  while (n > 0 && (buf[n - 1]! & 0xc0) === 0x80) n--;
  while (n > 0 && (buf[n - 1]! & 0xc0) === 0xc0) n--;
  return buf.subarray(0, n).toString("utf8");
}

/** Normalize an identity string: trim, collapse whitespace, lowercase. */
export function normalizeIdentity(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// 4.5 Thresholds
// ---------------------------------------------------------------------------

const UNIT_TABLE: Record<string, Record<string, number>> = {
  bytes: { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 },
  percent: { percent: 1, "%": 1 },
  seconds: { seconds: 1, s: 1, ms: 1 / 1000 },
  milliseconds: { ms: 1, s: 1000 },
  count: { count: 1, items: 1 },
  load: { load: 1 },
  ratio: { ratio: 1 },
};

export function normalizeValue(value: number, fromUnit: string, toUnit: string): number | null {
  const from = fromUnit.trim().toLowerCase();
  const to = toUnit.trim().toLowerCase();
  if (from === to) return value;
  for (const table of Object.values(UNIT_TABLE)) {
    if (from in table && to in table) {
      return (value * (table[from]! / table[to]!));
    }
  }
  return null;
}

export function evaluateThreshold(
  spec: ThresholdSpec,
  evidence: EvidenceEntry | undefined,
): { result: ThresholdResult; observed: number | null; reason: string } {
  if (!evidence) {
    return { result: "not_evaluated", observed: null, reason: `no evidence for metric "${spec.metric}"` };
  }
  if (evidence.status !== "collected") {
    return {
      result: "not_evaluated",
      observed: null,
      reason: `evidence ${evidence.evidenceId} status is ${evidence.status}`,
    };
  }
  const match = /(-?\d+(?:\.\d+)?)/.exec(evidence.output);
  if (!match) {
    return { result: "not_evaluated", observed: null, reason: `evidence ${evidence.evidenceId} has no numeric value` };
  }
  const raw = Number(match[1]);
  const normalized = normalizeValue(raw, evidenceUnitOf(evidence), spec.unit);
  if (normalized === null) {
    return {
      result: "not_evaluated",
      observed: raw,
      reason: `unit "${evidenceUnitOf(evidence)}" is incompatible with threshold unit "${spec.unit}"`,
    };
  }
  const crossed = compare(normalized, spec.operator, spec.value);
  if (!crossed) return { result: "normal", observed: normalized, reason: "" };
  return { result: spec.severity, observed: normalized, reason: "" };
}

function compare(observed: number, operator: ThresholdSpec["operator"], value: number): boolean {
  switch (operator) {
    case "gt": return observed > value;
    case "gte": return observed >= value;
    case "lt": return observed < value;
    case "lte": return observed <= value;
    case "eq": return observed === value;
    case "neq": return observed !== value;
  }
}

function evidenceUnitOf(evidence: EvidenceEntry): string {
  const out = evidence.output.trim();
  if (/%/.test(out)) return "percent";
  if (/\bms\b/.test(out)) return "milliseconds";
  if (/\bs\b/.test(out)) return "seconds";
  if (/\b[kmgtpe]b\b/i.test(out)) return "bytes";
  return "count";
}

export function evaluateThresholds(
  thresholds: ThresholdSpec[],
  evidence: EvidenceEntry[],
): Array<{ threshold: ThresholdSpec; result: ThresholdResult; evidenceId: string | null; observed: number | null; reason: string }> {
  return thresholds.map((t) => {
    const candidates = evidence.filter((e) => e.profile === t.metric || metricMatches(e, t.metric));
    const ev = candidates[candidates.length - 1];
    const r = evaluateThreshold(t, ev);
    return {
      threshold: t,
      result: r.result,
      evidenceId: ev?.evidenceId ?? null,
      observed: r.observed,
      reason: r.reason,
    };
  });
}

function metricMatches(evidence: EvidenceEntry, metric: string): boolean {
  // v1 heuristic: profile id is the metric key (e.g. "df" -> "df-usage").
  return evidence.profile === metric || metric.startsWith(`${evidence.profile}-`);
}

// ---------------------------------------------------------------------------
// Digest sections (no fabrication / confidence labels)
// ---------------------------------------------------------------------------

export interface DigestSectionInput {
  evidence: EvidenceEntry[];
  thresholds: ThresholdSpec[];
  interpretations: Array<{ text: string; confidence: Confidence; evidenceIds: string[] }>;
  proposedActions: Array<{ action: string; rationale: string; risk: string; prerequisites: string; rollback: string }>;
  unknowns: string[];
}

/** Canonical probe digest section layout. */
export function formatProbeDigest(input: DigestSectionInput): string {
  const lines: string[] = [];
  lines.push("# Observed");
  if (input.evidence.length === 0) lines.push("- (no observations collected)");
  for (const e of input.evidence) {
    const preview = e.output.split("\n")[0]?.slice(0, 200) ?? "";
    lines.push(`- ${e.evidenceId} ${e.profile} ${e.status}${preview ? `: ${preview}` : ""}`);
  }
  lines.push("");
  lines.push("# Threshold evaluation");
  const results = evaluateThresholds(input.thresholds, input.evidence);
  if (results.length === 0) lines.push("- (no thresholds configured)");
  for (const r of results) {
    lines.push(
      `- ${r.threshold.id}: ${r.result}${r.evidenceId ? ` (evidence ${r.evidenceId})` : ""}${r.reason ? ` — ${r.reason}` : ""}`,
    );
  }
  lines.push("");
  lines.push("# Interpretation");
  if (input.interpretations.length === 0) lines.push("- (none)");
  for (const i of input.interpretations) {
    lines.push(`- [${i.confidence}] ${i.text} ${i.evidenceIds.length > 0 ? `(evidence: ${i.evidenceIds.join(", ")})` : ""}`);
  }
  lines.push("");
  lines.push("# Unknown / not collected");
  for (const u of input.unknowns) lines.push(`- ${u}`);
  lines.push("");
  lines.push("# Proposed actions");
  for (const a of input.proposedActions) {
    lines.push(`- ${a.action} (approvalRequired: true; rationale: ${a.rationale}; risk: ${a.risk}; prerequisites: ${a.prerequisites}; rollback: ${a.rollback})`);
  }
  return lines.join("\n");
}
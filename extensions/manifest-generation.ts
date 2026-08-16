/**
 * Manifest staging, previews, and transaction commit (design D7/D8/D10 /
 * agent-manifest-generation spec).
 *
 * This module is the only writer of generated project agents and the managed
 * `AGENTS.md` guidance. Staging is pure (no filesystem mutation): it validates
 * the raw stage object, inherits blueprint defaults, serializes deterministically,
 * round-trips through the executable manifest validator, scans for secrets, and
 * builds an immutable `preview-<sha256>` preview. Commit runs the rollback-capable
 * same-directory transaction after revalidating the immutable preview.
 */
import { ManifestValidationError, parseManifest, sha256Hex } from "./catalog.ts";
import { findSecretHits } from "./redact.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  analyzeAgentsMd,
  composeGuidanceAgents,
  discoverGuidanceManifests,
  renderAgentsGuidance,
} from "./usage-guidance.ts";
import {
  BLUEPRINT_DEFAULT_KIND,
  BLUEPRINT_DEFAULT_TOOLS,
  DEFAULT_AGENTS_DIR,
  INIT_BLUEPRINT_PROMPT_MAX_BYTES,
  INIT_BLUEPRINT_PROMPT_MIN_BYTES,
  INIT_DIAGNOSTIC_BOUND_BYTES,
  INIT_DIAGNOSTIC_BOUND_ENTRIES,
  INIT_DIR_MODE,
  INIT_MANIFEST_MODE,
  INIT_PREVIEW_ID_PREFIX,
  INIT_READ_TOOLS,
} from "./constants.ts";
import type {
  AgentKind,
  BlueprintSource,
  InitAgentsMdPreview,
  InitBlueprint,
  InitDiagnostics,
  InitManifestPreview,
  InitPreview,
  InitPreviewId,

  InitId,
  ThresholdSpec,
} from "./types.ts";

/** A fully normalized, staging-only manifest draft (provenance never serialized). */
export interface NormalizedManifest {
  name: string;
  description: string;
  kind: AgentKind;
  tools: string[];
  model?: string;
  timeoutSeconds?: number;
  thresholds?: ThresholdSpec[];
  contract?: string;
  prompt: string;
  provenance: { source: BlueprintSource | "custom"; blueprintName?: string };
}

export class ManifestGenerationError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ManifestGenerationError";
  }
}

/** A staging-time validation error that leaves any prior preview current. */
export class StageManifestError extends ManifestGenerationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "StageManifestError";
  }
}

/**
 * Validate and normalize one staging manifest draft against the captured
 * blueprint snapshot. Missing `name`/`description` fail; omitted other fields
 * inherit blueprint values or use custom defaults; explicit `null` removes a
 * nullable optional value; `blueprintName` resolves from the snapshot.
 */
export function normalizeManifestDraft(
  draft: Record<string, unknown>,
  blueprints: InitBlueprint[],
): NormalizedManifest {
  const DRAFT_KEYS = new Set(["name", "description", "kind", "tools", "model", "timeoutSeconds", "thresholds", "contract", "prompt", "blueprintName"]);
  for (const key of Object.keys(draft)) {
    if (!DRAFT_KEYS.has(key)) throw new StageManifestError(`Unknown manifest field: "${key}"`);
  }
  const blueprint = findBlueprint(draft.blueprintName, blueprints);

  const name = draft.name;
  if (typeof name !== "string") throw new StageManifestError('Manifest "name" must be a string');
  const description = draft.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new StageManifestError('Manifest "description" must be a non-empty string');
  }

  const kind = optionalKind(draft.kind, blueprint);
  const tools = optionalTools(draft.tools, blueprint);
  const model = optionalNullable(draft, "model", blueprint, (v) => typeof v === "string" && v.trim().length > 0);
  const timeoutSeconds = optionalNullable(draft, "timeoutSeconds", blueprint, (v) => typeof v === "number" && Number.isInteger(v) && v >= 1);
  const thresholds = optionalThresholds(draft, blueprint);
  const contract = optionalNullable(draft, "contract", blueprint, (v) => typeof v === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(v));

  let prompt: string;
  if (draft.prompt !== undefined) {
    if (typeof draft.prompt !== "string") throw new StageManifestError('Manifest "prompt" must be a string');
    prompt = draft.prompt.trim();
  } else if (blueprint) {
    prompt = blueprint.prompt; // already trimmed at parse time
  } else {
    throw new StageManifestError('A custom manifest (no blueprintName) requires "prompt"');
  }
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes < INIT_BLUEPRINT_PROMPT_MIN_BYTES || promptBytes > INIT_BLUEPRINT_PROMPT_MAX_BYTES) {
    throw new StageManifestError(`Manifest "prompt" must be 1..${INIT_BLUEPRINT_PROMPT_MAX_BYTES} UTF-8 bytes after trimming`);
  }

  return {
    name,
    description,
    kind,
    tools,
    ...(model !== undefined ? { model: model as string } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds: timeoutSeconds as number } : {}),
    ...(thresholds !== undefined ? { thresholds: orderThresholds(thresholds) } : {}),
    ...(contract !== undefined ? { contract: contract as string } : {}),
    prompt,
    provenance: blueprint ? { source: blueprint.source, blueprintName: blueprint.name } : { source: "custom" },
  };
}

function findBlueprint(name: unknown, blueprints: InitBlueprint[]): InitBlueprint | null {
  if (name === undefined) return null;
  if (typeof name !== "string") throw new StageManifestError('Manifest "blueprintName" must be a string');
  const bp = blueprints.find((b) => b.name === name);
  if (!bp) throw new StageManifestError(`Unknown blueprintName "${name}" in the captured snapshot`);
  return bp;
}

function optionalKind(kind: unknown, bp: InitBlueprint | null): AgentKind {
  if (kind === undefined) return bp?.kind ?? BLUEPRINT_DEFAULT_KIND;
  if (typeof kind !== "string") throw new StageManifestError('Manifest "kind" must be a string');
  return kind as AgentKind;
}

function optionalTools(v: unknown, bp: InitBlueprint | null): string[] {
  const src = v !== undefined ? v : bp?.tools;
  if (src === undefined) return [...BLUEPRINT_DEFAULT_TOOLS];
  const list: unknown[] = Array.isArray(src) ? src : typeof src === "string" ? src.split(",") : [src];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    if (typeof t !== "string") throw new StageManifestError('Manifest "tools" entries must be strings');
    const c = t.trim();
    if (c === "" || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

function optionalNullable(
  draft: Record<string, unknown>,
  key: "model" | "timeoutSeconds" | "contract",
  bp: InitBlueprint | null,
  validate: (v: unknown) => boolean,
): string | number | undefined {
  if (draft[key] !== undefined) {
    if (draft[key] === null) return undefined; // explicit null removes the inherited value
    const v = draft[key];
    if (!validate(v)) throw new StageManifestError(`Manifest "${key}" has an invalid explicit value`);
    return v as string | number;
  }
  const inherited = bp?.[key];
  if (inherited === undefined) return undefined;
  return inherited as string | number;
}

function optionalThresholds(draft: Record<string, unknown>, bp: InitBlueprint | null): ThresholdSpec[] | undefined {
  if (draft.thresholds !== undefined) {
    if (draft.thresholds === null) return undefined;
    if (!Array.isArray(draft.thresholds)) throw new StageManifestError('Manifest "thresholds" must be an array');
    return draft.thresholds as ThresholdSpec[];
  }
  return bp?.thresholds;
}

function orderThresholds(thresholds: ThresholdSpec[]): ThresholdSpec[] {
  return thresholds.map((t) => ({
    id: t.id,
    metric: t.metric,
    operator: t.operator,
    value: t.value,
    unit: t.unit,
    severity: t.severity,
  }));
}

/** Returns the field label holding a secret-like literal, or null. No value is echoed. */
export function collectSecretField(normalized: NormalizedManifest): string | null {
  const has = (s: string): boolean => findSecretHits(s).length > 0;
  if (has(normalized.description)) return "description";
  if (normalized.model && has(normalized.model)) return "model";
  if (normalized.contract && has(normalized.contract)) return "contract";
  for (const t of normalized.thresholds ?? []) {
    if (has(t.metric)) return "thresholds.metric";
    if (has(t.unit)) return "thresholds.unit";
  }
  if (has(normalized.prompt)) return "prompt";
  return null;
}

/**
 * Serialize a normalized manifest to the exact generated-file grammar: UTF-8,
 * LF, frontmatter keys in normative order, JSON-compatible YAML values, trimmed
 * prompt, one final newline. Blueprint provenance is never serialized.
 */
export function serializeManifest(normalized: NormalizedManifest): string {
  const j = (v: string): string => JSON.stringify(v);
  const lines: string[] = [
    "---",
    `name: ${j(normalized.name)}`,
    `description: ${j(normalized.description)}`,
    `kind: ${j(normalized.kind)}`,
    `tools: ${JSON.stringify(normalized.tools)}`,
  ];
  if (normalized.model !== undefined) lines.push(`model: ${j(normalized.model)}`);
  if (normalized.timeoutSeconds !== undefined) lines.push(`timeoutSeconds: ${normalized.timeoutSeconds}`);
  if (normalized.thresholds !== undefined) lines.push(`thresholds: ${JSON.stringify(normalized.thresholds)}`);
  if (normalized.contract !== undefined) lines.push(`contract: ${j(normalized.contract)}`);
  lines.push("---", normalized.prompt);
  return lines.join("\n") + "\n";
}

/**
 * Serialize then round-trip through the executable `parseManifest` validator and
 * compare every normalized field, ensuring only valid executable manifests are
 * previewed. Throws on any mismatch or catalog validation failure.
 */
export function verifyRoundTrip(normalized: NormalizedManifest, canonicalPath: string): void {
  const text = serializeManifest(normalized);
  let parsed: ReturnType<typeof parseManifest>;
  try {
    parsed = parseManifest(canonicalPath, text, "project");
  } catch (e) {
    throw new StageManifestError(
      `Serialized manifest fails catalog validation: ${e instanceof ManifestValidationError ? e.message : "unexpected"}`,
    );
  }
  const checks: Array<[string, () => boolean]> = [
    ["name", () => parsed.entry.name === normalized.name],
    ["description", () => parsed.entry.description === normalized.description],
    ["kind", () => parsed.entry.kind === normalized.kind],
    ["tools", () => JSON.stringify(parsed.entry.tools) === JSON.stringify(normalized.tools)],
    ["model", () => JSON.stringify(parsed.entry.model ?? null) === JSON.stringify(normalized.model ?? null)],
    ["timeoutSeconds", () => JSON.stringify(parsed.entry.timeoutSeconds ?? null) === JSON.stringify(normalized.timeoutSeconds ?? null)],
    ["thresholds", () => JSON.stringify(parsed.entry.thresholds ?? null) === JSON.stringify(normalized.thresholds ?? null)],
    ["contract", () => (parsed.entry.contract ?? null) === (normalized.contract ?? null)],
    ["prompt", () => parsed.entry.body === normalized.prompt],
  ];
  const mismatch = checks.find(([, ok]) => !ok());
  if (mismatch) throw new ManifestGenerationError(`Round-trip mismatch on field "${mismatch[0]}"`);
}

// --- Preview building (task 4.2) ---

export interface PreviewBuildInput {
  initializationId: string;
  outputRoot: string;
  /** Normalized, round-trip-verified, secret-scanned manifests. */
  manifests: NormalizedManifest[];
  /** Exact names authorized for explicit replacement (default `[]`). */
  replaceExisting?: string[];
  configDirName?: string;
  /** Overrides for tests. */
  agentsDirOverride?: string;
  agentsMdPathOverride?: string;
}

export interface TextTargetInspection {
  name: string;
  action: "create" | "replace" | "unchanged";
  path: string;
  bytes: string;
  beforeHash?: string;
  afterHash: string;
  diff?: string;
}

function symlinkFreeDir(dir: string, throwDir: string): void {
  // Every existing segment, including ancestors of a not-yet-created directory,
  // must be a real directory rather than a symlink.
  let current = path.resolve(dir);
  while (true) {
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) {
        throw new StageManifestError(`Path is a symbolic link: ${current}`, { path: throwDir });
      }
      if (current === path.resolve(dir) && !st.isDirectory()) {
        throw new StageManifestError(`Agents path is not a directory: ${current}`, { path: throwDir });
      }
    } catch (e) {
      if (e instanceof StageManifestError) throw e;
      // Missing child: continue upward to inspect the first existing ancestor.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Classify the per-manifest action against the exact target `<name>.md`. */
export function inspectTargetManifest(
  m: NormalizedManifest,
  agentsDir: string,
  replaceExisting: string[],
): TextTargetInspection {
  const text = serializeManifest(m);
  const afterHash = sha256Hex(text);
  const file = path.join(agentsDir, `${m.name}.md`);

  let existingStat: fs.Stats | null = null;
  try {
    existingStat = fs.lstatSync(file);
  } catch {
    existingStat = null;
  }
  if (existingStat !== null) {
    if (existingStat.isSymbolicLink()) throw new StageManifestError(`Target manifest is a symbolic link: ${file}`);
    if (!existingStat.isFile()) throw new StageManifestError(`Target manifest is not a regular file: ${file}`);
    const before = fs.readFileSync(file, "utf8");
    const beforeHash = sha256Hex(before);
    if (before === text) {
      return { name: m.name, action: "unchanged" as const, path: file, bytes: text, beforeHash, afterHash, diff: "" };
    }
    if (replaceExisting.includes(m.name)) {
      return { name: m.name, action: "replace" as const, path: file, bytes: text, beforeHash, afterHash, diff: simpleDiff(before, text) };
    }
    throw new StageManifestError(
      `Target ${m.name}.md already exists with different content; add "${m.name}" to replaceExisting to replace it`,
    );
  }
  if (replaceExisting.includes(m.name)) {
    throw new StageManifestError(`replaceExisting "${m.name}" has no differing existing target to replace (stale)`);
  }
  return { name: m.name, action: "create" as const, path: file, bytes: text, afterHash, diff: undefined };
}

function simpleDiff(before: string, after: string): string {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [];
  for (const l of a) if (!b.includes(l)) lines.push(`- ${l}`);
  for (const l of b) if (!a.includes(l)) lines.push(`+ ${l}`);
  if (lines.length > 40) {
    return lines.slice(0, 40).join("\n") + `\n... (${lines.length - 40} more)`;
  }
  return lines.join("\n");
}

/** Deep-sort object keys (arrays keep order) for deterministic canonical JSON. */
function deepSortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => deepSortKeys(x));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = deepSortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function canonicalJson(v: unknown): string {
  return JSON.stringify(deepSortKeys(v));
}

function boundPreviewDiagnostics(existing: Array<{ canonicalPath: string; message: string }>): {
  invalidExistingManifests: InitDiagnostics["invalidExistingManifests"];
  omittedCount: number;
} {
  let budget = INIT_DIAGNOSTIC_BOUND_BYTES;
  const invalidExistingManifests = [];
  let omitted = 0;
  for (const it of existing) {
    const bytes = Buffer.byteLength(it.canonicalPath + it.message, "utf8");
    if (invalidExistingManifests.length >= INIT_DIAGNOSTIC_BOUND_ENTRIES || bytes > budget) {
      omitted++;
      continue;
    }
    invalidExistingManifests.push(it);
    budget -= bytes;
  }
  return { invalidExistingManifests, omittedCount: omitted };
}

/**
 * Build the immutable preview: inspect targets, classify actions, compute
 * elevated-tool warnings, render managed guidance, and hash the sorted canonical
 * JSON to `preview-<sha256>`. No files are written.
 */
export function buildPreview(input: PreviewBuildInput): InitPreview {
  // Generated agents must land where catalog discovery scans project agents:
  // the pi CONFIG_DIR_NAME (e.g. `.pi/agents`), not the ops config dir.
  const configDir = input.configDirName ?? CONFIG_DIR_NAME;
  const agentsDir = input.agentsDirOverride ?? path.join(input.outputRoot, CONFIG_DIR_NAME, DEFAULT_AGENTS_DIR);
  const agentsMdPath = input.agentsMdPathOverride ?? path.join(input.outputRoot, "AGENTS.md");
  const replaceExisting = input.replaceExisting ?? [];

  if (input.manifests.length < 1) throw new StageManifestError("At least one manifest is required to stage");
  if (input.manifests.length > 32) throw new StageManifestError("At most 32 manifests may be staged");
  const names = new Set<string>();
  for (const m of input.manifests) {
    if (names.has(m.name)) throw new StageManifestError(`Duplicate manifest name "${m.name}"`);
    const secretField = collectSecretField(m);
    if (secretField) throw new StageManifestError(`Manifest "${m.name}" contains a secret-like literal in ${secretField}`);
    names.add(m.name);
  }
  const replacementNames = new Set<string>();
  for (const name of replaceExisting) {
    if (typeof name !== "string" || replacementNames.has(name)) {
      throw new StageManifestError("replaceExisting must contain unique manifest names");
    }
    if (!names.has(name)) throw new StageManifestError(`replaceExisting "${name}" is not a staged manifest`);
    replacementNames.add(name);
  }

  // Existing valid direct manifests drive guidance rows and name-collision rules.
  const discovery = discoverGuidanceManifests(agentsDir);
  symlinkFreeDir(agentsDir, agentsDir);
  for (const m of input.manifests) {
    const declared = discovery.valid.find((v) => v.name === m.name);
    if (declared && path.basename(declared.canonicalPath) !== `${m.name}.md`) {
      throw new StageManifestError(
        `Name "${m.name}" is already declared by ${declared.canonicalPath}; rename one of them`,
      );
    }
  }

  const manifestPreviews: InitManifestPreview[] = input.manifests.map((m) => {
    const target = path.join(agentsDir, `${m.name}.md`);
    verifyRoundTrip(m, target);
    return inspectTargetManifest(m, agentsDir, replaceExisting);
  });
  manifestPreviews.sort((a, b) => a.name.localeCompare(b.name));

  // render managed guidance
  const composed = composeGuidanceAgents(
    discovery.valid.map(({ name, description, kind }) => ({ name, description, kind })),
    input.manifests.map((m) => ({ name: m.name, description: m.description, kind: m.kind })),
  );
  const existingAgents = analyzeAgentsMd(agentsMdPath);
  const guidance = renderAgentsGuidance(existingAgents, composed, configDir);

  // elevated-or-unknown tool warnings
  const elevatedToolAgents = input.manifests
    .map((m) => ({ name: m.name, tools: m.tools.filter((t) => !INIT_READ_TOOLS.includes(t)) }))
    .filter((e) => e.tools.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const d = boundPreviewDiagnostics(discovery.invalid.map((i) => ({ canonicalPath: i.canonicalPath, message: i.message })));
  const diagnostics: InitDiagnostics = {
    invalidBlueprints: [],
    invalidExistingManifests: d.invalidExistingManifests,
    duplicateBlueprintNames: [],
    directoryErrors: [],
    trustExclusions: [],
    omittedCount: d.omittedCount,
  };

  const agentsMdPreview: InitAgentsMdPreview = {
    action: guidance.action,
    path: agentsMdPath,
    beforeBytes: guidance.beforeBytes ?? undefined,
    afterBytes: guidance.afterBytes,
    beforeHash: guidance.beforeHash ?? undefined,
    afterHash: guidance.afterHash,
  };

  const blueprintProvenance = input.manifests
    .map((m) => ({ name: m.name, source: m.provenance.source }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const payload = {
    initializationId: input.initializationId,
    outputRoot: input.outputRoot,
    manifests: manifestPreviews,
    agentsMd: agentsMdPreview,
    blueprintProvenance,
    diagnostics,
    elevatedToolAgents,
  };
  const previewId = `${INIT_PREVIEW_ID_PREFIX}${sha256Hex(canonicalJson(payload))}` as InitPreviewId;
  return { schemaVersion: 1, previewId, ...payload } as InitPreview;
}

// --- Commit transaction (task 4.3) ---

export interface CommitResult {
  created: string[];
  replaced: string[];
  unchanged: string[];
}

export interface CommitOptions {
  /** Stable initialization id used only in hidden temp/backup names. */
  initializationId: string;
  /** Test hook; production uses Node's synchronous atomic rename. */
  renameSync?: (from: string, to: string) => void;
}

interface CommitOutput {
  path: string;
  bytes: string;
  action: "create" | "replace" | "unchanged";
  beforeHash?: string;
}

interface PreparedOutput extends CommitOutput {
  temp: string;
  backup: string | null;
  originalMode: number | null;
  installed: boolean;
}

/** Commit one latest immutable preview or throw after restoring all known originals. */
export function commitPreview(preview: InitPreview, options: CommitOptions): CommitResult {
  assertPreviewHash(preview);
  const outputs: CommitOutput[] = [
    ...preview.manifests.map((m) => ({
      path: m.path,
      bytes: m.bytes,
      action: m.action,
      ...(m.beforeHash !== undefined ? { beforeHash: m.beforeHash } : {}),
    })),
    {
      path: preview.agentsMd.path,
      bytes: preview.agentsMd.afterBytes,
      action: preview.agentsMd.action,
      ...(preview.agentsMd.beforeHash !== undefined ? { beforeHash: preview.agentsMd.beforeHash } : {}),
    },
  ].sort((a, b) => a.path.localeCompare(b.path));

  preflightOutputs(outputs);
  const changed = outputs.filter((o) => o.action !== "unchanged");
  const unchanged = outputs.filter((o) => o.action === "unchanged").map((o) => o.path);
  if (changed.length === 0) return { created: [], replaced: [], unchanged };

  const rename = options.renameSync ?? fs.renameSync;
  const createdDirs: string[] = [];
  const prepared: PreparedOutput[] = [];
  try {
    for (const out of changed) ensureParentDir(path.dirname(out.path), createdDirs);
    for (const out of changed) {
      const dir = path.dirname(out.path);
      const temp = path.join(dir, `.${path.basename(out.path)}.${options.initializationId}.${randomUUID()}.tmp`);
      const backup = out.action === "replace"
        ? path.join(dir, `.${path.basename(out.path)}.${options.initializationId}.${randomUUID()}.bak`)
        : null;
      const originalMode = out.action === "replace" ? fs.statSync(out.path).mode & 0o777 : null;
      const fd = fs.openSync(temp, "wx", INIT_MANIFEST_MODE);
      try {
        fs.writeFileSync(fd, out.bytes, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(temp, INIT_MANIFEST_MODE);
      if (sha256Hex(fs.readFileSync(temp, "utf8")) !== sha256Hex(out.bytes)) {
        throw new ManifestGenerationError(`Temporary output hash mismatch: ${out.path}`);
      }
      prepared.push({ ...out, temp, backup, originalMode, installed: false });
    }

    // Move all replacements aside before any final installation.
    for (const p of prepared) if (p.backup) rename(p.path, p.backup);
    // Install in deterministic path order.
    for (const p of prepared) {
      rename(p.temp, p.path);
      p.installed = true;
      fs.chmodSync(p.path, INIT_MANIFEST_MODE);
    }
    for (const p of prepared) if (p.backup && fs.existsSync(p.backup)) fs.unlinkSync(p.backup);
    return {
      created: prepared.filter((p) => p.action === "create").map((p) => p.path),
      replaced: prepared.filter((p) => p.action === "replace").map((p) => p.path),
      unchanged,
    };
  } catch (e) {
    const recovery = rollback(prepared, createdDirs, rename);
    const detail = recovery.length > 0 ? `; recovery required for: ${recovery.join(", ")}` : "";
    throw new ManifestGenerationError(`Commit transaction failed${detail}`);
  } finally {
    for (const p of prepared) {
      try { if (fs.existsSync(p.temp)) fs.unlinkSync(p.temp); } catch { /* best effort */ }
    }
  }
}

function assertPreviewHash(preview: InitPreview): void {
  const { schemaVersion: _schemaVersion, previewId, ...payload } = preview;
  const expected = `${INIT_PREVIEW_ID_PREFIX}${sha256Hex(canonicalJson(payload))}`;
  if (previewId !== expected) throw new ManifestGenerationError("Preview hash is stale or inconsistent");
}

function preflightOutputs(outputs: CommitOutput[]): void {
  for (const out of outputs) {
    symlinkFreeDir(path.dirname(out.path), path.dirname(out.path));
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(out.path); } catch { st = null; }
    if (st?.isSymbolicLink()) throw new ManifestGenerationError(`Output is a symbolic link: ${out.path}`);
    if (out.action === "create") {
      if (st) throw new ManifestGenerationError(`Preview is stale; create target now exists: ${out.path}`);
      continue;
    }
    if (!st?.isFile() || out.beforeHash === undefined) {
      throw new ManifestGenerationError(`Preview is stale; expected regular existing output: ${out.path}`);
    }
    const actual = sha256Hex(fs.readFileSync(out.path, "utf8"));
    if (actual !== out.beforeHash) throw new ManifestGenerationError(`Preview is stale; input changed: ${out.path}`);
  }
}

function ensureParentDir(dir: string, created: string[]): void {
  if (fs.existsSync(dir)) return;
  const missing: string[] = [];
  let current = dir;
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const d of missing.reverse()) {
    fs.mkdirSync(d, { mode: INIT_DIR_MODE });
    created.push(d);
  }
}

function rollback(prepared: PreparedOutput[], createdDirs: string[], rename: (from: string, to: string) => void): string[] {
  const recovery: string[] = [];
  // Remove new finals first; then restore every replacement backup.
  for (const p of [...prepared].reverse()) {
    try {
      if (p.installed && fs.existsSync(p.path)) fs.unlinkSync(p.path);
    } catch {
      recovery.push(p.path);
    }
  }
  for (const p of [...prepared].reverse()) {
    if (!p.backup) continue;
    try {
      if (fs.existsSync(p.backup)) {
        rename(p.backup, p.path);
        if (p.originalMode !== null) fs.chmodSync(p.path, p.originalMode);
      }
    } catch {
      recovery.push(p.path);
    }
  }
  for (const p of prepared) {
    try { if (fs.existsSync(p.temp)) fs.unlinkSync(p.temp); } catch { recovery.push(p.temp); }
  }
  for (const d of [...createdDirs].reverse()) {
    try { fs.rmdirSync(d); } catch { /* non-empty/user-created: retain */ }
  }
  return [...new Set(recovery)];
}
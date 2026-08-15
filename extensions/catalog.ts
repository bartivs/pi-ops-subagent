/**
 * Agent catalog (design D4 / agent-catalog spec).
 *
 * Discovers direct non-recursive `*.md` children from four source classes:
 * packaged `agents/*.md`, `~/.pi/agent/agents/*.md`, nearest trusted project
 * `${CONFIG_DIR_NAME}/agents/`, and each trusted `agentDirs` entry.
 * Deterministic validation, source precedence, provenance, bundled opt-out,
 * and project-controlled trust approvals.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type {
  AgentKind,
  AgentSourceKind,
  CatalogDiagnostics,
  CatalogEntry,
  CatalogShadow,
  CatalogSnapshot,
  ThresholdSpec,
} from "./types.ts";
import { TRUST_FILE_NAME, TRUST_SUBDIR } from "./constants.ts";
import type { OpsConfig } from "./config.ts";
import { resolveAgentDirs } from "./config.ts";

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const AGENT_KEYS = new Set(["name", "description", "kind", "tools", "model", "timeoutSeconds", "thresholds", "contract"]);
const KINDS: readonly AgentKind[] = ["general", "probe", "artifact"];
const THRESHOLD_OPERATORS = ["gt", "gte", "lt", "lte", "eq", "neq"] as const;
const THRESHOLD_SEVERITIES = ["warning", "critical"] as const;
const THRESHOLD_KEYS = new Set(["id", "metric", "operator", "value", "unit", "severity"]);

export class ManifestValidationError extends Error {
  constructor(message: string, public readonly canonicalPath: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateThresholdSpec(raw: unknown, canonicalPath: string, index: number): ThresholdSpec {
  if (!isPlainObject(raw)) {
    throw new ManifestValidationError(`thresholds[${index}] must be an object`, canonicalPath);
  }
  for (const key of Object.keys(raw)) {
    if (!THRESHOLD_KEYS.has(key)) {
      throw new ManifestValidationError(`thresholds[${index}] contains unknown key "${key}"`, canonicalPath);
    }
  }
  const nonEmptyString = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new ManifestValidationError(`thresholds[${index}]."${key}" must be a non-empty string`, canonicalPath);
    }
    return v;
  };
  const id = nonEmptyString("id");
  if (!NAME_PATTERN.test(id)) {
    throw new ManifestValidationError(`thresholds[${index}]."id" must match ${String(NAME_PATTERN)}`, canonicalPath);
  }
  const operator = nonEmptyString("operator");
  if (!(THRESHOLD_OPERATORS as readonly string[]).includes(operator)) {
    throw new ManifestValidationError(
      `thresholds[${index}]."operator" must be one of ${THRESHOLD_OPERATORS.join(", ")}`,
      canonicalPath,
    );
  }
  const severity = nonEmptyString("severity");
  if (!(THRESHOLD_SEVERITIES as readonly string[]).includes(severity)) {
    throw new ManifestValidationError(
      `thresholds[${index}]."severity" must be one of ${THRESHOLD_SEVERITIES.join(", ")}`,
      canonicalPath,
    );
  }
  const value = raw["value"];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ManifestValidationError(`thresholds[${index}]."value" must be a number`, canonicalPath);
  }
  return {
    id,
    metric: nonEmptyString("metric"),
    operator: operator as ThresholdSpec["operator"],
    value,
    unit: nonEmptyString("unit"),
    severity: severity as ThresholdSpec["severity"],
  };
}

/**
 * Parse and strictly validate one manifest. Returns the normalized entry plus
 * non-fatal parse problems. Throws `ManifestValidationError` for fatal
 * problems so one bad file never blocks unrelated valid files.
 */
export function parseManifest(
  canonicalPath: string,
  content: string,
  source: AgentSourceKind = "bundled",
): { entry: CatalogEntry; problems: CatalogDiagnostics["invalidFiles"] } {
  const problems: CatalogDiagnostics["invalidFiles"] = [];
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

  if (body.trim().length === 0) {
    throw new ManifestValidationError("Manifest prompt body must be non-empty", canonicalPath);
  }
  for (const key of Object.keys(frontmatter)) {
    if (!AGENT_KEYS.has(key)) {
      const hint = key === "timeout" ? ' (supported field: "timeoutSeconds")' : "";
      throw new ManifestValidationError(`Unknown frontmatter key "${key}"${hint}`, canonicalPath);
    }
  }

  const name = frontmatter["name"];
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new ManifestValidationError(`Frontmatter "name" must match ${String(NAME_PATTERN)}`, canonicalPath);
  }
  const description = frontmatter["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new ManifestValidationError('Frontmatter "description" must be a non-empty string', canonicalPath);
  }

  let kind: AgentKind = "general";
  if (frontmatter["kind"] !== undefined) {
    const k = frontmatter["kind"];
    if (typeof k !== "string" || !(KINDS as readonly string[]).includes(k)) {
      throw new ManifestValidationError(`Frontmatter "kind" must be one of ${KINDS.join(", ")}`, canonicalPath);
    }
    kind = k as AgentKind;
  }

  const tools = normalizeTools(frontmatter["tools"], canonicalPath);

  let model: string | undefined;
  if (frontmatter["model"] !== undefined) {
    const m = frontmatter["model"];
    if (typeof m !== "string" || m.trim().length === 0) {
      throw new ManifestValidationError('Frontmatter "model" must be a non-empty string', canonicalPath);
    }
    model = m;
  }

  let timeoutSeconds: number | undefined;
  if (frontmatter["timeoutSeconds"] !== undefined) {
    const t = frontmatter["timeoutSeconds"];
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1) {
      throw new ManifestValidationError('Frontmatter "timeoutSeconds" must be a positive integer', canonicalPath);
    }
    timeoutSeconds = t;
  }

  let thresholds: ThresholdSpec[] | undefined;
  if (frontmatter["thresholds"] !== undefined) {
    const raw = frontmatter["thresholds"];
    if (!Array.isArray(raw)) {
      throw new ManifestValidationError('Frontmatter "thresholds" must be an array', canonicalPath);
    }
    thresholds = raw.map((t, i) => validateThresholdSpec(t, canonicalPath, i));
    if (kind !== "probe") {
      problems.push({
        canonicalPath,
        message: `Frontmatter "thresholds" is only valid for kind: probe; ignored for kind "${kind}"`,
      });
    }
  }

  let contract: string | undefined;
  if (frontmatter["contract"] !== undefined) {
    const c = frontmatter["contract"];
    if (typeof c !== "string" || !NAME_PATTERN.test(c)) {
      throw new ManifestValidationError(
        `Frontmatter "contract" must match the manifest name pattern (${String(NAME_PATTERN)})`,
        canonicalPath,
      );
    }
    contract = c;
  }

  const entry: CatalogEntry = {
    name,
    description,
    kind,
    tools,
    model,
    timeoutSeconds,
    thresholds,
    contract,
    systemPrompt: body,
    body,
    source,
    canonicalPath,
    contentHash: sha256Hex(content),
  };
  return { entry, problems };
}

function normalizeTools(raw: unknown, canonicalPath: string): string[] {
  if (raw === undefined) return [];
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    if (typeof t !== "string") {
      throw new ManifestValidationError('Frontmatter "tools" entries must be strings', canonicalPath);
    }
    const clean = t.trim();
    if (clean.length === 0 || seen.has(clean)) continue;
    seen.add(clean);
    tools.push(clean);
  }
  return tools;
}

// --- Trust approvals (project-controlled content) ---

export interface TrustApproval {
  projectRoot: string;
  canonicalPath: string;
  contentHash: string;
  approvedAt: string;
}
export interface TrustRecord {
  version: 1;
  approvals: Record<string, TrustApproval[]>;
}

export function emptyTrust(): TrustRecord {
  return { version: 1, approvals: {} };
}

export function defaultTrustFile(): string {
  return path.join(getAgentDir(), TRUST_SUBDIR, TRUST_FILE_NAME);
}

export function loadTrust(trustFile: string): TrustRecord {
  try {
    const json = JSON.parse(fs.readFileSync(trustFile, "utf8"));
    if (isPlainObject(json) && json.version === 1 && isPlainObject(json.approvals)) {
      return { version: 1, approvals: json.approvals as Record<string, TrustApproval[]> };
    }
  } catch {
    /* corrupt or missing: fresh store */
  }
  return emptyTrust();
}

export function isApproved(record: TrustRecord, projectRoot: string, canonicalPath: string, contentHash: string): boolean {
  const list = record.approvals[projectRoot] ?? [];
  return list.some((a) => a.canonicalPath === canonicalPath && a.contentHash === contentHash);
}

export function grantApproval(
  record: TrustRecord,
  projectRoot: string,
  canonicalPath: string,
  contentHash: string,
): TrustRecord {
  const list = (record.approvals[projectRoot] ?? []).filter((a) => a.canonicalPath !== canonicalPath);
  list.push({ projectRoot, canonicalPath, contentHash, approvedAt: new Date().toISOString() });
  return { version: 1, approvals: { ...record.approvals, [projectRoot]: list } };
}

export function persistTrust(record: TrustRecord, trustFile: string): void {
  const dir = path.dirname(trustFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.trust.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, trustFile);
}

// --- Discovery ---

interface ScanSource {
  dir: string;
  source: AgentSourceKind;
  rank: number;
  projectControlled: boolean;
  entries: Array<{ entry: CatalogEntry; approved: boolean }>;
}

export interface CatalogOptions {
  /** Override of the packaged `agents/` directory (tests / custom package roots). */
  bundledAgentsDir?: string;
  /** Override of the user agents directory (tests). */
  userAgentsDir?: string;
  /** Override of the trust store path (tests). */
  trustFile?: string;
  /** Preloaded trust record (tests); otherwise loaded from `trustFile`. */
  trust?: TrustRecord | null;
}

/** Locate the package root by walking up from this module until the package.json. */
export function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "pi-ops-subagent") return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/**
 * Effective catalog for one invocation. Runs fresh (startup, reload, and
 * immediately before every invocation) and returns one immutable snapshot so
 * files changing mid-run cannot alter a selected prompt.
 */
export function discoverCatalog(
  config: OpsConfig,
  projectTrusted: boolean,
  options: CatalogOptions = {},
): CatalogSnapshot {
  const trustFile = options.trustFile ?? defaultTrustFile();
  const record = options.trust ?? loadTrust(trustFile);
  const includeBundled = config.includeBundledAgents;

  const bundledDir = options.bundledAgentsDir ?? path.join(findPackageRoot(), "agents");

  const diagnostics: CatalogDiagnostics = { invalidFiles: [], duplicateNames: [], directoryErrors: [], trustExclusions: [] };

  const sources: ScanSource[] = [];
  const pushSource = (src: ScanSource): void => {
    if (isDir(src.dir)) sources.push(src);
    else diagnostics.directoryErrors.push({ dir: src.dir, message: "source directory missing or unreadable" });
  };
  if (includeBundled) pushSource({ dir: bundledDir, source: "bundled", rank: 0, projectControlled: false, entries: [] });
  const userDir = options.userAgentsDir ?? path.join(getAgentDir(), "agents");
  pushSource({ dir: userDir, source: "user", rank: 1, projectControlled: false, entries: [] });
  if (projectTrusted) pushSource({ dir: config.agentDir, source: "project", rank: 2, projectControlled: true, entries: [] });
  resolveAgentDirs(config).forEach((d, i) => {
    if (projectTrusted) pushSource({ dir: d, source: "configured", rank: 3 + i, projectControlled: true, entries: [] });
  });

  // Project-controlled sources omitted for a non-trusted project: report them.
  if (!projectTrusted) {
    if (isDir(config.agentDir)) diagnostics.trustExclusions.push({ canonicalPath: config.agentDir, reason: "project-untrusted" });
    for (const d of resolveAgentDirs(config)) {
      if (isDir(d)) diagnostics.trustExclusions.push({ canonicalPath: d, reason: "project-untrusted" });
    }
  }

  const sourceOrder = sources.map((s) => `${s.source}:${s.dir}`);

  if (!projectTrusted) {
    for (const src of sources) {
      if (src.projectControlled || src.source === "project" || src.source === "configured") {
        diagnostics.trustExclusions.push({ canonicalPath: src.dir, reason: "project-untrusted" });
      }
    }
  }

  interface Discovered {
    entry: CatalogEntry;
    approved: boolean;
  }

  const scanDir = (src: ScanSource): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(src.dir, { withFileTypes: true });
    } catch (e) {
      diagnostics.directoryErrors.push({ dir: src.dir, message: (e as Error).message });
      return;
    }
    const files = dirents
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => path.join(src.dir, d.name))
      .map((f) => path.resolve(f))
      .sort((a, b) => a.localeCompare(b));

    const byName = new Map<string, string[]>();
    const localEntries: Discovered[] = [];

    for (const canonical of files) {
      let content: string;
      try {
        content = fs.readFileSync(canonical, "utf8");
      } catch (e) {
        diagnostics.invalidFiles.push({ canonicalPath: canonical, message: `unreadable: ${(e as Error).message}` });
        continue;
      }
      let entry: CatalogEntry;
      try {
        const parsed = parseManifest(canonical, content, src.source);
        entry = { ...parsed.entry, source: src.source };
        if (parsed.problems.length > 0) diagnostics.invalidFiles.push(...parsed.problems);
      } catch (e) {
        diagnostics.invalidFiles.push({
          canonicalPath: canonical,
          message: e instanceof ManifestValidationError ? e.message : `unexpected: ${(e as Error).message}`,
        });
        continue;
      }
      byName.set(entry.name, [...(byName.get(entry.name) ?? []), canonical]);
      localEntries.push({ entry, approved: true });
    }

    for (const [name, paths] of byName) {
      if (paths.length > 1) {
        diagnostics.duplicateNames.push({ name, canonicalPaths: paths });
      }
    }
    const duplicated = new Set<string>();
    for (const [name, paths] of byName) {
      if (paths.length > 1) for (const p of paths) duplicated.add(p);
    }

    for (const d of localEntries) {
      if (duplicated.has(d.entry.canonicalPath)) continue;
      let approved = true;
      if (src.projectControlled) {
        approved = isApproved(record, config.projectRoot, d.entry.canonicalPath, d.entry.contentHash);
      }
      src.entries.push({ entry: d.entry, approved });
    }
  };

  for (const src of sources) scanDir(src);

  // Precedence merge: configured (later entry wins) > project > user > bundled.
  const ranked = [...sources].sort((a, b) => a.rank - b.rank);
  const winners = new Map<string, { entry: CatalogEntry; approved: boolean; shadowed: CatalogShadow[] }>();
  for (const src of ranked) {
    for (const d of src.entries) {
      const existing = winners.get(d.entry.name);
      if (existing) {
        existing.shadowed.push({ name: existing.entry.name, source: existing.entry.source, canonicalPath: existing.entry.canonicalPath });
        winners.set(d.entry.name, { entry: d.entry, approved: d.approved, shadowed: existing.shadowed });
      } else {
        winners.set(d.entry.name, { entry: d.entry, approved: d.approved, shadowed: [] });
      }
    }
  }

  const entries: Array<CatalogEntry & { approved: boolean }> = [];
  const shadowed: CatalogShadow[] = [];
  for (const { entry, approved, shadowed: sh } of winners.values()) {
    entries.push({ ...entry, approved });
    shadowed.push(...sh);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const approvedByPath = new Map<string, boolean>();
  for (const e of entries) approvedByPath.set(e.canonicalPath, e.approved);

  return {
    entries: entries.map(({ approved: _approved, ...entry }) => entry),
    approvedByPath,
    unapprovedEntries: entries.filter((e) => !e.approved),
    sourceOrder: [...new Set(sourceOrder)],
    shadowed,
    configPath: config.configPath,
    includeBundledAgents: includeBundled,
    diagnostics,
  };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// --- `/ops:agents` report (catalog inspection) ---

/**
 * Pure textual report for `/ops:agents`: config path, source order,
 * bundled-enabled state, every effective entry with provenance and exact
 * public fields, shadowed definitions, and all validation/trust diagnostics.
 * Unknown-agent and empty-catalog output lists searched directories and
 * direct next steps.
 */
export function formatCatalogReport(
  snapshot: CatalogSnapshot,
  config: OpsConfig,
  searchedDirsOverride?: string[],
): string {
  const searched = searchedDirsOverride ?? snapshot.sourceOrder.map((s) => s.split(":")[1]).filter(Boolean);
  const lines: string[] = [];
  lines.push(`ops:agents — effective catalog (${snapshot.entries.length} entries)`);
  lines.push(`config: ${snapshot.configPath ?? "<none> (defaults)"}`);
  lines.push(`bundled agents: ${snapshot.includeBundledAgents ? "enabled" : "disabled"}`);
  if (searched.length > 0) lines.push(`source order: ${searched.join(" > ")}`);
  lines.push("");

  if (snapshot.entries.length === 0) {
    lines.push("NO VALID AGENTS. Searched directories:");
    for (const dir of searched) lines.push(`  - ${dir || "(missing from config)"}`);
    lines.push("");
    if (!snapshot.includeBundledAgents) {
      lines.push("Bundled definitions are disabled (includeBundledAgents: false).");
    }
    lines.push("Next steps: add a valid manifest to one of the directories above, or");
    lines.push("re-enable bundled definitions with \"includeBundledAgents\": true in");
    lines.push(".ops/config.json, then run /ops:agents again.");
  } else {
    for (const e of snapshot.entries) {
      lines.push(`# ${e.name} (${e.kind}) [${e.source}]`);
      lines.push(`  description: ${e.description}`);
      lines.push(`  path: ${e.canonicalPath}`);
      lines.push(`  hash: ${e.contentHash}`);
      if (e.model) lines.push(`  model: ${e.model}`);
      if (e.tools.length > 0) lines.push(`  tools: ${e.tools.join(", ")}`);
      if (e.timeoutSeconds !== undefined) lines.push(`  timeoutSeconds: ${e.timeoutSeconds}`);
      if (e.contract) lines.push(`  contract: ${e.contract}`);
      const approved = snapshot.approvedByPath.get(e.canonicalPath);
      if (approved !== undefined) lines.push(`  approved: ${approved ? "yes" : "NO (requires approval)"}`);
      const myShadowed = snapshot.shadowed.filter((s) => s.name === e.name);
      if (myShadowed.length > 0) {
        lines.push(`  shadowed by ${myShadowed.map((s) => `${s.source}:${s.canonicalPath}`).join(", ")}`);
      }
    }
  }
  lines.push("");

  const diag = snapshot.diagnostics;
  if (diag.invalidFiles.length > 0) {
    lines.push("Invalid files:");
    for (const d of diag.invalidFiles) lines.push(`  - ${d.canonicalPath}: ${d.message}`);
  }
  if (diag.duplicateNames.length > 0) {
    lines.push("Duplicate names:");
    for (const d of diag.duplicateNames) {
      lines.push(`  - ${d.name}: ${d.canonicalPaths.join(", ")}`);
    }
  }
  if (diag.directoryErrors.length > 0) {
    lines.push("Directory errors:");
    for (const d of diag.directoryErrors) lines.push(`  - ${d.dir}: ${d.message}`);
  }
  const trustDiags = [...diag.trustExclusions];
  const unapproved = snapshot.unapprovedEntries;
  if (trustDiags.length > 0 || unapproved.length > 0) {
    lines.push("Trust:");
    for (const d of trustDiags) lines.push(`  - ${d.canonicalPath}: ${d.reason}`);
    for (const e of unapproved) lines.push(`  - ${e.name} (${e.source}): unapproved — run once interactively or set ${process.env["PI_OPS_ALLOW_PROJECT_AGENTS"] === "1" ? "(override active)" : "PI_OPS_ALLOW_PROJECT_AGENTS=1"} in headless mode`);
  }
  if (
    diag.invalidFiles.length === 0 &&
    diag.duplicateNames.length === 0 &&
    diag.directoryErrors.length === 0 &&
    trustDiags.length === 0 &&
    unapproved.length === 0 &&
    snapshot.entries.length > 0
  ) {
    lines.push("No validation or trust issues.");
  }
  return lines.join("\n");
}

/** Guidance for an unknown-agent invocation error. */
export function unknownAgentError(agentName: string, snapshot: CatalogSnapshot, config: OpsConfig): string {
  const searched = snapshot.sourceOrder.map((s) => s.split(":")[1]).filter(Boolean);
  const first = searched.length > 0 ? searched : [config.agentDir];
  const valid = snapshot.entries.map((e) => e.name).join(", ") || "none";
  return `Unknown agent: "${agentName}". Valid agents: ${valid}. Searched: ${first.join(", ")}. Add a manifest or re-enable bundled agents (includeBundledAgents).`;
}
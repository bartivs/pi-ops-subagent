/**
 * Inert blueprint catalog (design D5 / agent-blueprints spec).
 *
 * Discovers non-recursive direct `*.md` children from bundled
 * `<package>/blueprints`, user `<getAgentDir()>/pi-ops-subagent/blueprints`, and
 * trusted current-project `<outputRoot>/${OPS_DIR_NAME}/ops-agent-blueprints`.
 * Blueprints are recommendation/generation input only: discovery never registers
 * an executable agent, never activates tools, and never writes project files.
 *
 * The parser validates initializer-only keys (`category`, `when`,
 * `recommendedByDefault`) then delegates manifest-shaped fields to the shared
 * `catalog.normalizeManifestEntry`. Each discovery returns one immutable snapshot,
 * captured once after scope acceptance when the output root is known.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AGENT_KEYS, findPackageRoot, ManifestValidationError, normalizeManifestEntry, sha256Hex } from "./catalog.ts";
import { findSecretHits } from "./redact.ts";
import {
  BUNDLED_BLUEPRINTS_DIR,
  INIT_BLUEPRINT_PROMPT_MAX_BYTES,
  INIT_BLUEPRINT_PROMPT_MIN_BYTES,
  INIT_BLUEPRINT_TEXT_MAX_BYTES,
  INIT_DIAGNOSTIC_BOUND_BYTES,
  INIT_DIAGNOSTIC_BOUND_ENTRIES,
  OPS_AGENT_BLUEPRINTS_DIR,
  OPS_DIR_NAME,
  USER_BLUEPRINTS_SUBDIR,
} from "./constants.ts";
import type { BlueprintDiagnostics, BlueprintSnapshot, BlueprintSource, InitBlueprint } from "./types.ts";

const BLUEPRINT_KEYS = new Set(["category", "when", "recommendedByDefault"]);
const ALLOWED_KEYS = new Set([...AGENT_KEYS, ...BLUEPRINT_KEYS]);
/** `category` and agent `name`/`contract` share the same lowercase-identifier shape. */
const CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export class BlueprintValidationError extends Error {
  constructor(message: string, public readonly canonicalPath: string) {
    super(message);
    this.name = "BlueprintValidationError";
  }
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export interface BlueprintDiscoveryInput {
  /** `ctx.isProjectTrusted()` value. */
  projectTrusted: boolean;
  /** Canonical current project root used for the containment trust check. */
  projectRoot: string;
  /** Canonical accepted output root. */
  outputRoot: string;
  /** Overrides for tests / custom package layouts. */
  bundledDir?: string;
  userDir?: string;
  projectDir?: string;
}

interface ScanSource {
  dir: string;
  source: BlueprintSource;
  rank: number;
  entries: InitBlueprint[];
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover the scope-time inert blueprint snapshot. Deterministic: sources are
 * scanned, files within a source sorted by canonical path, same-directory
 * duplicates invalidate, cross-source collisions resolve `project > user >
 * bundled`, and diagnostics are bounded. Reads nothing unless the project source
 * is eligible under the current trust and output-root containment.
 */
export function discoverBlueprints(input: BlueprintDiscoveryInput): BlueprintSnapshot {
  const diagnostics: BlueprintDiagnostics = {
    invalidFiles: [],
    duplicateNames: [],
    directoryErrors: [],
    trustExclusions: [],
    shadowed: [],
    omittedCount: 0,
  };

  const sources: ScanSource[] = [];
  const pushSource = (src: ScanSource): void => {
    if (isDir(src.dir)) sources.push(src);
    else diagnostics.directoryErrors.push({ dir: src.dir, message: "source directory missing or unreadable" });
  };

  const configDir = OPS_DIR_NAME;

  const bundledDir = input.bundledDir ?? path.join(findPackageRoot(), BUNDLED_BLUEPRINTS_DIR);
  pushSource({ dir: bundledDir, source: "bundled", rank: 0, entries: [] });

  const userDir = input.userDir ?? path.join(getAgentDir(), USER_BLUEPRINTS_SUBDIR);
  pushSource({ dir: userDir, source: "user", rank: 1, entries: [] });

  const projectDir = input.projectDir ?? path.join(input.outputRoot, configDir, OPS_AGENT_BLUEPRINTS_DIR);
  const projectEligible = input.projectTrusted && isInside(input.projectRoot, input.outputRoot);
  if (projectEligible) {
    pushSource({ dir: projectDir, source: "project", rank: 2, entries: [] });
  } else if (input.projectTrusted || !isInside(input.projectRoot, input.outputRoot)) {
    diagnostics.trustExclusions.push({ canonicalPath: projectDir, reason: "project-blueprints-untrusted" });
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

    const byName = new Map<string, { path: string; blueprint: InitBlueprint }[]>();
    for (const canonical of files) {
      let content: string;
      try {
        content = fs.readFileSync(canonical, "utf8");
      } catch (e) {
        diagnostics.invalidFiles.push({ canonicalPath: canonical, message: `unreadable: ${(e as Error).message}` });
        continue;
      }
      let blueprint: InitBlueprint;
      let problems: Array<{ canonicalPath: string; message: string }> = [];
      try {
        const parsed = parseBlueprint(canonical, content, src.source);
        blueprint = parsed.blueprint;
        problems = parsed.problems.map((p) => ({ canonicalPath: canonical, message: p }));
      } catch (e) {
        diagnostics.invalidFiles.push({
          canonicalPath: canonical,
          message: e instanceof BlueprintValidationError || e instanceof ManifestValidationError ? e.message : `unexpected: ${(e as Error).message}`,
        });
        continue;
      }
      diagnostics.invalidFiles.push(...problems);
      byName.set(blueprint.name, [...(byName.get(blueprint.name) ?? []), { path: canonical, blueprint }]);
    }

    const duplicated = new Map<string, string[]>();
    for (const [name, defs] of byName) {
      if (defs.length > 1) {
        const paths = defs.map((d) => d.path);
        diagnostics.duplicateNames.push({ name, canonicalPaths: paths });
        duplicated.set(name, paths);
      }
    }
    for (const [name, defs] of byName) {
      if (duplicated.has(name)) continue;
      src.entries.push(defs[0].blueprint);
    }
  };

  for (const src of sources) scanDir(src);

  const ranked = [...sources].sort((a, b) => a.rank - b.rank);
  const winners = new Map<string, InitBlueprint>();
  const shadowed: BlueprintDiagnostics["shadowed"] = [];
  for (const src of ranked) {
    for (const bp of src.entries) {
      const existing = winners.get(bp.name);
      if (existing) {
        shadowed.push({ name: existing.name, source: existing.source, canonicalPath: existing.canonicalPath });
      }
      winners.set(bp.name, bp);
    }
  }
  diagnostics.shadowed = shadowed;

  const blueprints = [...winners.values()].sort((a, b) => a.name.localeCompare(b.name));

  return {
    blueprints,
    diagnostics: boundDiagnostics(diagnostics),
  };
}

/** Summarize a snapshot for a bounded model-visible view (no prompt bodies). */
export function summarizeBlueprints(snapshot: BlueprintSnapshot): Array<{
  name: string;
  description: string;
  category: string;
  when: string;
  recommendedByDefault: boolean;
  source: BlueprintSource;
  contentHash: string;
}> {
  return snapshot.blueprints.map((b) => ({
    name: b.name,
    description: b.description,
    category: b.category,
    when: b.when,
    recommendedByDefault: b.recommendedByDefault,
    source: b.source,
    contentHash: b.contentHash,
  }));
}

/**
 * Parse and validate one inert blueprint file. Returns the normalized blueprint
 * and non-fatal problems (mirroring executable-manifest behavior). Blueprint-only
 * keys are validated here; manifest fields are normalized by `normalizeManifestEntry`.
 */
export function parseBlueprint(
  canonicalPath: string,
  content: string,
  source: BlueprintSource,
): { blueprint: InitBlueprint; problems: string[] } {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new BlueprintValidationError(`Unknown blueprint key "${key}"`, canonicalPath);
    }
  }

  const prompt = body.trim();
  const promptBytes = bytes(prompt);
  if (promptBytes < INIT_BLUEPRINT_PROMPT_MIN_BYTES) {
    throw new BlueprintValidationError("Blueprint prompt body must be non-empty", canonicalPath);
  }
  if (promptBytes > INIT_BLUEPRINT_PROMPT_MAX_BYTES) {
    throw new BlueprintValidationError(`Blueprint prompt body exceeds ${INIT_BLUEPRINT_PROMPT_MAX_BYTES} UTF-8 bytes`, canonicalPath);
  }

  const description = frontmatter["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new BlueprintValidationError('Blueprint "description" must be a non-empty string', canonicalPath);
  }
  if (bytes(description.trim()) > INIT_BLUEPRINT_TEXT_MAX_BYTES) {
    throw new BlueprintValidationError(`Blueprint "description" exceeds ${INIT_BLUEPRINT_TEXT_MAX_BYTES} UTF-8 bytes`, canonicalPath);
  }

  const category = frontmatter["category"];
  if (typeof category !== "string" || !CATEGORY_PATTERN.test(category)) {
    throw new BlueprintValidationError(`Blueprint "category" must match ${String(CATEGORY_PATTERN)}`, canonicalPath);
  }

  const when = frontmatter["when"];
  if (typeof when !== "string" || when.trim().length === 0) {
    throw new BlueprintValidationError('Blueprint "when" must be a non-empty string', canonicalPath);
  }
  if (bytes(when.trim()) > INIT_BLUEPRINT_TEXT_MAX_BYTES) {
    throw new BlueprintValidationError(`Blueprint "when" exceeds ${INIT_BLUEPRINT_TEXT_MAX_BYTES} UTF-8 bytes`, canonicalPath);
  }

  let recommendedByDefault = false;
  if (frontmatter["recommendedByDefault"] !== undefined) {
    const rb = frontmatter["recommendedByDefault"];
    if (typeof rb !== "boolean") {
      throw new BlueprintValidationError('Blueprint "recommendedByDefault" must be a boolean', canonicalPath);
    }
    recommendedByDefault = rb;
  }

  const secretField = findBlueprintSecret(frontmatter, prompt);
  if (secretField !== null) {
    throw new BlueprintValidationError(`Secret-like literal in blueprint "${secretField}"`, canonicalPath);
  }

  const { entry, problems } = normalizeManifestEntry(frontmatter, prompt, content, canonicalPath, source);
  const canonicalProblems = problems.map((p) => p.message);

  return {
    blueprint: {
      name: entry.name,
      description,
      category,
      when,
      recommendedByDefault,
      kind: entry.kind,
      tools: entry.tools,
      model: entry.model,
      timeoutSeconds: entry.timeoutSeconds,
      thresholds: entry.thresholds,
      contract: entry.contract,
      prompt: entry.body,
      source,
      canonicalPath: entry.canonicalPath,
      contentHash: entry.contentHash,
    },
    problems: canonicalProblems,
  };
}

/** Returns the field label containing a secret-like literal, or null. No values are echoed. */
function findBlueprintSecret(frontmatter: Record<string, unknown>, prompt: string): string | null {
  const scan = (label: string, value: string): boolean => {
    if (findSecretHits(value).length > 0) return true;
    return false;
  };
  for (const [key, v] of Object.entries(frontmatter)) {
    if (typeof v === "string") {
      if (scan(key, v)) return key;
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const e = v[i];
        if (typeof e === "string" && scan(`${key}[${i}]`, e)) return `${key}[${i}]`;
        if (typeof e === "object" && e !== null) {
          for (const [ik, iv] of Object.entries(e as Record<string, unknown>)) {
            if (typeof iv === "string" && scan(`${key}[${i}].${ik}`, iv)) return `${key}[${i}].${ik}`;
          }
        }
      }
    } else if (v && typeof v === "object") {
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof iv === "string" && scan(`${key}.${ik}`, iv)) return `${key}.${ik}`;
      }
    }
  }
  if (scan("prompt body", prompt)) return "prompt body";
  return null;
}

interface DiagItem {
  kind: keyof BlueprintDiagnostics;
  text: string;
  entry: unknown;
  bytes: number;
}

/** Bounds all diagnostics to 100 entries and 51,200 UTF-8 bytes; reports omitted count. */
function boundDiagnostics(d: BlueprintDiagnostics): BlueprintDiagnostics {
  const items: DiagItem[] = [];
  const push = (kind: keyof BlueprintDiagnostics, entry: unknown, text: string): void => {
    items.push({ kind, entry, text, bytes: bytes(text) });
  };
  for (const it of d.invalidFiles) push("invalidFiles", it, it.canonicalPath + it.message);
  for (const it of d.duplicateNames) push("duplicateNames", it, it.name + it.canonicalPaths.join(","));
  for (const it of d.directoryErrors) push("directoryErrors", it, it.dir + it.message);
  for (const it of d.trustExclusions) push("trustExclusions", it, it.canonicalPath + it.reason);
  for (const it of d.shadowed) push("shadowed", it, it.name + it.source + it.canonicalPath);

  let budgetBytes = INIT_DIAGNOSTIC_BOUND_BYTES;
  let omitted = 0;
  const kept: DiagItem[] = [];
  for (const it of items) {
    if (kept.length >= INIT_DIAGNOSTIC_BOUND_ENTRIES || it.bytes > budgetBytes) {
      omitted++;
      continue;
    }
    kept.push(it);
    budgetBytes -= it.bytes;
  }

  const result: BlueprintDiagnostics = {
    invalidFiles: [],
    duplicateNames: [],
    directoryErrors: [],
    trustExclusions: [],
    shadowed: [],
    omittedCount: omitted,
  };
  for (const it of kept) {
    (result[it.kind] as unknown[]).push(it.entry as never);
  }
  return result;
}

function getAgentRoot(): string {
  return getAgentDir();
}
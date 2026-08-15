/**
 * Environment contracts (env-contracts spec, design D5).
 *
 * - Direct `*.md` children of `contractsDir` with exact version-1 frontmatter.
 * - Selection precedence: explicit call `contracts` > manifest `contract` >
 *   config `defaultContract` > none; 0-4 unique names; multi-contract
 *   compatibility on target/profile fields.
 * - Secret-safe: literal credential-like values rejected with file/line/
 *   category diagnostics before any child spawns; placeholders
 *   `${UPPER_SNAKE_CASE}` and profile identifiers are allowed.
 * - Deterministic prompt injection: ordered `<ops_contract name="...">` blocks
 *   followed by one unchanged `<delegated_task>...</delegated_task>`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ContractDoc } from "./types.ts";
import type { OpsConfig } from "./config.ts";
import { resolveContractsDir } from "./config.ts";
import { sha256Hex } from "./catalog.ts";
import { findSecretHits, type SecretCategory } from "./redact.ts";

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CONTRACT_KEYS = new Set([
  "version",
  "name",
  "targetId",
  "expectedIdentity",
  "verifyProfile",
  "connectionProfile",
  "naming",
  "runbooks",
  "baselines",
]);

export class ContractValidationError extends Error {
  constructor(message: string, public readonly canonicalPath: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

export class ContractSelectionError extends Error {
  constructor(message: string, public readonly category: "missing" | "conflict" | "duplicate") {
    super(message);
    this.name = "ContractSelectionError";
  }
}

export class ContractSecretError extends Error {
  constructor(message: string, public readonly hits: Array<{ file: string; line: number; column: number; category: SecretCategory }>) {
    super(message);
    this.name = "ContractSecretError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface ContractDiagnostics {
  invalid: Array<{ canonicalPath: string; message: string }>;
  duplicates: Array<{ name: string; canonicalPaths: string[] }>;
}

export interface ContractCatalog {
  contracts: ContractDoc[];
  diagnostics: ContractDiagnostics;
}

/** Parse one contract file strictly. Throws ContractValidationError. */
export function parseContract(canonicalPath: string, content: string): ContractDoc {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
  for (const key of Object.keys(frontmatter)) {
    if (!CONTRACT_KEYS.has(key)) {
      throw new ContractValidationError(`Unknown frontmatter key "${key}"`, canonicalPath);
    }
  }
  if (frontmatter["version"] !== 1) {
    throw new ContractValidationError(
      `Unsupported contract version ${JSON.stringify(frontmatter["version"])}; supported version: 1`,
      canonicalPath,
    );
  }
  const name = frontmatter["name"];
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new ContractValidationError(`Frontmatter "name" must match ${String(NAME_PATTERN)}`, canonicalPath);
  }
  const wantNonEmpty = (key: string): string => {
    const v = frontmatter[key];
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new ContractValidationError(`Frontmatter "${key}" must be a non-empty string`, canonicalPath);
    }
    return v;
  };
  const targetId = wantNonEmpty("targetId");
  const expectedIdentity = wantNonEmpty("expectedIdentity");
  const verifyProfile = wantNonEmpty("verifyProfile");
  const connectionProfile = wantNonEmpty("connectionProfile");
  if (!/^[a-z][a-z0-9-]{1,64}$/.test(connectionProfile)) {
    throw new ContractValidationError(
      `Frontmatter "connectionProfile" must be an identifier (never a secret value)`,
      canonicalPath,
    );
  }

  let naming: Record<string, string> = {};
  if (frontmatter["naming"] !== undefined) {
    const n = frontmatter["naming"];
    if (!isPlainObject(n) || Object.values(n).some((v) => typeof v !== "string")) {
      throw new ContractValidationError('Frontmatter "naming" must be a string-to-string map', canonicalPath);
    }
    naming = n as Record<string, string>;
  }
  let runbooks: string[] = [];
  if (frontmatter["runbooks"] !== undefined) {
    const r = frontmatter["runbooks"];
    if (!Array.isArray(r) || r.some((v) => typeof v !== "string")) {
      throw new ContractValidationError('Frontmatter "runbooks" must be a string array', canonicalPath);
    }
    runbooks = r as string[];
  }
  let baselines: Record<string, string | number> = {};
  if (frontmatter["baselines"] !== undefined) {
    const b = frontmatter["baselines"];
    if (!isPlainObject(b) || Object.values(b).some((v) => typeof v !== "string" && typeof v !== "number")) {
      throw new ContractValidationError('Frontmatter "baselines" must be a string-to-number-or-string map', canonicalPath);
    }
    baselines = b as Record<string, string | number>;
  }

  return {
    name,
    version: 1,
    targetId,
    expectedIdentity,
    verifyProfile,
    connectionProfile,
    naming,
    runbooks,
    baselines,
    notes: body,
    canonicalPath,
    contentHash: sha256Hex(content),
  };
}

/** Discover direct contract files (non-recursive), sorted by canonical path. */
export function discoverContracts(config: OpsConfig): ContractCatalog {
  const dir = resolveContractsDir(config);
  const diagnostics: ContractDiagnostics = { invalid: [], duplicates: [] };
  const contracts: ContractDoc[] = [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { contracts, diagnostics };
  }
  const files = dirents
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => path.join(dir, d.name))
    .map((f) => path.resolve(f))
    .sort((a, b) => a.localeCompare(b));

  const byName = new Map<string, string[]>();
  for (const canonical of files) {
    let content: string;
    try {
      content = fs.readFileSync(canonical, "utf8");
    } catch (e) {
      diagnostics.invalid.push({ canonicalPath: canonical, message: `unreadable: ${(e as Error).message}` });
      continue;
    }
    let doc: ContractDoc;
    try {
      doc = parseContract(canonical, content);
    } catch (e) {
      diagnostics.invalid.push({
        canonicalPath: canonical,
        message: e instanceof ContractValidationError ? e.message : `unexpected: ${(e as Error).message}`,
      });
      continue;
    }
    byName.set(doc.name, [...(byName.get(doc.name) ?? []), canonical]);
    contracts.push(doc);
  }
  for (const [name, paths] of byName) {
    if (paths.length > 1) diagnostics.duplicates.push({ name, canonicalPaths: paths });
  }
  return { contracts, diagnostics };
}

export interface ContractSelection {
  contracts: ContractDoc[];
  /** Source of the selection for details reporting. */
  source: "call" | "manifest" | "config" | "none";
}

/**
 * Selection precedence: explicit call `contracts` (0-4 unique) > manifest
 * `contract` (one-item) > config `defaultContract` (one-item) > none.
 * Every selected name must exist; multiple selections must agree on
 * targetId/expectedIdentity/verifyProfile/connectionProfile.
 */
export function selectContracts(
  callContracts: string[] | undefined,
  manifestContracts: string[],
  defaultContract: string | null,
  catalog: ContractCatalog,
): ContractSelection {
  let names: string[] | undefined;
  let source: ContractSelection["source"] = "none";
  if (callContracts !== undefined && callContracts.length > 0) {
    names = callContracts;
    source = "call";
  } else if (manifestContracts.length > 0) {
    names = manifestContracts;
    source = "manifest";
  } else if (defaultContract) {
    names = [defaultContract];
    source = "config";
  }
  if (!names || names.length === 0) return { contracts: [], source: "none" };
  if (names.length > 4) {
    throw new ContractSelectionError(`At most 4 contracts per call, got ${names.length}`, "conflict");
  }
  if (new Set(names).size !== names.length) {
    throw new ContractSelectionError("contracts entries must be unique", "duplicate");
  }
  const byName = new Map(catalog.contracts.map((c) => [c.name, c]));
  const selected: ContractDoc[] = [];
  for (const name of names) {
    const doc = byName.get(name);
    if (!doc) {
      const known = catalog.contracts.map((c) => c.name).join(", ") || "none";
      throw new ContractSelectionError(
        `Unknown contract "${name}". Available contracts: ${known}.`,
        "missing",
      );
    }
    selected.push(doc);
  }
  if (selected.length > 1) {
    const first = selected[0]!;
    for (const doc of selected.slice(1)) {
      for (const field of ["targetId", "expectedIdentity", "verifyProfile", "connectionProfile"] as const) {
        if (doc[field] !== first[field]) {
          throw new ContractSelectionError(
            `Conflicting contracts "${first.name}" and "${doc.name}": ${field} differs ("${first[field]}" vs "${doc[field]}").`,
            "conflict",
          );
        }
      }
    }
  }
  return { contracts: selected, source };
}

/**
 * Secret-safe validation: literal credential-like values in contract text are
 * rejected with file/line/category diagnostics before spawn.
 */
export function checkContractSecrets(doc: ContractDoc): void {
  const text = [
    `targetId: ${doc.targetId}`,
    `expectedIdentity: ${doc.expectedIdentity}`,
    `connectionProfile: ${doc.connectionProfile}`,
    ...Object.entries(doc.naming).map(([k, v]) => `${k}: ${v}`),
    ...doc.runbooks.map((r) => `runbook: ${r}`),
    ...Object.entries(doc.baselines).map(([k, v]) => `${k}: ${v}`),
    doc.notes,
  ].join("\n");
  const hits = findSecretHits(text);
  if (hits.length > 0) {
    const mapped = hits.map((h) => ({
      file: doc.canonicalPath,
      line: h.line,
      column: h.column,
      category: h.category,
    }));
    throw new ContractSecretError(
      `Contract "${doc.name}" contains credential-like content (${hits.length} hit(s)): ` +
        mapped.map((h) => `${path.basename(h.file)}:${h.line}:${h.column} [${h.category}]`).join("; ") +
        ". Contracts carry identifiers only; resolve credentials outside model context.",
      mapped,
    );
  }
}

/** Contract blocks only, in caller-provided order (no delegated-task wrapper). */
export function buildContractBlocks(selected: ContractDoc[]): string {
  return selected.map((doc) => {
    const lines: string[] = [];
    lines.push(`<ops_contract name="${doc.name}">`);
    lines.push(`version: ${doc.version}`);
    lines.push(`targetId: ${doc.targetId}`);
    lines.push(`expectedIdentity: ${doc.expectedIdentity}`);
    lines.push(`verifyProfile: ${doc.verifyProfile}`);
    lines.push(`connectionProfile: ${doc.connectionProfile}`);
    if (Object.keys(doc.naming).length > 0) {
      for (const [k, v] of Object.entries(doc.naming)) lines.push(`naming.${k}: ${v}`);
    }
    if (doc.runbooks.length > 0) lines.push(`runbooks: ${doc.runbooks.join(", ")}`);
    for (const [k, v] of Object.entries(doc.baselines)) lines.push(`baseline.${k}: ${v}`);
    if (doc.notes.trim()) lines.push(doc.notes.trim());
    lines.push("Verify expectedIdentity with verifyProfile before diagnostics. Never fall back to the local machine.");
    lines.push("</ops_contract>");
    return lines.join("\n");
  }).join("\n\n");
}

/** Deterministic prompt injection in caller-provided order. */
export function buildContractsPrompt(selected: ContractDoc[], delegatedTask: string): string {
  return `${buildContractBlocks(selected)}\n\n<delegated_task>${delegatedTask}</delegated_task>`;
}

/** Details recorded for the selected contracts (name, path, hash). */
export function contractDetails(selected: ContractDoc[]): Array<{ name: string; canonicalPath: string; contentHash: string }> {
  return selected.map((c) => ({ name: c.name, canonicalPath: c.canonicalPath, contentHash: c.contentHash }));
}
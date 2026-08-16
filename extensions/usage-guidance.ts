/**
 * Managed root `AGENTS.md` guidance (design D9 / agent-usage-guidance spec).
 *
 * Owns exact markers, UTF-8/size/symlink validation, line-ending preservation,
 * deterministic canonical-section rendering, description escaping/truncation,
 * and byte-for-byte preservation of user-owned text outside the managed section.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseManifest, sha256Hex, ManifestValidationError } from "./catalog.ts";
import {
  INIT_AGENTS_MD_MAX_BYTES,
  INIT_GUIDANCE_DISPLAY_BYTES,
  INIT_MARKER_END,
  INIT_MARKER_START,
} from "./constants.ts";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export class AgentsMdError extends Error {
  constructor(message: string, public readonly agentsMdPath: string | null = null) {
    super(message);
    this.name = "AgentsMdError";
  }
}

export type AgentsMdLineEnding = "LF" | "CRLF";

export interface ExistingAgentsMd {
  /** Raw bytes of the file, already validated. */
  bytes: Buffer;
  /** First observed line ending; null when the file has no newlines. */
  lineEnding: AgentsMdLineEnding | null;
}

export interface AgentsGuidanceOutput {
  action: "create" | "replace" | "unchanged";
  beforeBytes: string | null;
  afterBytes: string;
  beforeHash: string | null;
  afterHash: string;
}

/** A valid direct agent that will exist after the transaction, for guidance rows. */
export interface GuidanceAgent {
  name: string;
  description: string;
  kind?: string;
}

interface LineSpan {
  line: string;
  start: number;
  end: number;
}

function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      spans.push({ line: text.slice(start, i), start, end: i === text.length ? i : i + 1 });
      start = i + 1;
    }
  }
  return spans;
}

function detectLineEnding(text: string): AgentsMdLineEnding | null {
  const i = text.indexOf("\n");
  if (i === -1) return null;
  return text[i - 1] === "\r" ? "CRLF" : "LF";
}

function markerLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Returns `"none"` or `"pair"`; throws for orphaned, reversed, or duplicate markers. */
export function validateMarkers(text: string, agentsMdPath: string | null = null): "none" | "pair" {
  let starts = 0;
  let ends = 0;
  let startIndex = -1;
  let endIndex = -1;
  const spans = lineSpans(text);
  spans.forEach((s, i) => {
    const line = markerLine(s.line);
    if (line === INIT_MARKER_START) {
      starts++;
      if (startIndex === -1) startIndex = i;
    }
    if (line === INIT_MARKER_END) {
      ends++;
      if (endIndex === -1) endIndex = i;
    }
  });
  if (starts === 0 && ends === 0) return "none";
  if (starts === 1 && ends === 1 && startIndex < endIndex) return "pair";
  throw new AgentsMdError(
    `AGENTS.md managed markers are malformed (start=${starts}, end=${ends}); repair the pi-ops-subagent:init section before staging`,
    agentsMdPath,
  );
}

/**
 * Validate an existing `AGENTS.md`: regular non-symlink, valid UTF-8, within the
 * byte cap, and with a valid marker structure. Returns null when absent. Throws
 * `AgentsMdError` on any invalid condition.
 */
export function analyzeAgentsMd(agentsMdPath: string): ExistingAgentsMd | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(agentsMdPath);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) throw new AgentsMdError("AGENTS.md is a symbolic link", agentsMdPath);
  if (!st.isFile()) throw new AgentsMdError("AGENTS.md is not a regular file", agentsMdPath);
  const bytes = fs.readFileSync(agentsMdPath);
  if (bytes.length > INIT_AGENTS_MD_MAX_BYTES) {
    throw new AgentsMdError(`AGENTS.md exceeds ${INIT_AGENTS_MD_MAX_BYTES} UTF-8 bytes`, agentsMdPath);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AgentsMdError("AGENTS.md is not valid UTF-8", agentsMdPath);
  }
  validateMarkers(text, agentsMdPath);
  return { bytes, lineEnding: detectLineEnding(text) };
}

function sortedAgents(agents: GuidanceAgent[]): GuidanceAgent[] {
  return [...agents].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render the exact managed section, using uniform `eol` line endings for the
 * whole block. Ends with exactly one final line ending.
 */
export function renderAgentsSection(agents: GuidanceAgent[], configDirName: string, eol: AgentsMdLineEnding): string {
  const nl = eol === "CRLF" ? "\r\n" : "\n";
  const lines: string[] = [
    INIT_MARKER_START,
    `## Project subagents`,
    ``,
    `Project-owned agents are discovered from \`${configDirName}/agents\`. Run \`/ops:agents\` to inspect effective definitions, provenance, validation, and approval state.`,
    ``,
    `Use the \`subagent\` tool for a specific task. Generated project agents remain subject to project trust and content-hash execution approval.`,
    ``,
    `### Available agents`,
    `| Agent | Kind | Purpose |`,
    `| --- | --- | --- |`,
  ];
  for (const a of sortedAgents(agents)) {
    lines.push(`| \`${a.name}\` | ${escapeGuidanceDescription(a.kind ?? "general")} | ${escapeGuidanceDescription(a.description)} |`);
  }
  lines.push(
    ``,
    `### Invocation examples`,
    ``,
    `Single agent:`,
    `\`{"agent":"<AGENT_NAME>","task":"<TASK>"}\``,
    ``,
    `Parallel agents, maximum 8:`,
    `\`{"tasks":[{"agent":"<AGENT_NAME>","task":"<TASK>"},{"agent":"<OTHER_AGENT_NAME>","task":"<TASK>"}]}\``,
    INIT_MARKER_END,
  );
  return lines.join(nl) + nl;
}

/**
 * Collapse whitespace to one ASCII space, escape Markdown control characters and
 * angle brackets, and truncate at a valid UTF-8 boundary with a trailing `...`.
 */
export function escapeGuidanceDescription(description: string, displayBytes = INIT_GUIDANCE_DISPLAY_BYTES): string {
  const collapsed = String(description).replace(/\s+/gu, " ");
  const bounded = truncateUtf8(collapsed, displayBytes);
  let out = bounded
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/!/g, "\\!")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return out;
}

/** Truncate at a valid UTF-8 boundary to at most `maxBytes`, then append `...` when longer. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let prefix = "";
  for (const ch of text) {
    if (Buffer.byteLength(prefix + ch, "utf8") > maxBytes) break;
    prefix += ch;
  }
  return `${prefix}...`;
}

function trailingNewlines(text: string): number {
  const m = text.match(/(?:\r?\n)+$/);
  if (!m) return 0;
  let n = 0;
  for (const c of m[0]) if (c === "\n") n++;
  return n;
}

// --- Post-preview direct-manifest composition for guidance rows ---

export interface ExistingGuidanceManifest {
  name: string;
  description: string;
  kind: string;
  canonicalPath: string;
}

export interface InvalidGuidanceManifest {
  canonicalPath: string;
  message: string;
}

export interface GuidanceManifestDiscovery {
  valid: ExistingGuidanceManifest[];
  invalid: InvalidGuidanceManifest[];
}

/**
 * Read and validate the direct `*.md` files currently in an agents directory,
 * returning valid executable manifests (for guidance rows) and bounded
 * diagnostics for invalid existing files. A missing/unreadable directory yields
 * empty results so the other inputs still compose.
 */
export function discoverGuidanceManifests(agentsDir: string): GuidanceManifestDiscovery {
  const valid: ExistingGuidanceManifest[] = [];
  const invalid: InvalidGuidanceManifest[] = [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return { valid, invalid };
  }
  const files = dirents
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => path.join(agentsDir, d.name))
    .map((f) => path.resolve(f))
    .sort((a, b) => a.localeCompare(b));
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, "utf8");
      const { entry } = parseManifest(f, content, "project");
      valid.push({ name: entry.name, description: entry.description, kind: entry.kind, canonicalPath: f });
    } catch (e) {
      invalid.push({
        canonicalPath: f,
        message: e instanceof ManifestValidationError ? e.message : "unexpected validation error",
      });
    }
  }
  return { valid, invalid };
}

/**
 * Compose the final sorted guidance rows from valid pre-existing direct
 * manifests and the staged additions/overrides (staged wins by name).
 */
export function composeGuidanceAgents(
  validExisting: GuidanceAgent[],
  staged: GuidanceAgent[],
): GuidanceAgent[] {
  const byName = new Map<string, GuidanceAgent>();
  for (const a of validExisting) byName.set(a.name, a);
  for (const a of staged) byName.set(a.name, a);
  return [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Render the complete new `AGENTS.md` content for `existing` (validated) or null
 * (create), including the managed action and before/after bytes and hashes.
 */
export function renderAgentsGuidance(
  existing: ExistingAgentsMd | null,
  agents: GuidanceAgent[],
  configDirName: string = CONFIG_DIR_NAME,
): AgentsGuidanceOutput {
  const eolType: AgentsMdLineEnding = existing?.lineEnding === "CRLF" ? "CRLF" : "LF";
  const section = renderAgentsSection(agents, configDirName, eolType);

  if (existing === null) {
    return {
      action: "create",
      beforeBytes: null,
      afterBytes: section,
      beforeHash: null,
      afterHash: sha256Hex(section),
    };
  }

  const before = existing.bytes.toString("utf8");
  const beforeHash = sha256Hex(before);
  const structure = validateMarkers(before);

  let after: string;
  if (structure === "none") {
    const n = trailingNewlines(before);
    const append = Math.max(0, 2 - n);
    after = before + (eolType === "CRLF" ? "\r\n" : "\n").repeat(append) + section;
  } else {
    const spans = lineSpans(before);
    let start = -1;
    let end = -1;
    for (const s of spans) {
      const line = markerLine(s.line);
      if (line === INIT_MARKER_START && start === -1) start = s.start;
      if (line === INIT_MARKER_END && end === -1) end = s.end;
    }
    if (start === -1 || end === -1) {
      throw new AgentsMdError("AGENTS.md managed section could not be located", null);
    }
    after = before.slice(0, start) + section + before.slice(end);
  }

  const action: "replace" | "unchanged" = after === before ? "unchanged" : "replace";
  return { action, beforeBytes: before, afterBytes: after, beforeHash, afterHash: sha256Hex(after) };
}
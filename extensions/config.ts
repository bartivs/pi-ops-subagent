/**
 * Configuration: nearest `.ops/config.json` discovery with strict
 * key/type/range validation, path resolution, environment parsing, and
 * defaults (design D3 / agent-catalog spec).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DEFAULTS,
  CONFIG_FILE_NAME,
  ENV_ALLOW_PROJECT_AGENTS,
  ENV_ALLOW_PROJECT_AGENTS_VALUE,
  ENV_CONCURRENCY,
  ENV_TIMEOUT_CEILING_MS,
  ENV_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_FLEET_RETENTION_COUNT,
  MAX_FLEET_WIDGET_LINES,
  MIN_CONCURRENCY,
  MIN_FLEET_STALE_AFTER_MS,
  MIN_FLEET_WIDGET_LINES,
  MIN_SESSION_EXPIRY_MS,
  MIN_TIMEOUT_SECONDS,
  OPS_DIR_NAME,
} from "./constants.ts";

export interface ConfigDiagnostic {
  severity: "error" | "warning";
  file: string | null;
  key: string | null;
  message: string;
}

/** Raised by strict validation; message carries file/key diagnostics. */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly category: string,
    public readonly file: string | null,
    public readonly key: string | null,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface OpsConfig {
  /** Directory containing the `.ops/config.json` file, or `<cwd>` when absent. */
  configDir: string;
  /** Canonical config file path, `null` when no config file exists. */
  configPath: string | null;
  /** Where project agents/state resolve from: directory of the config file, else cwd. */
  projectRoot: string;
  /** Config-relative directory holding project agents (D4 conventional folder base). */
  agentDir: string;
  // Exact design-table keys:
  timeoutSeconds: number;
  timeoutCeilingSeconds: number;
  concurrency: number;
  includeBundledAgents: boolean;
  agentDirs: string[];
  defaultContract: string | null;
  contractsDir: string;
  runsDir: string;
  sessionsDir: string;
  sessionExpiryMs: number;
  fleetShortcut: string;
  fleetWidgetLines: number;
  fleetRetentionMs: number;
  fleetRetentionCount: number;
  fleetStaleAfterMs: number;
  /** Diagnostics collected while composing config (file + env). */
  diagnostics: ConfigDiagnostic[];
  /** Keys explicitly present in the config file (env fallback honors config-first precedence). */
  fileKeys: readonly string[];
  /** True when the caller honors project-local settings. */
  trusted: boolean;
  /** True when `PI_OPS_ALLOW_PROJECT_AGENTS=1` is present (headless override). */
  allowProjectAgentsByEnv: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectInt(v: unknown, key: string, file: string | null): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ConfigError(
      `Config key "${key}" must be an integer, got ${JSON.stringify(v)}`,
      "wrong-type",
      file,
      key,
    );
  }
  return v;
}

function expectString(v: unknown, key: string, file: string | null): string {
  if (typeof v !== "string") {
    throw new ConfigError(
      `Config key "${key}" must be a string, got ${JSON.stringify(v)}`,
      "wrong-type",
      file,
      key,
    );
  }
  return v;
}

function expectBoolean(v: unknown, key: string, file: string | null): boolean {
  if (typeof v !== "boolean") {
    throw new ConfigError(
      `Config key "${key}" must be a boolean, got ${JSON.stringify(v)}`,
      "wrong-type",
      file,
      key,
    );
  }
  return v;
}

function expectStringArray(v: unknown, key: string, file: string | null): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ConfigError(`Config key "${key}" must be a string array`, "wrong-type", file, key);
  }
  return v;
}

function validateRange(v: number, key: string, min: number, max: number, file: string | null): void {
  if (v < min || v > max) {
    throw new ConfigError(
      `Config key "${key}" must be in range ${min}..${max}, got ${v}`,
      "out-of-range",
      file,
      key,
    );
  }
}

/** Resolve a relative path against the directory containing the config file. */
export function resolveRelative(baseDir: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(baseDir, p);
}

export function findConfigFile(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, OPS_DIR_NAME, CONFIG_FILE_NAME);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Strictly parse one config file (file object + validation). */
export function parseConfigFile(filePath: string, trusted = true): OpsConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new ConfigError(`Cannot read config file: ${(e as Error).message}`, "unreadable", filePath, null);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Config file is not valid JSON: ${(e as Error).message}`, "bad-json", filePath, null);
  }
  if (!isPlainObject(json)) {
    throw new ConfigError("Config file must contain a JSON object", "wrong-type", filePath, null);
  }
  return applyJson(json, path.dirname(filePath), filePath, trusted);
}

function defaultsFor(projectRoot: string, trusted: boolean): OpsConfig {
  return {
    // Base: state root default is `<cwd>/.ops` (D3). Callers that found a
    // config file override the base with the actual config dir.
    configDir: path.resolve(projectRoot, OPS_DIR_NAME),
    configPath: null,
    projectRoot: path.resolve(projectRoot),
    agentDir: path.resolve(projectRoot, CONFIG_DIR_NAME, "agents"),
    timeoutSeconds: CONFIG_DEFAULTS.timeoutSeconds,
    timeoutCeilingSeconds: CONFIG_DEFAULTS.timeoutCeilingSeconds,
    concurrency: CONFIG_DEFAULTS.concurrency,
    includeBundledAgents: CONFIG_DEFAULTS.includeBundledAgents,
    agentDirs: [...CONFIG_DEFAULTS.agentDirs],
    defaultContract: CONFIG_DEFAULTS.defaultContract,
    contractsDir: CONFIG_DEFAULTS.contractsDir,
    runsDir: CONFIG_DEFAULTS.runsDir,
    sessionsDir: CONFIG_DEFAULTS.sessionsDir,
    sessionExpiryMs: CONFIG_DEFAULTS.sessionExpiryMs,
    fleetShortcut: CONFIG_DEFAULTS.fleetShortcut,
    fleetWidgetLines: CONFIG_DEFAULTS.fleetWidgetLines,
    fleetRetentionMs: CONFIG_DEFAULTS.fleetRetentionMs,
    fleetRetentionCount: CONFIG_DEFAULTS.fleetRetentionCount,
    fleetStaleAfterMs: CONFIG_DEFAULTS.fleetStaleAfterMs,
    diagnostics: [],
    fileKeys: [],
    trusted,
    allowProjectAgentsByEnv: false,
  };
}

function applyJson(
  json: Record<string, unknown>,
  configDir: string,
  configPath: string,
  trusted: boolean,
): OpsConfig {
  const diagnostics: ConfigDiagnostic[] = [];
  for (const key of Object.keys(json)) {
    if (!(key in CONFIG_DEFAULTS)) {
      throw new ConfigError(
        `Unknown config key "${key}". Supported keys: ${Object.keys(CONFIG_DEFAULTS).join(", ")}`,
        "unknown-key",
        configPath,
        key,
      );
    }
  }

  const out = defaultsFor(configDir, trusted);
  out.configDir = configDir;
  out.configPath = configPath;
  out.fileKeys = Object.keys(json);
  // Project root = the directory that contains `.ops/`.
  out.projectRoot = path.dirname(configDir);
  out.agentDir = path.resolve(out.projectRoot, CONFIG_DIR_NAME, "agents");
  out.diagnostics = diagnostics;

  const v = (key: string): unknown => json[key];

  if (v("timeoutSeconds") !== undefined) {
    out.timeoutSeconds = expectInt(v("timeoutSeconds"), "timeoutSeconds", configPath);
    validateRange(out.timeoutSeconds, "timeoutSeconds", MIN_TIMEOUT_SECONDS, Number.POSITIVE_INFINITY, configPath);
  }
  if (v("timeoutCeilingSeconds") !== undefined) {
    out.timeoutCeilingSeconds = expectInt(v("timeoutCeilingSeconds"), "timeoutCeilingSeconds", configPath);
    validateRange(out.timeoutCeilingSeconds, "timeoutCeilingSeconds", 1, Number.POSITIVE_INFINITY, configPath);
  }
  if (out.timeoutSeconds > out.timeoutCeilingSeconds) {
    throw new ConfigError(
      `Config key "timeoutSeconds" (${out.timeoutSeconds}) must not exceed "timeoutCeilingSeconds" (${out.timeoutCeilingSeconds})`,
      "out-of-range",
      configPath,
      "timeoutSeconds",
    );
  }
  if (v("concurrency") !== undefined) {
    out.concurrency = expectInt(v("concurrency"), "concurrency", configPath);
    validateRange(out.concurrency, "concurrency", MIN_CONCURRENCY, MAX_CONCURRENCY, configPath);
  }
  if (v("includeBundledAgents") !== undefined) {
    out.includeBundledAgents = expectBoolean(v("includeBundledAgents"), "includeBundledAgents", configPath);
  }
  if (v("agentDirs") !== undefined) {
    const raw = expectStringArray(v("agentDirs"), "agentDirs", configPath);
    const seen = new Set<string>();
    const resolved: string[] = [];
    for (const entry of raw) {
      const clean = entry.trim();
      if (clean.length === 0) {
        throw new ConfigError('Config key "agentDirs" entries must be non-empty strings', "bad-value", configPath, "agentDirs");
      }
      const abs = resolveRelative(configDir, clean);
      if (seen.has(abs)) {
        throw new ConfigError(
          `Config key "agentDirs" contains duplicate path "${clean}"`,
          "bad-value",
          configPath,
          "agentDirs",
        );
      }
      seen.add(abs);
      resolved.push(abs);
    }
    out.agentDirs = resolved;
  }
  if (v("defaultContract") !== undefined) {
    const dc = v("defaultContract");
    if (dc === null) out.defaultContract = null;
    else out.defaultContract = expectString(dc, "defaultContract", configPath);
  }
  if (v("contractsDir") !== undefined) out.contractsDir = expectString(v("contractsDir"), "contractsDir", configPath);
  if (v("runsDir") !== undefined) out.runsDir = expectString(v("runsDir"), "runsDir", configPath);
  if (v("sessionsDir") !== undefined) out.sessionsDir = expectString(v("sessionsDir"), "sessionsDir", configPath);
  if (v("sessionExpiryMs") !== undefined) {
    out.sessionExpiryMs = expectInt(v("sessionExpiryMs"), "sessionExpiryMs", configPath);
    validateRange(out.sessionExpiryMs, "sessionExpiryMs", MIN_SESSION_EXPIRY_MS, Number.POSITIVE_INFINITY, configPath);
  }
  if (v("fleetShortcut") !== undefined) out.fleetShortcut = expectString(v("fleetShortcut"), "fleetShortcut", configPath);
  if (v("fleetWidgetLines") !== undefined) {
    out.fleetWidgetLines = expectInt(v("fleetWidgetLines"), "fleetWidgetLines", configPath);
    validateRange(out.fleetWidgetLines, "fleetWidgetLines", MIN_FLEET_WIDGET_LINES, MAX_FLEET_WIDGET_LINES, configPath);
  }
  if (v("fleetRetentionMs") !== undefined) {
    out.fleetRetentionMs = expectInt(v("fleetRetentionMs"), "fleetRetentionMs", configPath);
    validateRange(out.fleetRetentionMs, "fleetRetentionMs", 0, Number.POSITIVE_INFINITY, configPath);
  }
  if (v("fleetRetentionCount") !== undefined) {
    out.fleetRetentionCount = expectInt(v("fleetRetentionCount"), "fleetRetentionCount", configPath);
    validateRange(out.fleetRetentionCount, "fleetRetentionCount", 0, MAX_FLEET_RETENTION_COUNT, configPath);
  }
  if (v("fleetStaleAfterMs") !== undefined) {
    out.fleetStaleAfterMs = expectInt(v("fleetStaleAfterMs"), "fleetStaleAfterMs", configPath);
    validateRange(out.fleetStaleAfterMs, "fleetStaleAfterMs", MIN_FLEET_STALE_AFTER_MS, Number.POSITIVE_INFINITY, configPath);
  }
  return out;
}

export interface EnvOverrides {
  timeoutMs: number | null;
  timeoutCeilingMs: number | null;
  concurrency: number | null;
  allowProjectAgents: boolean;
}

/** Environment millisecond values must be positive integers divisible by 1000. */
export function parseEnvOverrides(
  env: Record<string, string | undefined> = process.env,
): { overrides: EnvOverrides; diagnostics: ConfigDiagnostic[] } {
  const diagnostics: ConfigDiagnostic[] = [];
  const overrides: EnvOverrides = { timeoutMs: null, timeoutCeilingMs: null, concurrency: null, allowProjectAgents: false };

  for (const [name, kind] of [
    [ENV_TIMEOUT_MS, "timeout"],
    [ENV_TIMEOUT_CEILING_MS, "ceiling"],
  ] as const) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n % 1000 !== 0) {
      diagnostics.push({
        severity: "error",
        file: null,
        key: name,
        message: `Environment ${name} must be a positive integer divisible by 1000, got "${raw}". Falling back to the next source.`,
      });
      continue;
    }
    if (kind === "timeout") overrides.timeoutMs = n;
    else overrides.timeoutCeilingMs = n;
  }

  const cRaw = env[ENV_CONCURRENCY];
  if (cRaw !== undefined && cRaw !== "") {
    const n = Number(cRaw);
    if (!Number.isInteger(n) || n < MIN_CONCURRENCY || n > MAX_CONCURRENCY) {
      diagnostics.push({
        severity: "error",
        file: null,
        key: ENV_CONCURRENCY,
        message: `Environment ${ENV_CONCURRENCY} must be an integer in range ${MIN_CONCURRENCY}..${MAX_CONCURRENCY}, got "${cRaw}".`,
      });
    } else {
      overrides.concurrency = n;
    }
  }

  overrides.allowProjectAgents = env[ENV_ALLOW_PROJECT_AGENTS] === ENV_ALLOW_PROJECT_AGENTS_VALUE;
  return { overrides, diagnostics };
}

/** Effective config for a cwd: nearest-file discovery (if trusted) + env overrides. */
export function loadConfig(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  trusted = true,
): OpsConfig {
  const file = trusted ? findConfigFile(cwd) : null;
  const base: OpsConfig = file ? parseConfigFile(file, trusted) : defaultsFor(cwd, trusted);
  const { overrides, diagnostics } = parseEnvOverrides(env);
  base.diagnostics.push(...diagnostics);
  base.allowProjectAgentsByEnv = overrides.allowProjectAgents;

  // Precedence per subagent-runner spec: project config > env > default.
  // Env applies only when the file did not provide the key.
  if (overrides.timeoutMs !== null && !base.fileKeys.includes("timeoutSeconds")) {
    base.timeoutSeconds = overrides.timeoutMs / 1000;
  }
  if (overrides.timeoutCeilingMs !== null && !base.fileKeys.includes("timeoutCeilingSeconds")) {
    base.timeoutCeilingSeconds = overrides.timeoutCeilingMs / 1000;
  }
  if (overrides.concurrency !== null && !base.fileKeys.includes("concurrency")) {
    base.concurrency = overrides.concurrency;
  }
  if (base.timeoutSeconds > base.timeoutCeilingSeconds) {
    base.diagnostics.push({
      severity: "warning",
      file: null,
      key: "timeoutSeconds",
      message: `Effective timeout ${base.timeoutSeconds}s exceeds ceiling ${base.timeoutCeilingSeconds}s; will be clamped at run time.`,
    });
  }
  return base;
}

/** Absolute resolved paths used by catalog/contracts/jobs/sessions. */
export function resolveContractsDir(config: OpsConfig): string {
  return resolveRelative(config.configDir, config.contractsDir);
}
export function resolveRunsDir(config: OpsConfig): string {
  return resolveRelative(config.configDir, config.runsDir);
}
export function resolveSessionsDir(config: OpsConfig): string {
  return resolveRelative(config.configDir, config.sessionsDir);
}
export function resolveAgentDirs(config: OpsConfig): string[] {
  return config.agentDirs.map((d) => resolveRelative(config.configDir, d));
}
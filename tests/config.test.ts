import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadConfig,
  findConfigFile,
  parseConfigFile,
  parseEnvOverrides,
  resolveRunsDir,
  resolveSessionsDir,
  resolveContractsDir,
  resolveAgentDirs,
  ConfigError,
} from "../extensions/config.ts";
import {
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_CEILING_SECONDS,
  ENV_TIMEOUT_MS,
  ENV_TIMEOUT_CEILING_MS,
  ENV_CONCURRENCY,
} from "../extensions/constants.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-config-"));
}
function writeConfig(root: string, json: unknown) {
  const dir = path.join(root, ".ops");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(json, null, 2));
  return path.join(dir, "config.json");
}

test("defaults when no config file exists", () => {
  const root = tmpdir();
  const cfg = loadConfig(root);
  assert.equal(cfg.configPath, null);
  assert.equal(cfg.timeoutSeconds, CONFIG_TIMEOUT_DEFAULTS.timeoutSeconds);
  assert.equal(cfg.timeoutSeconds, 300);
  assert.equal(cfg.timeoutCeilingSeconds, 900);
  assert.equal(cfg.concurrency, 2);
  assert.equal(cfg.includeBundledAgents, true);
  assert.deepEqual(cfg.agentDirs, []);
  assert.equal(cfg.defaultContract, null);
  assert.equal(cfg.contractsDir, "contracts");
  assert.equal(cfg.runsDir, "runs");
  assert.equal(cfg.sessionsDir, "sessions");
  assert.equal(cfg.sessionExpiryMs, 604_800_000);
  assert.equal(cfg.fleetShortcut, "alt+o");
  assert.equal(cfg.fleetWidgetLines, 3);
  assert.equal(cfg.fleetRetentionMs, 900_000);
  assert.equal(cfg.fleetRetentionCount, 50);
  assert.equal(cfg.fleetStaleAfterMs, 30_000);
  assert.equal(resolveRunsDir(cfg), path.join(root, ".ops", "runs"));
  assert.equal(resolveSessionsDir(cfg), path.join(root, ".ops", "sessions"));
  assert.equal(resolveContractsDir(cfg), path.join(root, ".ops", "contracts"));
});

const CONFIG_TIMEOUT_DEFAULTS = { timeoutSeconds: 300, timeoutCeilingSeconds: 900 };

test("nearest config discovery walks up", () => {
  const root = tmpdir();
  const nested = path.join(root, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });
  writeConfig(root, { concurrency: 5 });
  const cfg = loadConfig(nested);
  assert.equal(cfg.configPath, path.join(root, ".ops", "config.json"));
  assert.equal(cfg.concurrency, 5);
});

test("valid full config parses and resolves paths against config dir", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  writeConfig(root, {
    timeoutSeconds: 120,
    timeoutCeilingSeconds: 1000,
    concurrency: 4,
    includeBundledAgents: false,
    agentDirs: ["sub", "/abs/dir"],
    defaultContract: "prod",
    contractsDir: "contracts",
    runsDir: "my-runs",
    sessionsDir: "my-sessions",
    sessionExpiryMs: 86400000,
    fleetShortcut: "ctrl+f",
    fleetWidgetLines: 2,
    fleetRetentionMs: 60000,
    fleetRetentionCount: 10,
    fleetStaleAfterMs: 8000,
  });
  const cfg = loadConfig(root);
  assert.equal(cfg.timeoutSeconds, 120);
  assert.equal(cfg.timeoutCeilingSeconds, 1000);
  assert.equal(cfg.concurrency, 4);
  assert.equal(cfg.includeBundledAgents, false);
  assert.equal(cfg.defaultContract, "prod");
  assert.equal(cfg.sessionExpiryMs, 86_400_000);
  assert.equal(cfg.fleetShortcut, "ctrl+f");
  assert.equal(cfg.fleetWidgetLines, 2);
  assert.equal(cfg.fleetRetentionCount, 10);
  assert.equal(cfg.fleetStaleAfterMs, 8_000);
  // relative dirs resolve against the directory containing the config file
  assert.equal(resolveRunsDir(cfg), path.join(root, ".ops", "my-runs"));
  assert.equal(resolveSessionsDir(cfg), path.join(root, ".ops", "my-sessions"));
  assert.equal(resolveContractsDir(cfg), path.join(root, ".ops", "contracts"));
  assert.deepEqual(resolveAgentDirs(cfg), [path.join(root, ".ops", "sub"), "/abs/dir"]);
  assert.equal(cfg.projectRoot, root);
});

test("absolute agentDirs stay absolute", () => {
  const root = tmpdir();
  writeConfig(root, { agentDirs: ["/tmp/absolute-agents"] });
  const cfg = loadConfig(root);
  assert.deepEqual(resolveAgentDirs(cfg), ["/tmp/absolute-agents"]);
});

test("unknown key rejected with key diagnostics", () => {
  const root = tmpdir();
  const file = writeConfig(root, { timeout: 5 });
  assert.throws(
    () => parseConfigFile(file),
    (e) => {
      const err = e as ConfigError;
      assert.match(err.message, /Unknown config key "timeout"/);
      assert.match(err.message, /timeoutSeconds/);
      assert.equal(err.file, file);
      assert.equal(err.key, "timeout");
      return true;
    },
  );
});

test("wrong type rejected", () => {
  const root = tmpdir();
  const file = writeConfig(root, { concurrency: "two" });
  assert.throws(
    () => parseConfigFile(file),
    (err) => {
      const e = err as ConfigError;
      return e.key === "concurrency" && /must be an integer/.test(e.message);
    },
  );
  const file2 = writeConfig(tmpdir(), { includeBundledAgents: "yes" });
  assert.throws(() => parseConfigFile(file2), /must be a boolean/);
  const file3 = writeConfig(tmpdir(), { agentDirs: [1] });
  assert.throws(() => parseConfigFile(file3), /must be a string array/);
});

test("out-of-range values are rejected, not clamped", () => {
  for (const bad of [{ concurrency: 9 }, { concurrency: 0 }, { fleetWidgetLines: 9 }, { fleetStaleAfterMs: 1000 }, { sessionExpiryMs: 1000 }]) {
    const file = writeConfig(tmpdir(), bad);
    assert.throws(() => parseConfigFile(file), /range|must be in range|minimum/i, JSON.stringify(bad));
  }
});

test("timeout above ceiling is rejected in file", () => {
  const file = writeConfig(tmpdir(), { timeoutSeconds: 1200, timeoutCeilingSeconds: 900 });
  assert.throws(() => parseConfigFile(file), /exceeds|must not exceed/);
});

test("environment fallback fills values only when the file omits them (config > env precedence)", () => {
  const root = tmpdir();
  writeConfig(root, { timeoutSeconds: 120, timeoutCeilingSeconds: 1000, concurrency: 3 });
  const cfg = loadConfig(root, {
    [ENV_TIMEOUT_MS]: "60000",
    [ENV_TIMEOUT_CEILING_MS]: "120000",
    [ENV_CONCURRENCY]: "1",
  });
  // project config wins over env (spec precedence)
  assert.equal(cfg.timeoutSeconds, 120);
  assert.equal(cfg.timeoutCeilingSeconds, 1000);
  assert.equal(cfg.concurrency, 3);

  const root2 = tmpdir();
  const cfg2 = loadConfig(root2, {
    [ENV_TIMEOUT_MS]: "60000",
    [ENV_TIMEOUT_CEILING_MS]: "120000",
    [ENV_CONCURRENCY]: "1",
  });
  // no config file: env is the next fallback
  assert.equal(cfg2.timeoutSeconds, 60);
  assert.equal(cfg2.timeoutCeilingSeconds, 120);
  assert.equal(cfg2.concurrency, 1);
});

test("invalid environment timeout falls back with diagnostic", () => {
  const root = tmpdir();
  const { overrides, diagnostics } = parseEnvOverrides({
    [ENV_TIMEOUT_MS]: "1500",
    [ENV_TIMEOUT_CEILING_MS]: "abc",
  });
  assert.equal(overrides.timeoutMs, null);
  assert.equal(overrides.timeoutCeilingMs, null);
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0].message, /divisible by 1000/);
  assert.match(diagnostics[1].message, /positive integer divisible by 1000/);
});

test("env concurrency out of range is diagnostic and ignored", () => {
  const root = tmpdir();
  const { overrides, diagnostics } = parseEnvOverrides({ [ENV_CONCURRENCY]: "99" });
  assert.equal(overrides.concurrency, null);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /range 1\.\.8/);
});

test("non-numeric env falls back to file/default chain", () => {
  const root = tmpdir();
  const cfg = loadConfig(root, { [ENV_TIMEOUT_MS]: "not-a-number" });
  assert.equal(cfg.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  assert.equal(cfg.timeoutCeilingSeconds, DEFAULT_CEILING_SECONDS);
  assert.ok(cfg.diagnostics.some((d) => d.key === ENV_TIMEOUT_MS));
});

test("malformed JSON config fails closed", () => {
  const root = tmpdir();
  const file = path.join(root, ".ops", "config.json");
  fs.mkdirSync(path.join(root, ".ops"), { recursive: true });
  fs.writeFileSync(file, "{ not json ");
  assert.throws(() => parseConfigFile(file), /valid JSON/);
});

test("untrusted project ignores project config file", () => {
  const root = tmpdir();
  writeConfig(root, { concurrency: 7 });
  const cfg = loadConfig(root, {}, false);
  assert.equal(cfg.configPath, null);
  assert.equal(cfg.concurrency, 2);
  assert.equal(cfg.trusted, false);
});

test("findConfigFile returns null above the root", () => {
  const root = tmpdir();
  assert.equal(findConfigFile(root), null);
});
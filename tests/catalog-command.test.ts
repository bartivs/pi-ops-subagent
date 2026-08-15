import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/config.ts";
import { discoverCatalog, formatCatalogReport, unknownAgentError, grantApproval, persistTrust, emptyTrust } from "../extensions/catalog.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-agents-cmd-"));
}

function writeAgent(dir: string, name: string, extra = ""): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${name} description\nkind: probe\ntools: read, grep\n${extra}---\n\nProbe body for ${name}.\n`,
  );
  return file;
}

test("formatCatalogReport snapshot: populated catalog", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true }); // avoid missing-dir diagnostics
  const cfg = loadConfig(root);
  const bundled = path.join(root, "bundled");
  const user = path.join(root, "user");
  writeAgent(bundled, "probe-host");
  writeAgent(bundled, "probe-db");
  writeAgent(user, "custom-audit", "model: m-1\n");

  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: bundled, userAgentsDir: user });
  const report = formatCatalogReport(snap, cfg);
  assert.match(report, /^ops:agents — effective catalog \(3 entries\)/);
  assert.match(report, /config: <none> \(defaults\)/);
  assert.match(report, /bundled agents: enabled/);
  assert.match(report, /# probe-host \(probe\) \[bundled\]/);
  assert.match(report, /# probe-db \(probe\) \[bundled\]/);
  assert.match(report, /# custom-audit \(probe\) \[user\]/);
  assert.match(report, /description: /);
  assert.match(report, /path: /);
  assert.match(report, /hash: [0-9a-f]{64}/);
  assert.match(report, /tools: read, grep/);
  assert.match(report, /model: m-1/);
  assert.match(report, /No validation or trust issues\./);
  // exact line ordering: bundled entries first, then user; sorted by name
  const lines = report.split("\n").filter((l) => l.startsWith("# "));
  assert.deepEqual(lines, [
    "# custom-audit (probe) [user]",
    "# probe-db (probe) [bundled]",
    "# probe-host (probe) [bundled]",
  ]);
});

test("formatCatalogReport snapshot: shadowed definitions listed", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  const cfg = loadConfig(root);
  const bundled = path.join(root, "bundled");
  const user = path.join(root, "user");
  writeAgent(bundled, "dup");
  writeAgent(user, "dup");
  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: bundled, userAgentsDir: user });
  const report = formatCatalogReport(snap, cfg);
  assert.match(report, /# dup \(probe\) \[user\]/);
  assert.match(report, /shadowed by bundled:/);
});

test("formatCatalogReport snapshot: empty catalog lists searched dirs and guidance", () => {
  const root = tmpdir();
  const cfg = loadConfig(root);
  fs.mkdirSync(path.join(root, "noplace"), { recursive: true });
  const snap = discoverCatalog(cfg, true, {
    bundledAgentsDir: path.join(root, "no-bundled"),
    userAgentsDir: path.join(root, "no-user"),
  });
  const report = formatCatalogReport(snap, cfg);
  assert.match(report, /NO VALID AGENTS/);
  assert.match(report, /Searched directories:/);
  for (const dir of [path.join(root, "no-bundled"), path.join(root, "no-user")]) {
    assert.ok(report.includes(dir), `report should mention ${dir}`);
  }
  assert.match(report, /Next steps: add a valid manifest/);
});

test("formatCatalogReport snapshot: diagnostics and trust sections", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  const cfg = loadConfig(root);
  const bundled = path.join(root, "bundled");
  const user = path.join(root, "user");
  writeAgent(bundled, "broken"); // placeholder, overwritten below
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, "broken.md"), "---\nname: broken\ntimeout: 30\n---\nbody");
  const trustFile = path.join(root, "trust.json");
  const projAgent = path.join(cfg.agentDir, "project-agent.md");
  fs.writeFileSync(projAgent, "---\nname: project-agent\ndescription: p\n---\nbody");
  persistTrust(emptyTrust(), trustFile);

  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: bundled, userAgentsDir: user, trustFile });
  const report = formatCatalogReport(snap, cfg);
  assert.match(report, /Invalid files:/);
  assert.match(report, /timeoutSeconds/);
  assert.match(report, /Trust:/);
  assert.match(report, /project-agent \(project\): unapproved/);
  assert.match(report, /approved: NO \(requires approval\)/);
});

test("unknownAgentError lists valid agents and searched dirs", () => {
  const root = tmpdir();
  const cfg = loadConfig(root);
  const bundled = path.join(root, "bundled");
  writeAgent(bundled, "probe-host");
  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: bundled, userAgentsDir: path.join(root, "user") });
  const msg = unknownAgentError("nope", snap, cfg);
  assert.match(msg, /Unknown agent: "nope"/);
  assert.match(msg, /Valid agents: probe-host/);
  assert.match(msg, /Searched: /);
});
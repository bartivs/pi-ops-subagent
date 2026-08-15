import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/config.ts";
import {
  discoverCatalog,
  grantApproval,
  isApproved,
  loadTrust,
  persistTrust,
  emptyTrust,
  sha256Hex,
} from "../extensions/catalog.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-trust-"));
}

function writeAgent(dir: string, name: string, body = "You are a specialist."): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: trust test agent\n---\n\n${body}\n`);
  return file;
}

function setup() {
  const root = tmpdir();
  // project agent dir: <root>/.pi/agents per CONFIG_DIR_NAME convention
  const projectAgents = path.join(root, ".pi", "agents");
  const configured = path.join(root, ".ops", "subagents");
  const user = path.join(root, "user");
  fs.mkdirSync(user, { recursive: true });
  // project-controlled config with agentDirs
  fs.mkdirSync(path.join(root, ".ops"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".ops", "config.json"),
    JSON.stringify({ agentDirs: ["subagents"] }),
  );
  const cfg = loadConfig(root);
  const trustFile = path.join(root, "trust", "trust.json");
  return { root, projectAgents, configured, user, cfg, trustFile, bundled: path.join(root, "bundled") };
}

test("untrusted project: project/configured sources are not read and diagnostics state project-untrusted", () => {
  const env = setup();
  writeAgent(env.projectAgents, "proj", "proj body");
  writeAgent(env.configured, "conf", "conf body");
  writeAgent(env.user, "me", "me body");
  const snap = discoverCatalog(env.cfg, false, {
    bundledAgentsDir: env.bundled,
    userAgentsDir: env.user,
    trustFile: env.trustFile,
  });
  assert.ok(!snap.entries.some((e) => e.name === "open-project"));
  assert.ok(!snap.entries.some((e) => e.name === "conf"));
  assert.ok(snap.entries.some((e) => e.name === "me"));
  assert.equal(snap.diagnostics.trustExclusions.filter((d) => d.reason === "project-untrusted").length, 2);
});

test("unapproved project agent is listed as unapproved until approved by hash", () => {
  const env = setup();
  const file = writeAgent(env.projectAgents, "proj-agent", "v1 body");
  const snap = discoverCatalog(env.cfg, true, {
    bundledAgentsDir: env.bundled,
    userAgentsDir: env.user,
    trustFile: env.trustFile,
  });
  const entry = snap.entries.find((e) => e.name === "proj-agent")!;
  assert.equal(entry.source, "project");
  assert.equal(snap.approvedByPath.get(entry.canonicalPath), false);
  assert.deepEqual(snap.unapprovedEntries.map((e) => e.name), ["proj-agent"]);

  // grant approval for the exact content hash and re-discover
  const record = grantApproval(emptyTrust(), env.root, entry.canonicalPath, entry.contentHash);
  persistTrust(record, env.trustFile);
  const snap2 = discoverCatalog(env.cfg, true, {
    bundledAgentsDir: env.bundled,
    userAgentsDir: env.user,
    trustFile: env.trustFile,
  });
  const entry2 = snap2.entries.find((e) => e.name === "proj-agent")!;
  assert.equal(snap2.approvedByPath.get(entry2.canonicalPath), true);
  assert.deepEqual(snap2.unapprovedEntries, []);
  void file;
});

test("changed content invalidates approval (reapproval required)", () => {
  const env = setup();
  fs.mkdirSync(env.projectAgents, { recursive: true });
  const file = path.join(env.projectAgents, "change.md");
  fs.writeFileSync(file, "---\nname: change\ndescription: d\n---\n\nv1\n");
  const cfg = loadConfig(env.root);
  const snap1 = discoverCatalog(cfg, true, {
    bundledAgentsDir: env.bundled,
    userAgentsDir: env.user,
    trustFile: env.trustFile,
  });
  const e1 = snap1.entries.find((x) => x.name === "change")!;
  persistTrust(grantApproval(emptyTrust(), env.root, e1.canonicalPath, e1.contentHash), env.trustFile);

  // file changes -> new hash -> approval no longer matches
  fs.writeFileSync(file, "---\nname: change\ndescription: Change\n---\n# v2 edited");
  const snap2 = discoverCatalog(cfg, true, {
    bundledAgentsDir: env.bundled,
    userAgentsDir: env.user,
    trustFile: env.trustFile,
  });
  const e2 = snap2.entries.find((x) => x.name === "change")!;
  assert.notEqual(e1.contentHash, e2.contentHash);
  assert.equal(snap2.approvedByPath.get(e2.canonicalPath), false);
});

test("isApproved matches project root + canonical path + content hash exactly", () => {
  const record = emptyTrust();
  assert.equal(isApproved(record, "/p", "/p/a.md", "h1"), false);
  const r2 = grantApproval(record, "/p", "/p/a.md", "h1");
  assert.equal(isApproved(r2, "/p", "/p/a.md", "h1"), true);
  // different hash
  assert.equal(isApproved(r2, "/p", "/p/a.md", "h2"), false);
  // different project
  assert.equal(isApproved(r2, "/q", "/p/a.md", "h1"), false);
  // different path
  assert.equal(isApproved(r2, "/p", "/p/b.md", "h1"), false);
});

test("configured agentDirs entries are project-controlled too", () => {
  const env = setup();
  const f = writeAgent(env.configured, "conf-agent", "body");
  const snap = discoverCatalog(env.cfg, true, {
    bundledAgentsDir: env.bundled,
    userAgentsDir: env.user,
    trustFile: env.trustFile,
  });
  const entry = snap.entries.find((e) => e.name === "conf-agent")!;
  assert.equal(entry.source, "configured");
  assert.equal(snap.approvedByPath.get(entry.canonicalPath), false);

  const record = grantApproval(emptyTrust(), env.root, entry.canonicalPath, sha256Hex(fs.readFileSync(f, "utf8")));
  persistTrust(record, env.trustFile);
  const snap2 = discoverCatalog(env.cfg, true, {
    bundledAgentsDir: env.bundled,
    userAgentsDir: env.user,
    trustFile: env.trustFile,
  });
  const e2 = snap2.entries.find((e) => e.name === "conf-agent")!;
  assert.equal(e2.source, "configured");
  assert.equal(snap2.approvedByPath.get(e2.canonicalPath), true);
});

test("loadTrust survives corrupt file (fresh store)", () => {
  const env = setup();
  fs.mkdirSync(path.dirname(env.trustFile), { recursive: true });
  fs.writeFileSync(env.trustFile, "{ corrupt");
  const record = loadTrust(env.trustFile);
  assert.deepEqual(record, emptyTrust());
  void env;
});
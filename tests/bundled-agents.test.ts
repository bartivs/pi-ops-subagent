import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/config.ts";
import { discoverCatalog, findPackageRoot } from "../extensions/catalog.ts";
import { effectiveChildTools } from "../extensions/runner.ts";

const PACKAGE_AGENTS = path.join(findPackageRoot(), "agents");
const PROBE_IDS = ["probe-host", "probe-db", "probe-cache", "probe-net", "probe-security", "probe-mail", "probe-kernel"];

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-bundled-"));
}

test("all bundled probe agents exist with exact manifest schema and proposal-only actions", () => {
  for (const id of PROBE_IDS) {
    const file = path.join(PACKAGE_AGENTS, `${id}.md`);
    assert.ok(fs.existsSync(file), `${id}.md exists`);
    const content = fs.readFileSync(file, "utf8");
    assert.match(content, /^---\nname: /, `${id} has frontmatter`);
    assert.match(content, /kind: probe/, `${id} is a probe`);
    assert.match(content, /description: /, `${id} has a description`);
    assert.match(content, /approvalRequired: true/, `${id} mutations are proposal-only`);
  }
});

test("catalog discovers every bundled probe agent; none grant bash/write/edit", () => {
  const root = tmpdir();
  const cfg = loadConfig(root);
  const snap = discoverCatalog(cfg, true, {
    bundledAgentsDir: PACKAGE_AGENTS,
    userAgentsDir: path.join(root, "no-user"),
  });
  assert.equal(snap.diagnostics.invalidFiles.length, 0, JSON.stringify(snap.diagnostics.invalidFiles));
  for (const id of PROBE_IDS) {
    const entry = snap.entries.find((e) => e.name === id);
    assert.ok(entry, `${id} discovered`);
    assert.equal(entry!.kind, "probe");
    assert.equal(entry!.source, "bundled");
    assert.ok(entry!.systemPrompt.trim().length > 0, `${id} body non-empty`);
    const tools = effectiveChildTools(entry!);
    for (const denied of ["bash", "write", "edit"]) {
      assert.ok(!tools.includes(denied), `${id} never gets ${denied}`);
    }
    assert.ok(tools.includes("probe_exec"), `${id} gets probe_exec`);
  }
});

test("every bundled agent validates with the strict manifest schema", () => {
  const root = tmpdir();
  const cfg = loadConfig(root);
  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: PACKAGE_AGENTS, userAgentsDir: path.join(root, "no-user") });
  for (const entry of snap.entries) {
    assert.match(entry.name, /^[a-z][a-z0-9-]{0,63}$/);
    assert.ok(entry.description.length > 0);
    assert.ok(entry.body.trim().length > 0);
    assert.equal(typeof entry.contentHash, "string");
    assert.equal(entry.contentHash.length, 64);
  }
});

test("bundled agents load through the package path without symlinks or copies", () => {
  const root = tmpdir();
  const cfg = loadConfig(root);
  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: PACKAGE_AGENTS, userAgentsDir: path.join(root, "no-user") });
  for (const entry of snap.entries) {
    assert.ok(entry.canonicalPath.startsWith(PACKAGE_AGENTS), `${entry.name} canonical path lives in the package`);
    assert.ok(fs.existsSync(entry.canonicalPath), `${entry.name} file is read from the package tree`);
    // The package agents dir is a real directory of markdown files, never a symlink/copy target.
    const st = fs.statSync(PACKAGE_AGENTS);
    assert.ok(st.isDirectory());
  }
});
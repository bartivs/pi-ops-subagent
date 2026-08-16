import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/config.ts";
import { discoverCatalog, parseManifest, normalizeManifestEntry, sha256Hex, ManifestValidationError } from "../extensions/catalog.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-catalog-"));
}

function writeAgent(dir: string, name: string, overrides: Record<string, unknown> = {}, body = "You are a specialist."): string {
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = [
    `name: ${overrides.name ?? name}`,
    `description: ${overrides.description ?? "test agent"}`,
    ...Object.entries(overrides)
      .filter(([k]) => !["name", "description"].includes(k))
      .map(([k, v]) => {
        if (Array.isArray(v)) {
          return v.every((x) => typeof x === "string")
            ? `${k}: [${v.join(", ")}]`
            : `${k}: ${JSON.stringify(v)}`;
        }
        if (typeof v === "string") return `${k}: ${v}`;
        return `${k}: ${JSON.stringify(v)}`;
      }),
  ].join("\n");
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\n${body}\n`);
  return file;
}

function setup() {
  const root = tmpdir();
  const cfg = loadConfig(root);
  const bundled = path.join(root, "bundled");
  const user = path.join(root, "user");
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  return { root, cfg, bundled, user };
}

test("valid manifest normalizes all fields with source and path", () => {
  const { cfg, bundled, user } = setup();
  const fa = writeAgent(bundled, "reader", { name: "reader", description: "Read things", kind: "probe", tools: "read,grep,find,ls", model: "m-1", timeoutSeconds: 120 });
  const fb = writeAgent(user, "writer", { name: "writer", kind: "general", tools: ["read", "read", "bash"], contract: "prod" });
  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: bundled, userAgentsDir: user });
  assert.equal(snap.entries.length, 2);
  const reader = snap.entries.find((e) => e.name === "reader")!;
  assert.equal(reader.kind, "probe");
  assert.deepEqual(reader.tools, ["read", "grep", "find", "ls"]);
  assert.equal(reader.model, "m-1");
  assert.equal(reader.timeoutSeconds, 120);
  assert.equal(reader.source, "bundled");
  assert.equal(reader.canonicalPath, path.resolve(fa));
  assert.equal(reader.contentHash, sha256Hex(fs.readFileSync(fa, "utf8")));
  const writer = snap.entries.find((e) => e.name === "writer")!;
  assert.equal(writer.source, "user");
  assert.deepEqual(writer.tools, ["read", "bash"]);
  assert.equal(writer.contract, "prod");
  void fb;
});

test("tools string form and array form both normalize; dupes collapse in order", () => {
  const { cfg, bundled, user } = setup();
  writeAgent(bundled, "a", { name: "a", tools: "read, grep, read" });
  writeAgent(user, "b", { name: "b", tools: ["bash", "grep"] });
  const snap = discoverCatalogSnapshot({ cfg, bundled, user });
  const a = snap.entries.find((e) => e.name === "a")!;
  assert.deepEqual(a.tools, ["read", "grep"]);
  const b = snap.entries.find((e) => e.name === "b")!;
  assert.deepEqual(b.tools, ["bash", "grep"]);
});

test("nested files are not discovered (non-recursive)", () => {
  const { cfg, bundled, user } = setup();
  writeAgent(bundled, "top", { name: "top" });
  writeAgent(path.join(bundled, "nested"), "deep", { name: "deep" });
  const snap = discoverCatalogSnapshot({ cfg, bundled, user });
  assert.ok(snap.entries.some((e) => e.name === "top"));
  assert.ok(!snap.entries.some((e) => e.name === "deep"));
});

test("unknown key invalidates file and names the supported field", () => {
  const { cfg, bundled, user } = setup();
  writeAgent(bundled, "good", { name: "good" });
  writeAgent(bundled, "bad", { name: "bad", timeout: 30 });
  const snap = discoverCatalogSnapshot({ cfg, bundled, user });
  assert.ok(snap.entries.some((e) => e.name === "good"));
  assert.ok(!snap.entries.some((e) => e.name === "bad"));
  const diag = snap.diagnostics.invalidFiles.find((d) => d.canonicalPath.endsWith("bad.md"));
  assert.ok(diag);
  assert.match(diag.message, /timeoutSeconds/);
});

test("malformed files are isolated; validation errors surface per file", () => {
  const { cfg, bundled, user } = setup();
  writeAgent(bundled, "ok", { name: "ok" });
  writeAgent(bundled, "empty", { name: "empty" }, "");
  const bad = path.join(bundled, "bad.md");
  fs.writeFileSync(bad, "---\nname: 123\n---\nbody");
  writeAgent(bundled, "kindbad", { name: "kindbad", kind: "evil" });
  const snap = discoverCatalogSnapshot({ cfg, bundled, user });
  assert.ok(snap.entries.some((e) => e.name === "ok"));
  assert.ok(!snap.entries.some((e) => e.name === "empty"));
  assert.ok(!snap.entries.some((e) => e.name === "bad"));
  assert.ok(!snap.entries.some((e) => e.name === "kindbad"));
  assert.equal(snap.diagnostics.invalidFiles.length, 3);
});

test("duplicate names within one directory: neither wins, both reported", () => {
  const { cfg, bundled, user } = setup();
  const f1 = writeAgent(bundled, "dup", { name: "dup", description: "first" });
  const f2 = writeAgent(bundled, "dup2", { name: "dup", description: "second" });
  const snap = discoverCatalogSnapshot({ cfg, bundled, user });
  assert.ok(!snap.entries.some((e) => e.name === "dup"));
  const dedup = snap.diagnostics.duplicateNames.find((d) => d.name === "dup");
  assert.ok(dedup);
  assert.deepEqual(new Set(dedup.canonicalPaths), new Set([path.resolve(f1), path.resolve(f2)]));
});

test("sorted discovery and directory errors do not stop other sources", () => {
  const { cfg, bundled, user } = setup();
  writeAgent(bundled, "b1", { name: "b1" });
  writeAgent(bundled, "a1", { name: "a1" });
  const snap = discoverCatalogSnapshot({ cfg, bundled, user });
  assert.deepEqual(snap.entries.map((e) => e.name), ["a1", "b1"]);
  // missing project agent dir and configured dir produce diagnostics
  assert.ok(snap.diagnostics.directoryErrors.some((d) => d.dir === cfg.agentDir));
});

function discoverCatalogSnapshot(
  envCtx: { cfg: ReturnType<typeof loadConfig>; bundled: string; user: string },
  opts?: Parameters<typeof discoverCatalog>[2],
) {
  return discoverCatalog(envCtx.cfg, true, {
    bundledAgentsDir: envCtx.bundled,
    userAgentsDir: envCtx.user,
    ...opts,
  });
}

test("thresholds: valid probe manifest parses; non-probe thresholds produce a diagnostic", () => {
  const { cfg, bundled, user } = setup();
  writeAgent(bundled, "p", {
    name: "p",
    kind: "probe",
    thresholds: [
      { id: "cpu-load", metric: "load1", operator: "gt", value: 4, unit: "load", severity: "warning" },
    ],
  });
  const snap = discoverCatalogSnapshot({ cfg, bundled, user });
  const p = snap.entries.find((e) => e.name === "p")!;
  assert.deepEqual(p.thresholds, [
    { id: "cpu-load", metric: "load1", operator: "gt", value: 4, unit: "load", severity: "warning" },
  ]);

  writeAgent(bundled, "g", {
    name: "g",
    kind: "general",
    thresholds: [{ id: "t", metric: "m", operator: "gt", value: 1, unit: "u", severity: "critical" }],
  });
  const snap2 = discoverCatalogSnapshot({ cfg, bundled, user });
  assert.ok(snap2.diagnostics.invalidFiles.some((d) => /only valid for kind: probe/.test(d.message)));
});

test("parseManifest rejects bad threshold shapes", () => {
  const path2 = "/tmp/x.md";
  assert.throws(
    () => parseManifest(path2, "---\nname: t\nkind: probe\nthresholds:\n  - id: t\n    metric: m\n    operator: gt\n    value: 1\n    unit: u\n    severity: warn\n---\nbody"),
    ManifestValidationError as any,
  );
});

test("normalizeManifestEntry is reusable stand-alone and matches parseManifest", () => {
  // A parsed frontmatter object built in memory (as the blueprint parser will do)
  // normalizes to the exact same fields as a round-trip through the file path.
  const canonical = "/tmp/reuse.md";
  const content = "---\nname: reuse\ndescription: A reusable agent\nkind: general\ntools: [read, grep, read]\nmodel: m-1\ntimeoutSeconds: 120\n---\n\nBody here.";
  const viaFile = parseManifest(canonical, content, "user");
  const parsed = { frontmatter: {
    name: "reuse",
    description: "A reusable agent",
    kind: "general",
    tools: ["read", "grep", "read"],
    model: "m-1",
    timeoutSeconds: 120,
  }, body: "Body here." };
  const viaReuse = normalizeManifestEntry(
    parsed.frontmatter as Record<string, unknown>,
    parsed.body,
    content,
    canonical,
    "user",
  );
  assert.equal(viaReuse.entry.name, "reuse");
  assert.equal(viaReuse.entry.source, "user");
  assert.deepEqual(viaReuse.entry.tools, ["read", "grep"]);
  assert.equal(viaReuse.entry.contentHash, sha256Hex(content));
  assert.deepEqual(
    {
      name: viaReuse.entry.name,
      description: viaReuse.entry.description,
      kind: viaReuse.entry.kind,
      tools: viaReuse.entry.tools,
      model: viaReuse.entry.model,
      timeoutSeconds: viaReuse.entry.timeoutSeconds,
      body: viaReuse.entry.body,
      contentHash: viaReuse.entry.contentHash,
    },
    {
      name: viaFile.entry.name,
      description: viaFile.entry.description,
      kind: viaFile.entry.kind,
      tools: viaFile.entry.tools,
      model: viaFile.entry.model,
      timeoutSeconds: viaFile.entry.timeoutSeconds,
      body: viaFile.entry.body,
      contentHash: viaFile.entry.contentHash,
    },
  );
});

test("cross-source precedence: project > user > bundled; shadowed provenance retained", () => {
  const { cfg, bundled, user } = setup();
  writeAgent(bundled, "who", { name: "who", description: "bundled who" }, "bundled body");
  writeAgent(user, "who", { name: "who", description: "user who" }, "user body");
  fs.mkdirSync(cfg.agentDir, { recursive: true });
  writeAgent(cfg.agentDir, "who", { name: "who", description: "project who" }, "project body");

  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: bundled, userAgentsDir: user });
  const who = snap.entries.find((e) => e.name === "who")!;
  assert.equal(who.source, "project");
  assert.equal(who.description, "project who");
  assert.equal(snap.shadowed.length, 2);
  assert.deepEqual(
    new Set(snap.shadowed.map((s) => `${s.source}:${s.name}`)),
    new Set(["user:who", "bundled:who"]),
  );
});

test("configured directory ordering: later agentDirs entry wins", () => {
  const root = tmpdir();
  const dirA = path.join(root, ".ops", "a");
  const dirB = path.join(root, ".ops", "b");
  fs.mkdirSync(path.join(root, ".ops"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ops", "config.json"), JSON.stringify({ agentDirs: ["a", "b"] }));
  const cfg = loadConfig(root);
  writeAgent(dirA, "win", { name: "win", description: "from A" });
  writeAgent(dirB, "win", { name: "win", description: "from B" });
  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: path.join(root, "x"), userAgentsDir: path.join(root, "y") });
  const win = snap.entries.find((e) => e.name === "win")!;
  assert.equal(win.description, "from B");
  assert.equal(win.source, "configured");
  assert.ok(win.canonicalPath.startsWith(dirB));
  assert.equal(snap.shadowed.length, 1);
});

test("includeBundledAgents: false skips package definitions only", () => {
  const { cfg, bundled, user } = setup();
  cfg.includeBundledAgents = false;
  writeAgent(bundled, "bundled-only", { name: "bundled-only" });
  writeAgent(user, "user-agent", { name: "user-agent" });
  fs.mkdirSync(cfg.agentDir, { recursive: true });
  writeAgent(cfg.agentDir, "proj-agent", { name: "proj-agent" });
  const snap = discoverCatalog(cfg, true, { bundledAgentsDir: bundled, userAgentsDir: user });
  assert.ok(!snap.entries.some((e) => e.name === "bundled-only"));
  assert.ok(snap.entries.some((e) => e.name === "user-agent"));
  assert.ok(snap.entries.some((e) => e.name === "proj-agent"));
  assert.equal(snap.includeBundledAgents, false);
});

test("discovery is fresh per call: edits between calls change the next snapshot only", () => {
  const { cfg, bundled, user } = setup();
  const f = writeAgent(bundled, "edit", { name: "edit", description: "v1" }, "first body");
  const snap1 = discoverCatalogSnapshot({ cfg, bundled, user });
  const e1 = snap1.entries.find((e) => e.name === "edit")!;
  const hash1 = e1.contentHash;
  fs.writeFileSync(f, "---\nname: edit\ndescription: v2\n---\n\nsecond body");
  const snap2 = discoverCatalogSnapshot({ cfg, bundled, user });
  const e2 = snap2.entries.find((e) => e.name === "edit")!;
  assert.notEqual(snap1, snap2);
  assert.notEqual(e1.contentHash, e2.contentHash);
  assert.equal(snap2.entries.length, 1);
});
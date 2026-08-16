import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverBlueprints } from "../extensions/blueprints.ts";
import { sha256Hex, findPackageRoot } from "../extensions/catalog.ts";
import {
  INIT_BUNDLED_BLUEPRINT_NAMES,
  RECOMMENDED_BLUEPRINT_NAMES,
  BLUEPRINT_DEFAULT_KIND,
  BLUEPRINT_DEFAULT_TOOLS,
} from "../extensions/constants.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-blueprints-"));
}

function blueprint(
  name: string,
  overrides: Record<string, unknown> = {},
  body = "Review the repository, cite evidence for claims, report unknowns, and propose changes without mutating anything.",
): string {
  const keys = ["name", "description", "category", "when"];
  const defaults: Record<string, string> = {
    name,
    description: "Generic review blueprint",
    category: "testing-quality",
    when: "Use when generic quality review applies",
  };
  const fm: string[] = [];
  for (const k of keys) {
    fm.push(`${k}: ${typeof overrides[k] === "string" ? (overrides[k] as string) : defaults[k]}`);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (keys.includes(k)) continue;
    if (typeof v === "boolean") fm.push(`${k}: ${v}`);
    else if (Array.isArray(v)) fm.push(`${k}: ${v.join(", ")}`);
    else fm.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return `---\n${fm.join("\n")}\n---\n\n${body}`;
}

function writeBp(dir: string, name: string, overrides: Record<string, unknown> = {}, body?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, blueprint(name, overrides, body));
  return file;
}

function makeDirs(): { bundled: string; user: string; projectDir: string } {
  const root = tmpdir();
  const bundled = path.join(root, "bundled");
  const user = path.join(root, "user");
  const projectDir = path.join(root, "proj-blueprints");
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  return { bundled, user, projectDir };
}

function discover(
  dirs: { bundled: string; user: string; projectDir: string },
  extra: Partial<Parameters<typeof discoverBlueprints>[0]> = {},
) {
  return discoverBlueprints({
    projectTrusted: true,
    projectRoot: "/tmp",
    outputRoot: "/tmp",
    bundledDir: dirs.bundled,
    userDir: dirs.user,
    projectDir: dirs.projectDir,
    ...extra,
  });
}

test("valid generic blueprint parses with source, path, and content hash", () => {
  const dirs = makeDirs();
  const f = writeBp(dirs.bundled, "quality", { tools: "read, grep, read" });
  const snap = discover(dirs);
  const q = snap.blueprints.find((b) => b.name === "quality")!;
  assert.ok(q);
  assert.equal(q.source, "bundled");
  assert.equal(q.kind, "general");
  assert.deepEqual(q.tools, ["read", "grep"]);
  assert.equal(q.recommendedByDefault, false);
  assert.equal(q.canonicalPath, path.resolve(f));
  assert.equal(q.contentHash, sha256Hex(fs.readFileSync(f, "utf8")));
  assert.ok(q.prompt.length > 0);
});

test("unknown key rejects the blueprint without creating implicit behavior", () => {
  const dirs = makeDirs();
  writeBp(dirs.bundled, "framework", { framework: "django" });
  const snap = discover(dirs);
  assert.ok(!snap.blueprints.some((b) => b.name === "framework"));
  const diag = snap.diagnostics.invalidFiles.find((d) => d.canonicalPath.endsWith("framework.md"));
  assert.ok(diag);
  assert.match(diag.message, /framework/);
});

test("secret-like body is rejected and the literal is not exposed", () => {
  const dirs = makeDirs();
  writeBp(dirs.bundled, "leak", {}, "Govern against password=hunter2 accidentally.");
  const snap = discover(dirs);
  assert.ok(!snap.blueprints.some((b) => b.name === "leak"));
  const diag = snap.diagnostics.invalidFiles.find((d) => d.canonicalPath.endsWith("leak.md"));
  assert.ok(diag);
  assert.doesNotMatch(diag.message, /hunter2/);
  assert.match(diag.message, /secret/i);
});

test("byte bounds reject oversized prompt, description, and when", () => {
  const dirs = makeDirs();
  writeBp(dirs.bundled, "bigprompt", {}, "A".repeat(52_000));
  writeBp(dirs.bundled, "bigdesc", { description: "d".repeat(1_100) });
  writeBp(dirs.bundled, "bigwhen", { when: "w".repeat(1_100) }, "body");
  const snap = discover(dirs);
  for (const n of ["bigprompt", "bigdesc", "bigwhen"]) {
    assert.ok(!snap.blueprints.some((b) => b.name === n), `${n} should be rejected`);
  }
  const msgs = snap.diagnostics.invalidFiles.map((d) => d.message).join(" ");
  assert.match(msgs, /UTF-8 bytes/);
});

test("empty prompt body is rejected", () => {
  const dirs = makeDirs();
  writeBp(dirs.bundled, "empty", {}, "");
  const snap = discover(dirs);
  assert.ok(!snap.blueprints.some((b) => b.name === "empty"));
});

test("duplicate names within one directory invalidate all participants", () => {
  const dirs = makeDirs();
  const f1 = writeBp(dirs.bundled, "dup", { description: "first" });
  const f2 = writeBp(dirs.bundled, "dup2", { name: "dup", description: "second" });
  const snap = discover(dirs);
  assert.ok(!snap.blueprints.some((b) => b.name === "dup"));
  const dd = snap.diagnostics.duplicateNames.find((d) => d.name === "dup")!;
  assert.ok(dd);
  assert.deepEqual(new Set(dd.canonicalPaths), new Set([path.resolve(f1), path.resolve(f2)]));
});

test("cross-source precedence is project > user > bundled with shadowing", () => {
  const dirs = makeDirs();
  writeBp(dirs.bundled, "who", { name: "who", description: "bundled who" });
  writeBp(dirs.user, "who", { name: "who", description: "user who" });
  writeBp(dirs.projectDir, "who", { name: "who", description: "project who" });
  const snap = discover(dirs);
  const who = snap.blueprints.find((b) => b.name === "who")!;
  assert.equal(who.source, "project");
  assert.equal(who.description, "project who");
  assert.equal(snap.diagnostics.shadowed.length, 2);
});

test("nested blueprints are not discovered", () => {
  const dirs = makeDirs();
  writeBp(dirs.bundled, "top", { name: "top" });
  writeBp(path.join(dirs.bundled, "nested"), "deep", { name: "deep" });
  const snap = discover(dirs);
  assert.ok(snap.blueprints.some((b) => b.name === "top"));
  assert.ok(!snap.blueprints.some((b) => b.name === "deep"));
});

test("project blueprint is included only when output is inside the trusted project", () => {
  const dirs = makeDirs();
  writeBp(dirs.projectDir, "proj-bp", { name: "proj-bp" });
  // outputRoot inside projectRoot: included.
  const inside = discoverBlueprints({
    projectTrusted: true,
    projectRoot: dirs.projectDir,
    outputRoot: dirs.projectDir,
    bundledDir: dirs.bundled,
    userDir: dirs.user,
    projectDir: dirs.projectDir,
  });
  assert.ok(inside.blueprints.some((b) => b.name === "proj-bp"));

  // external output root: not included and reported.
  const external = discoverBlueprints({
    projectTrusted: true,
    projectRoot: "/trusted/project",
    outputRoot: "/separate/repo",
    bundledDir: dirs.bundled,
    userDir: dirs.user,
    projectDir: dirs.projectDir,
  });
  assert.ok(!external.blueprints.some((b) => b.name === "proj-bp"));
  assert.ok(external.diagnostics.trustExclusions.some((t) => t.reason === "project-blueprints-untrusted"));
});

test("recommendedByDefault is honored and non-boolean values fail", () => {
  const dirs = makeDirs();
  writeBp(dirs.bundled, "rec", { name: "rec", recommendedByDefault: true });
  writeBp(dirs.bundled, "badrec", { name: "badrec", recommendedByDefault: "yes" });
  const snap = discover(dirs);
  assert.equal(snap.blueprints.find((b) => b.name === "rec")!.recommendedByDefault, true);
  assert.ok(!snap.blueprints.some((b) => b.name === "badrec"));
});

test("edits between calls apply to the next snapshot only", () => {
  const dirs = makeDirs();
  const f = writeBp(dirs.bundled, "edit", { name: "edit", description: "v1" });
  const snap1 = discover(dirs);
  const h1 = snap1.blueprints.find((b) => b.name === "edit")!.contentHash;
  fs.writeFileSync(f, blueprint("edit", { description: "v2" }));
  const snap2 = discover(dirs);
  const e2 = snap2.blueprints.find((b) => b.name === "edit")!;
  assert.notEqual(h1, e2.contentHash);
  assert.equal(e2.description, "v2");
});

test("bounded diagnostics report omitted counts", () => {
  const dirs = makeDirs();
  for (let i = 0; i < 150; i++) {
    fs.writeFileSync(
      path.join(dirs.bundled, `bad${i}.md`),
      blueprint(`bad${i}`, { bogusKey: i }),
    );
  }
  const snap = discover(dirs);
  const total =
    snap.diagnostics.invalidFiles.length +
    snap.diagnostics.duplicateNames.length +
    snap.diagnostics.directoryErrors.length +
    snap.diagnostics.trustExclusions.length;
  assert.ok(total <= 100);
  assert.ok(snap.diagnostics.omittedCount >= 50);
});

test("bundled pack ships the exact eight generic assets with expected defaults", () => {
  const dirp = path.join(findPackageRoot(), "blueprints");
  const names = fs
    .readdirSync(dirp)
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.replace(/\.md$/, ""))
    .sort();
  assert.deepEqual(names, [...INIT_BUNDLED_BLUEPRINT_NAMES].sort());
  assert.equal(names.length, 8);

  const root = tmpdir();
  const snap = discoverBlueprints({
    projectTrusted: true,
    projectRoot: "/tmp",
    outputRoot: "/tmp",
    userDir: path.join(root, "no-user"),
    projectDir: path.join(root, "no-proj"),
  });
  assert.equal(snap.blueprints.length, 8);
  assert.equal(snap.diagnostics.invalidFiles.length, 0, JSON.stringify(snap.diagnostics.invalidFiles));
  for (const b of snap.blueprints) {
    assert.equal(b.kind, BLUEPRINT_DEFAULT_KIND);
    assert.deepEqual(b.tools, [...BLUEPRINT_DEFAULT_TOOLS]);
    assert.equal(b.recommendedByDefault, RECOMMENDED_BLUEPRINT_NAMES.has(b.name));
    assert.match(b.when, /^[a-z]/i);
    assert.ok(b.prompt.trim().length > 0);
  }
});

test("bundled blueprint bodies are framework-neutral and secret-free", () => {
  const dirp = path.join(findPackageRoot(), "blueprints");
  const root = tmpdir();
  const snap = discoverBlueprints({
    projectTrusted: true,
    projectRoot: "/tmp",
    outputRoot: "/tmp",
    userDir: path.join(root, "no-user"),
    projectDir: path.join(root, "no-proj"),
  });
  assert.equal(snap.diagnostics.invalidFiles.length, 0, "no bundled blueprint is rejected");
  for (const name of INIT_BUNDLED_BLUEPRINT_NAMES) {
    const content = fs.readFileSync(path.join(dirp, `${name}.md`), "utf8");
    // No named language/framework/product/cloud/layout assumptions.
    assert.doesNotMatch(content, /\b(django|react|express|spring|kubernetes|aws|azure|postgres|rails)\b/i);
    // Reviewer must propose, not mutate.
    assert.match(content, /propose/i);
  }
});
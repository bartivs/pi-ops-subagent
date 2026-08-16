import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeManifestDraft,
  serializeManifest,
  verifyRoundTrip,
  collectSecretField,
  buildPreview,
  commitPreview,
  canonicalJson,
  StageManifestError,
} from "../extensions/manifest-generation.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InitBlueprint } from "../extensions/types.ts";

// A blueprint with a full optional set for inheritance tests.
const BLUEPRINTS: InitBlueprint[] = [
  {
    name: "arch",
    description: "Architecture review",
    category: "architecture",
    when: "architecture",
    recommendedByDefault: true,
    kind: "general",
    tools: ["read", "grep", "find", "ls"],
    model: "m-blueprint",
    timeoutSeconds: 120,
    contract: "prod",
    prompt: "Blueprint body.",
    source: "bundled",
    canonicalPath: "/blueprints/arch.md",
    contentHash: "h",
  },
];

function draft(overrides: Record<string, unknown>): Record<string, unknown> {
  return { name: "review-agent", description: "Reviews", ...overrides };
}

test("minimal custom draft defaults to general kind and default read tools", () => {
  const m = normalizeManifestDraft(draft({ prompt: "Do reviews." }), BLUEPRINTS);
  assert.equal(m.kind, "general");
  assert.deepEqual(m.tools, ["read", "grep", "find", "ls"]);
  assert.equal(m.provenance.source, "custom");
  assert.equal(m.model, undefined);
  assert.equal(m.timeoutSeconds, undefined);
  assert.equal(m.contract, undefined);
});

test("blueprint inheritance copies omitted body, kind, tools, and optionals", () => {
  const m = normalizeManifestDraft(draft({ blueprintName: "arch" }), BLUEPRINTS);
  assert.equal(m.prompt, BLUEPRINTS[0].prompt);
  assert.equal(m.provenance.source, "bundled");
  assert.equal(m.kind, "general");
  assert.deepEqual(m.tools, ["read", "grep", "find", "ls"]);
  assert.equal(m.model, "m-blueprint");
  assert.equal(m.timeoutSeconds, 120);
  assert.equal(m.contract, "prod");
});

test("explicit null removes an inherited nullable optional value", () => {
  const bp = { ...BLUEPRINTS[0], model: "m-x", timeoutSeconds: 99 };
  const m = normalizeManifestDraft(draft({ blueprintName: "arch", model: null, timeoutSeconds: null }), [bp]);
  assert.equal(m.model, undefined);
  assert.equal(m.timeoutSeconds, undefined);
});

test("custom draft that omits prompt fails before preview", () => {
  assert.throws(() => normalizeManifestDraft(draft({}), BLUEPRINTS), StageManifestError as any);
});

test("unknown blueprintName fails", () => {
  assert.throws(
    () => normalizeManifestDraft(draft({ blueprintName: "nope", prompt: "x" }), BLUEPRINTS),
    /Unknown blueprintName/,
  );
});

test("invalid explicit values fail (bad kind, bad tools, bad timeout)", () => {
  assert.throws(() => normalizeManifestDraft(draft({ kind: 7, prompt: "x" }), BLUEPRINTS), StageManifestError as any);
  assert.throws(() => normalizeManifestDraft(draft({ tools: [1], prompt: "x" }), BLUEPRINTS), StageManifestError as any);
  assert.throws(() => normalizeManifestDraft(draft({ timeoutSeconds: "x", prompt: "x" }), BLUEPRINTS), StageManifestError as any);
});

test("serialization is deterministic and byte-identical across calls", () => {
  const m = normalizeManifestDraft(draft({ prompt: "Body.", model: "mm", timeoutSeconds: 30 }), []);
  const a = serializeManifest(m);
  const b = serializeManifest(normalizeManifestDraft(draft({ prompt: "Body.", model: "mm", timeoutSeconds: 30 }), []));
  assert.equal(a, b);
  assert.match(a, /^---\nname: "review-agent"\ndescription: "Reviews"\nkind: "general"\ntools: \["read","grep","find","ls"\]\nmodel: "mm"\ntimeoutSeconds: 30\n---\n/);
});

test("thresholds are serialized in the canonical id,metric,operator,value,unit,severity order", () => {
  const m = normalizeManifestDraft(
    draft({ prompt: "x", kind: "probe", thresholds: [
      { operator: "gt", value: 4, severity: "warning", metric: "load", id: "cpu", unit: "load" },
    ] }),
    [],
  );
  const text = serializeManifest(m);
  assert.ok(text.indexOf('"id":"cpu","metric":"load","operator":"gt","value":4,"unit":"load","severity":"warning"') >= 0);
});

test("round-trip passes for a valid normalized manifest and matches prompt body", () => {
  const m = normalizeManifestDraft(draft({ prompt: "Final prompt body.", model: "m" }), []);
  assert.doesNotThrow(() => verifyRoundTrip(m, "/tmp/r.md"));
});

test("secret-like prompt is rejected; environment placeholder is allowed", () => {
  const secret = normalizeManifestDraft(draft({ prompt: "Use password=hunter2 here" }), []);
  assert.equal(collectSecretField(secret), "prompt");
  const ok = normalizeManifestDraft(draft({ prompt: "Use ${DATABASE_URL} here" }), []);
  assert.equal(collectSecretField(ok), null);
  assert.doesNotThrow(() => verifyRoundTrip(ok, "/tmp/ok.md"));
});

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-manifest-preview-"));
}

function normalized(name = "review-agent", overrides: Record<string, unknown> = {}) {
  return normalizeManifestDraft({ name, description: `${name} description`, prompt: "Review evidence.", ...overrides }, BLUEPRINTS);
}

function agentsDir(root: string): string {
  return path.join(root, ".pi", "agents");
}

function preview(root: string, manifests: ReturnType<typeof normalized>[], replaceExisting: string[] = []) {
  return buildPreview({ initializationId: "init-00000000-0000-4000-8000-000000000000", outputRoot: root, manifests, replaceExisting });
}

test("preview classifies create, unchanged, and explicit replace with hashes and diffs", () => {
  const root = tempRoot();
  const created = normalized("created");
  const createPreview = preview(root, [created]);
  assert.equal(createPreview.manifests[0].action, "create");
  assert.match(createPreview.previewId, /^preview-[a-f0-9]{64}$/);
  assert.equal(createPreview.agentsMd.action, "create");

  fs.mkdirSync(agentsDir(root), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(root), "created.md"), serializeManifest(created));
  const samePreview = preview(root, [created]);
  assert.equal(samePreview.manifests[0].action, "unchanged");
  assert.ok(samePreview.manifests[0].beforeHash);

  const changed = normalized("created", { prompt: "Revised review evidence." });
  assert.throws(() => preview(root, [changed]), /replaceExisting/);
  const replacePreview = preview(root, [changed], ["created"]);
  assert.equal(replacePreview.manifests[0].action, "replace");
  assert.ok(replacePreview.manifests[0].diff!.includes("+ Revised review evidence."));
});

test("preview refuses stale replacement, alternate-filename name collision, and symlink paths", () => {
  const root = tempRoot();
  assert.throws(() => preview(root, [normalized("new")], ["new"]), /stale/);

  fs.mkdirSync(agentsDir(root), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(root), "legacy.md"), "---\nname: collide\ndescription: legacy\n---\n\nbody\n");
  assert.throws(() => preview(root, [normalized("collide")]), /already declared/);

  const linkedRoot = tempRoot();
  fs.mkdirSync(path.join(linkedRoot, ".pi"), { recursive: true });
  fs.symlinkSync(tempRoot(), agentsDir(linkedRoot));
  assert.throws(() => preview(linkedRoot, [normalized("linked")]), /symbolic link/);
});

test("preview carries invalid-existing diagnostics, elevated warnings, and deterministic canonical IDs", () => {
  const root = tempRoot();
  fs.mkdirSync(agentsDir(root), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(root), "broken.md"), "---\nname: 9bad\n---\n\nbody\n");
  const a = normalized("alpha", { tools: ["read", "bash"] });
  const z = normalized("zeta");
  const first = preview(root, [z, a]);
  const second = preview(root, [a, z]);
  assert.equal(first.previewId, second.previewId);
  assert.deepEqual(first.manifests.map((m) => m.name), ["alpha", "zeta"]);
  assert.deepEqual(first.elevatedToolAgents, [{ name: "alpha", tools: ["bash"] }]);
  assert.equal(first.diagnostics.invalidExistingManifests.length, 1);
  assert.equal(canonicalJson({ z: 1, a: { b: 2, a: 1 } }), '{"a":{"a":1,"b":2},"z":1}');
});

test("commit installs create/replace plus guidance and reports an unchanged no-op", () => {
  const root = tempRoot();
  fs.mkdirSync(agentsDir(root), { recursive: true });
  const old = normalized("replace-me", { prompt: "Old prompt." });
  fs.writeFileSync(path.join(agentsDir(root), "replace-me.md"), serializeManifest(old), { mode: 0o600 });
  const fresh = normalized("new-one");
  const revised = normalized("replace-me", { prompt: "New prompt." });
  const p = preview(root, [fresh, revised], ["replace-me"]);
  const result = commitPreview(p, { initializationId: "init-test" });
  assert.deepEqual(result.created.sort(), [path.join(agentsDir(root), "new-one.md"), path.join(root, "AGENTS.md")].sort());
  assert.deepEqual(result.replaced, [path.join(agentsDir(root), "replace-me.md")]);
  assert.equal(fs.readFileSync(path.join(agentsDir(root), "replace-me.md"), "utf8"), serializeManifest(revised));
  assert.equal(fs.statSync(path.join(agentsDir(root), "replace-me.md")).mode & 0o777, 0o644);
  assert.ok(fs.existsSync(path.join(root, "AGENTS.md")));

  const noOp = preview(root, [fresh, revised]);
  const again = commitPreview(noOp, { initializationId: "init-test-2" });
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.replaced, []);
  assert.ok(again.unchanged.length >= 3);
});

test("commit rejects stale inputs before writes and rolls back an injected rename failure", () => {
  const root = tempRoot();
  fs.mkdirSync(agentsDir(root), { recursive: true });
  const old = normalized("restore", { prompt: "Original." });
  const oldText = serializeManifest(old);
  const target = path.join(agentsDir(root), "restore.md");
  fs.writeFileSync(target, oldText);
  const revised = normalized("restore", { prompt: "Replacement." });
  const stale = preview(root, [revised], ["restore"]);
  fs.writeFileSync(target, `${oldText}\nexternal change`);
  assert.throws(() => commitPreview(stale, { initializationId: "init-stale" }), /stale/);
  assert.match(fs.readFileSync(target, "utf8"), /external change/);

  fs.writeFileSync(target, oldText);
  const rollbackPreview = preview(root, [revised], ["restore"]);
  let calls = 0;
  assert.throws(() => commitPreview(rollbackPreview, {
    initializationId: "init-rollback",
    renameSync(from, to) {
      calls++;
      if (calls === 2) throw new Error("injected final rename failure");
      fs.renameSync(from, to);
    },
  }), /Commit transaction failed/);
  assert.equal(fs.readFileSync(target, "utf8"), oldText, "original restored after rollback");
  const leftovers = fs.readdirSync(agentsDir(root)).filter((n) => /\.tmp$|\.bak$/.test(n));
  assert.deepEqual(leftovers, []);
});
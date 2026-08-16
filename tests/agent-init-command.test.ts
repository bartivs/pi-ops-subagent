import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  beginOrFollowUp,
  buildInitializerMessage,
  executeCancel,
  executeCommit,
  executeStage,
  executeStageWithApproval,
  createInitialization,
  reduceInitialization,
  validateCommandPrompt,
  validateInitScope,
  InitStateError,
} from "../extensions/agent-init.ts";
import { discoverBlueprints } from "../extensions/blueprints.ts";
import { INIT_MESSAGE_TYPE } from "../extensions/constants.ts";
import type { InitStateDetails } from "../extensions/types.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-init-cmd-"));
}

function researchState(id: string, outputRoot: string): InitStateDetails {
  const start = createInitialization(["read", "bash"], id);
  const scope = validateInitScope(
    { initializationId: id, contextRoots: [outputRoot], outputRoot, allowNetwork: false },
    { cwd: outputRoot, hasUI: true, networkRequested: false },
    id,
  );
  return reduceInitialization(start, { kind: "scope-accepted", scope, blueprints: [] });
}

const ID = "init-99999999-9999-4999-8999-999999999999";

test("command protocol is exact and keeps the prompt as natural language", () => {
  const msg = buildInitializerMessage(ID, "/repo", 'Focus on "deploy" \n and $HOME');
  assert.ok(msg.startsWith("PI OPS AGENT INITIALIZATION"));
  assert.ok(msg.includes(`Initialization: ${ID}`));
  assert.ok(msg.includes("Command cwd: /repo"));
  assert.ok(msg.includes("User request:"));
  assert.ok(msg.includes('Focus on "deploy" \n and $HOME'));
  // quotes and newlines are preserved verbatim; no JSON escaping in the envelope
  assert.ok(!msg.includes('"Focus on \\"deploy'));
  // explore-style, table-presenting, user-involved pipeline
  assert.ok(msg.includes("Phase 1 - Scope"));
  assert.ok(msg.includes("Phase 2 - Clarify (involve the user)"));
  assert.ok(msg.includes("Phase 3 - Propose as a table"));
  assert.ok(msg.includes("Phase 4 - Stage after approval"));
  assert.ok(msg.includes("Agent | Kind | Purpose"));
  assert.match(msg, /stop the turn/i);
  assert.match(msg, /never end with only prose/i);
  // schema + kinds so the coordinator does not guess fields or misuse artifact
  assert.ok(msg.includes("Manifest schema (use exactly these fields and kinds; never guess)"));
  assert.ok(msg.includes("kinds: `general` for agents that act (run commands/SSH); `probe` for read-only observation; `artifact` ONLY".replace("kinds:", "Kinds:")));
  assert.ok(msg.includes("ambient tooling infrastructure, not the subject of this initialization"));
  // optional-field shapes + ssh tool availability
  assert.match(msg, /leave `timeoutSeconds`, `thresholds`, `contract`, and `model` OUT unless you are certain of their exact shape/i);
  assert.match(msg, /`contract` is a short slug string/);
  assert.ok(msg.includes("may list `ssh` in `tools`"));
  // definition prompts: completion task list with blanks (openspec-propose style)
  assert.ok(msg.includes("### Definition completion task list"));
  assert.ok(msg.includes("- [ ] Targets — decide which systems or surfaces to act on"));
  assert.ok(msg.includes("- [ ] Open decisions — list anything unresolved instead of guessing. ____"));
  assert.match(msg, /agents that run local commands \(for example the docker or OS CLI\) list `bash`/);
  assert.match(msg, /agents that author a document list `write`/);
  assert.match(msg, /docker is only an example/);
  // completion checks the agent runs itself after commit
  assert.ok(msg.includes("# Completion checks (verify before ending the turn)"));
  assert.match(msg, /no temporary or staged leftovers remain/i);
  assert.match(msg, /initializer tools are no longer the active set/i);
});

test("command prompt bounds and trust refusal happen before state changes", () => {
  assert.throws(() => validateCommandPrompt("   ", true), /natural-language prompt/);
  assert.throws(() => validateCommandPrompt("x".repeat(20_001), true), /exceeds/);
  assert.throws(() => validateCommandPrompt("valid", false), /trusted project/);
  assert.equal(validateCommandPrompt("  Research this.  ", true), "Research this.");
});

test("follow-up routing reuses one non-terminal initialization and creates a fresh one after", () => {
  const started = beginOrFollowUp(null, ["read"]);
  assert.equal(started.created, true);
  const again = beginOrFollowUp(started.state, ["bash"]);
  assert.equal(again.created, false);
  assert.equal(again.state.initializationId, started.state.initializationId);
  const terminal = reduceInitialization(researchState(ID, tmp()), { kind: "cancel" });
  const fresh = beginOrFollowUp(terminal, ["bash"]);
  assert.equal(fresh.created, true);
});

test("stage builds an immutable preview and ends with terminate; revisions replace the preview id", () => {
  const root = tmp();
  const state = researchState(ID, root);
  const manifest = { name: "reviewer", description: "Reviews", prompt: "Cite evidence and propose only." };
  const staged = executeStage(state, { initializationId: ID, manifests: [manifest] });
  assert.equal(staged.state.state, "staged");
  assert.match(staged.state.currentPreview!.previewId, /^preview-[a-f0-9]{64}$/);
  assert.match(staged.text, /preview-[a-f0-9]{64}/);
  // preview-only hand-off: output root, no-files note, and an explicit commit/restage/cancel instruction
  assert.ok(staged.text.includes(`Output root: ${root}`));
  assert.match(staged.text, /no files were written/i);
  assert.match(staged.text, /reply "commit" to write these files/);
  const revised = executeStage(staged.state, { initializationId: ID, manifests: [{ ...manifest, description: "Revised" }] });
  assert.notEqual(revised.state.currentPreview!.previewId, staged.state.currentPreview!.previewId);
});

test("stage shows an approval dialog in interactive mode: approve commits, decline stays staged", async () => {
  const root = tmp();
  const state = researchState(ID, root);
  const manifest = { name: "reviewer", description: "Reviews", prompt: "Body." };
  const env = (confirm: (t: string, b: string) => Promise<boolean>) => ({ hasUI: true, cwd: root, confirm });

  // Decline at the stage dialog: preview stays staged, nothing written.
  let body = "";
  const declined = await executeStageWithApproval(
    state,
    { initializationId: ID, manifests: [manifest] },
    env(async (_t, b) => { body = b; return false; }),
  );
  assert.equal(declined.state.state, "staged");
  assert.ok(!fs.existsSync(path.join(root, ".pi", "agents", "reviewer.md")));
  assert.match(body, /Output root: /);

  // Approve at the stage dialog: same preview commits immediately, files written.
  const approved = await executeStageWithApproval(
    state,
    { initializationId: ID, manifests: [manifest] },
    env(async () => true),
  );
  assert.equal(approved.state.state, "completed");
  assert.ok(fs.existsSync(path.join(root, ".pi", "agents", "reviewer.md")));
  assert.match(approved.text, /Run \/ops:agents/);
});

test("stage approval dialog is skipped in headless mode; preview stays staged", async () => {
  const root = tmp();
  const state = researchState(ID, root);
  let asked = 0;
  const out = await executeStageWithApproval(
    state,
    { initializationId: ID, manifests: [{ name: "reviewer", description: "Reviews", prompt: "Body." }] },
    { hasUI: false, cwd: root, confirm: async () => { asked++; return true; } },
  );
  assert.equal(out.state.state, "staged");
  assert.equal(asked, 0);
  assert.ok(!fs.existsSync(path.join(root, ".pi", "agents", "reviewer.md")));
});

test("stage rejects unknown fields, duplicate names, and bad counts before preview", () => {
  const root = tmp();
  const state = researchState(ID, root);
  assert.throws(() => executeStage(state, { initializationId: ID, manifests: [{ name: "a", prompt: "x" }], bogus: 1 }), /Unknown stage field/);
  // unknown per-manifest field is rejected (spec: unknown generated argument fails)
  assert.throws(
    () => executeStage(state, { initializationId: ID, manifests: [{ name: "a", description: "d", prompt: "x", optionalFields: { report: "final" } }] }),
    /Unknown manifest field/,
  );
  // missing name reports the clear name error, not a misleading duplicate-name error
  assert.throws(
    () => executeStage(state, { initializationId: ID, manifests: [{ description: "d", prompt: "y" }] }),
    /"name" must be a string/,
  );
  assert.throws(
    () => executeStage(state, { initializationId: ID, manifests: [
      { name: "a", description: "d", prompt: "x" },
      { name: "a", description: "d2", prompt: "y" },
    ] }),
    /Duplicate manifest/,
  );
  assert.throws(
    () => executeStage(state, { initializationId: ID, manifests: [] }),
    /manifests must contain/,
  );
});

test("commit in the same batch fails preflight; stale preview ids are rejected", async () => {
  const root = tmp();
  const state = researchState(ID, root);
  // No preview yet (same-batch or never staged): preflight fails, nothing written.
  await assert.rejects(
    () => executeCommit(state, { initializationId: ID, previewId: "preview-aaaa" }, { hasUI: true, cwd: root, confirm: async () => true }),
    /No staged preview to commit/,
  );
  const staged = executeStage(state, { initializationId: ID, manifests: [{ name: "reviewer", description: "Reviews", prompt: "Body." }] }).state;
  await assert.rejects(
    () => executeCommit(staged, { initializationId: ID, previewId: "preview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, { hasUI: true, cwd: root, confirm: async () => true }),
    /current preview/,
  );
});

test("approved commit writes manifests and guidance, then completes; decline keeps staged", async () => {
  const root = tmp();
  const state = researchState(ID, root);
  const staged = executeStage(state, { initializationId: ID, manifests: [{ name: "reviewer", description: "Reviews", prompt: "Body." }] }).state;

  const declined = await executeCommit(staged, { initializationId: ID, previewId: staged.currentPreview!.previewId }, { hasUI: true, cwd: root, confirm: async () => false });
  assert.equal(declined.state.state, "staged");
  assert.ok(!fs.existsSync(path.join(root, ".pi", "agents", "reviewer.md")));

  const approved = await executeCommit(staged, { initializationId: ID, previewId: staged.currentPreview!.previewId }, { hasUI: true, cwd: root, confirm: async () => true });
  assert.equal(approved.state.state, "completed");
  assert.deepEqual(approved.commit!.created.sort(), [path.join(root, ".pi", "agents", "reviewer.md"), path.join(root, "AGENTS.md")].sort());
  assert.ok(fs.readFileSync(path.join(root, ".pi", "agents", "reviewer.md"), "utf8").includes("Body."));
  assert.match(approved.text, /Run \/ops:agents/);
});

test("approval dialog is fully specified (ids, root, per-file kind/tools, AGENTS.md, elevated, approve/decline)", async () => {
  const root = tmp();
  const state = researchState(ID, root);
  const staged = executeStage(state, {
    initializationId: ID,
    manifests: [
      { name: "local-inventory", description: "Enumerates local workloads", kind: "probe", tools: ["bash", "read"], prompt: "Body.\n### Definition completion task list\n- [ ] Targets ____\n- [ ] Open decisions ____" },
    ],
  }).state;
  let body = "";
  const approved = await executeCommit(
    staged,
    { initializationId: ID, previewId: staged.currentPreview!.previewId },
    { hasUI: true, cwd: root, confirm: async (_t, b) => { body = b; return true; } },
  );
  assert.ok(approved.commit);
  assert.ok(body.includes(`Initialization: ${ID}`));
  assert.ok(body.includes(staged.currentPreview!.previewId));
  assert.ok(body.includes(`Output root: ${root}`));
  assert.ok(body.includes("create local-inventory.md (probe; tools: bash, read)"));
  assert.match(body, /AGENTS\.md: (create|edit) \(managed table\)/);
  assert.match(body, /elevated\/unknown tools/i);
  assert.match(body, /approving writes these files/i);
  assert.match(body, /declining keeps the preview staged/i);
});

test("headless commit is rejected; rollback failure ends failed with tools restorable", async () => {
  const root = tmp();
  const state = researchState(ID, root);
  const staged = executeStage(state, { initializationId: ID, manifests: [{ name: "reviewer", description: "Reviews", prompt: "Body." }] }).state;
  await assert.rejects(
    () => executeCommit(staged, { initializationId: ID, previewId: staged.currentPreview!.previewId }, { hasUI: false, cwd: root, confirm: async () => true }),
    /interactive/,
  );

  // Inject a mid-transaction rename failure: rollback restores the original.
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  const target = path.join(root, ".pi", "agents", "reviewer.md");
  fs.writeFileSync(target, "---\nname: reviewer\ndescription: old\n---\n\nold body\n");
  const replaceState = executeStage(state, {
    initializationId: ID,
    manifests: [{ name: "reviewer", description: "Reviews", prompt: "New body." }],
    replaceExisting: ["reviewer"],
  }).state;
  let calls = 0;
  await assert.rejects(
    () => executeCommit(replaceState, { initializationId: ID, previewId: replaceState.currentPreview!.previewId }, {
      hasUI: true,
      cwd: root,
      confirm: async () => true,
      renameSync(from, to) {
        calls++;
        if (calls === 2) throw new Error("injected final rename failure");
        fs.renameSync(from, to);
      },
    }),
    /Commit failed/,
  );
  assert.match(fs.readFileSync(target, "utf8"), /old body/, "original restored after rollback");
});

test("cancel ends non-committing states without writes; committing refuses cancel", () => {
  const root = tmp();
  const state = researchState(ID, root);
  const cancelled = executeCancel(state, { initializationId: ID });
  assert.equal(cancelled.state.state, "cancelled");
  assert.match(cancelled.text, /No project files were written/);
  assert.throws(() => executeCancel(cancelled.state, { initializationId: ID }), InitStateError as any);
});

test("blueprint snapshot is captured at scope time and used for stage inheritance", () => {
  const root = tmp();
  const bundled = path.join(root, "bundled");
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(
    path.join(bundled, "arch.md"),
    "---\nname: arch\ndescription: Architecture\ncategory: architecture\nwhen: architecture\nkind: general\ntools: read, grep\nrecommendedByDefault: true\n---\n\nReview architecture.\n",
  );
  const snapshot = discoverBlueprints({ projectTrusted: true, projectRoot: root, outputRoot: root, bundledDir: bundled, userDir: path.join(root, "no-user"), projectDir: path.join(root, "no-proj") });
  const start = createInitialization(["read"], ID);
  const scope = validateInitScope({ initializationId: ID, contextRoots: [root], outputRoot: root, allowNetwork: false }, { cwd: root, hasUI: true, networkRequested: false }, ID);
  const state = reduceInitialization(start, { kind: "scope-accepted", scope, blueprints: snapshot.blueprints });
  const staged = executeStage(state, { initializationId: ID, manifests: [{ name: "mine", description: "Custom", blueprintName: "arch" }] });
  assert.equal(staged.state.state, "staged");
  const row = staged.state.currentPreview!.manifests.find((m) => m.name === "mine")!;
  assert.ok(row.bytes.includes("Review architecture."), "blueprint body inherited");
  assert.match(staged.state.currentPreview!.blueprintProvenance.map((p) => p.source).join(","), /bundled/);
});

void INIT_MESSAGE_TYPE;
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  INIT_COMMAND_NAME,
  INIT_MESSAGE_TYPE,
  INIT_ID_PREFIX,
  INIT_PREVIEW_ID_PREFIX,
  INIT_SCOPE_TOOL,
  INIT_STAGE_TOOL,
  INIT_COMMIT_TOOL,
  INIT_CANCEL_TOOL,
  INIT_TOOLS,
  INIT_READ_TOOLS,
  INIT_NETWORK_TOOLS,
  INIT_STATES,
  TERMINAL_INIT_STATES,
  INIT_PROMPT_MIN_BYTES,
  INIT_PROMPT_MAX_BYTES,
  INIT_CONTEXT_ROOTS_MIN,
  INIT_CONTEXT_ROOTS_MAX,
  INIT_OUTPUT_ROOTS,
  INIT_MANIFESTS_MIN,
  INIT_MANIFESTS_MAX,
  INIT_BLUEPRINT_PROMPT_MIN_BYTES,
  INIT_BLUEPRINT_PROMPT_MAX_BYTES,
  INIT_BLUEPRINT_TEXT_MAX_BYTES,
  INIT_AGENTS_MD_MAX_BYTES,
  INIT_GUIDANCE_DISPLAY_BYTES,
  INIT_DIAGNOSTIC_BOUND_ENTRIES,
  INIT_DIAGNOSTIC_BOUND_BYTES,
  INIT_DIR_MODE,
  INIT_MANIFEST_MODE,
  INIT_MARKER_START,
  INIT_MARKER_END,
  DEFAULT_AGENTS_DIR,
  OPS_AGENT_BLUEPRINTS_DIR,
  USER_BLUEPRINTS_SUBDIR,
  BUNDLED_BLUEPRINTS_DIR,
  INIT_BUNDLED_BLUEPRINT_NAMES,
  RECOMMENDED_BLUEPRINT_NAMES,
  BLUEPRINT_DEFAULT_KIND,
  BLUEPRINT_DEFAULT_TOOLS,
} from "../extensions/constants.ts";
import {
  beginOrFollowUp,
  createInitialization,
  recoverInitialization,
  reduceInitialization,
  validateInitScope,
  initActiveTools,
  isAllowedInitToolCall,
  InitStateError,
} from "../extensions/agent-init.ts";
import type { InitPreview, InitScope } from "../extensions/types.ts";

test("initializer command/message/id vocabulary is exact", () => {
  assert.equal(INIT_COMMAND_NAME, "/ops:agent-init");
  assert.equal(INIT_MESSAGE_TYPE, "ops:agent-init-request");
  assert.equal(INIT_ID_PREFIX, "init-");
  assert.equal(INIT_PREVIEW_ID_PREFIX, "preview-");
  assert.equal(INIT_SCOPE_TOOL, "ops_agent_init_scope");
  assert.equal(INIT_STAGE_TOOL, "ops_agent_init_stage");
  assert.equal(INIT_COMMIT_TOOL, "ops_agent_init_commit");
  assert.equal(INIT_CANCEL_TOOL, "ops_agent_init_cancel");
});

test("initializer tool policy sets are exact and non-overlapping", () => {
  assert.deepEqual(INIT_TOOLS, [
    "ops_agent_init_scope",
    "ops_agent_init_stage",
    "ops_agent_init_commit",
    "ops_agent_init_cancel",
  ]);
  assert.deepEqual(INIT_READ_TOOLS, ["read", "grep", "find", "ls"]);
  assert.deepEqual(INIT_NETWORK_TOOLS, [
    "web_search",
    "source_check",
    "fetch_content",
    "get_search_content",
  ]);
  for (const t of INIT_READ_TOOLS) assert.ok(!INIT_TOOLS.includes(t));
  for (const t of INIT_NETWORK_TOOLS) assert.ok(!INIT_READ_TOOLS.includes(t));
});

test("initializer state set is exact and terminal states are closed", () => {
  assert.deepEqual(INIT_STATES, [
    "resolving_scope",
    "researching",
    "staged",
    "committing",
    "completed",
    "cancelled",
    "failed",
  ]);
  assert.deepEqual([...TERMINAL_INIT_STATES].sort(), [
    "cancelled",
    "completed",
    "failed",
  ]);
  for (const s of INIT_STATES) {
    assert.equal(TERMINAL_INIT_STATES.has(s as (typeof INIT_STATES)[number]), s === "completed" || s === "cancelled" || s === "failed");
  }
});

test("initializer bounds match the v1 contract table", () => {
  assert.equal(INIT_PROMPT_MIN_BYTES, 1);
  assert.equal(INIT_PROMPT_MAX_BYTES, 20_000);
  assert.equal(INIT_CONTEXT_ROOTS_MIN, 1);
  assert.equal(INIT_CONTEXT_ROOTS_MAX, 8);
  assert.equal(INIT_OUTPUT_ROOTS, 1);
  assert.equal(INIT_MANIFESTS_MIN, 1);
  assert.equal(INIT_MANIFESTS_MAX, 32);
  assert.equal(INIT_BLUEPRINT_PROMPT_MIN_BYTES, 1);
  assert.equal(INIT_BLUEPRINT_PROMPT_MAX_BYTES, 51_200);
  assert.equal(INIT_BLUEPRINT_TEXT_MAX_BYTES, 1_000);
  assert.equal(INIT_AGENTS_MD_MAX_BYTES, 1_048_576);
  assert.equal(INIT_GUIDANCE_DISPLAY_BYTES, 300);
  assert.equal(INIT_DIAGNOSTIC_BOUND_ENTRIES, 100);
  assert.equal(INIT_DIAGNOSTIC_BOUND_BYTES, 51_200);
});

test("generated file and directory modes match the contract", () => {
  assert.equal(INIT_DIR_MODE, 0o755);
  assert.equal(INIT_MANIFEST_MODE, 0o644);
});

test("managed markers and path names are exact", () => {
  assert.equal(INIT_MARKER_START, "<!-- pi-ops-subagent:init:start -->");
  assert.equal(INIT_MARKER_END, "<!-- pi-ops-subagent:init:end -->");
  assert.equal(DEFAULT_AGENTS_DIR, "agents");
  assert.equal(OPS_AGENT_BLUEPRINTS_DIR, "ops-agent-blueprints");
  assert.equal(USER_BLUEPRINTS_SUBDIR, "pi-ops-subagent/blueprints");
  assert.equal(BUNDLED_BLUEPRINTS_DIR, "blueprints");
});

test("bundled blueprint pack is exact, generic, and defaulted", () => {
  assert.deepEqual(INIT_BUNDLED_BLUEPRINT_NAMES, [
    "architecture-review",
    "testing-quality-review",
    "security-review",
    "data-persistence-review",
    "api-integrations-review",
    "performance-review",
    "deployment-operations-review",
    "documentation-review",
  ]);
  assert.equal(INIT_BUNDLED_BLUEPRINT_NAMES.length, 8);
  assert.deepEqual([...RECOMMENDED_BLUEPRINT_NAMES].sort(), [
    "architecture-review",
    "security-review",
    "testing-quality-review",
  ]);
  assert.equal(BLUEPRINT_DEFAULT_KIND, "general");
  assert.deepEqual(BLUEPRINT_DEFAULT_TOOLS, ["read", "grep", "find", "ls"]);
});

function scope(id: string): InitScope {
  return { initializationId: id as InitScope["initializationId"], contextRoots: ["/repo"], outputRoot: "/repo", allowNetwork: false };
}

function preview(id: string, pid = "preview-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"): InitPreview {
  return {
    schemaVersion: 1,
    previewId: pid as InitPreview["previewId"],
    initializationId: id as InitPreview["initializationId"],
    outputRoot: "/repo",
    manifests: [],
    agentsMd: { action: "create", path: "/repo/AGENTS.md", afterBytes: "x", afterHash: "b".repeat(64) },
    blueprintProvenance: [],
    diagnostics: { invalidBlueprints: [], invalidExistingManifests: [], duplicateBlueprintNames: [], directoryErrors: [], trustExclusions: [], omittedCount: 0 },
    elevatedToolAgents: [],
  };
}

test("reducer follows the exact lifecycle and replaces staged previews", () => {
  const start = createInitialization(["read", "write"], "init-00000000-0000-4000-8000-000000000000");
  const researching = reduceInitialization(start, { kind: "scope-accepted", scope: scope(start.initializationId), blueprints: [] });
  const first = reduceInitialization(researching, { kind: "stage", preview: preview(start.initializationId) });
  const revised = reduceInitialization(first, { kind: "stage", preview: preview(start.initializationId, "preview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") });
  assert.equal(revised.state, "staged");
  assert.match(revised.currentPreview!.previewId, /^preview-b/);
  const committing = reduceInitialization(revised, { kind: "commit", previewId: revised.currentPreview!.previewId });
  const completed = reduceInitialization(committing, { kind: "complete" });
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.originalActiveTools, ["read", "write"]);
  assert.throws(() => reduceInitialization(completed, { kind: "fail", error: "no" }), InitStateError as any);
});

test("cancel and one-active rule respect committing and terminal states", () => {
  const start = createInitialization(["read"], "init-11111111-1111-4111-8111-111111111111");
  const research = reduceInitialization(start, { kind: "scope-accepted", scope: scope(start.initializationId), blueprints: [] });
  assert.equal(reduceInitialization(research, { kind: "cancel" }).state, "cancelled");
  const followed = beginOrFollowUp(research, ["bash"]);
  assert.equal(followed.created, false);
  assert.equal(followed.state.initializationId, research.initializationId);
  const afterTerminal = beginOrFollowUp(reduceInitialization(research, { kind: "cancel" }), ["bash"]);
  assert.equal(afterTerminal.created, true);
});

test("scope validator and tool gate enforce canonical roots and least privilege", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-init-scope-"));
  const allowed = path.join(root, "allowed");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ops-init-external-"));
  fs.mkdirSync(allowed);
  const start = createInitialization(["read", "grep", "bash", "web_search"], "init-33333333-3333-4333-8333-333333333333");
  const accepted = validateInitScope({ initializationId: start.initializationId, contextRoots: [allowed], outputRoot: allowed, allowNetwork: false }, { cwd: root, hasUI: true, networkRequested: false }, start.initializationId);
  const researching = reduceInitialization(start, { kind: "scope-accepted", scope: accepted, blueprints: [] });
  assert.deepEqual(initActiveTools(researching), ["ops_agent_init_scope", "ops_agent_init_stage", "ops_agent_init_commit", "ops_agent_init_cancel", "read", "grep"]);
  assert.equal(isAllowedInitToolCall(researching, "bash"), false);
  assert.equal(isAllowedInitToolCall(researching, "subagent"), false);
  assert.equal(isAllowedInitToolCall(researching, "read", { path: allowed }), true);
  assert.equal(isAllowedInitToolCall(researching, "read", { path: outside }), false);
  assert.throws(() => validateInitScope({ initializationId: start.initializationId, contextRoots: [outside], outputRoot: outside, allowNetwork: false }, { cwd: root, hasUI: false, networkRequested: false }, start.initializationId), /interactive UI/);
  const net = validateInitScope({ initializationId: start.initializationId, contextRoots: [allowed], outputRoot: allowed, allowNetwork: true }, { cwd: root, hasUI: true, networkRequested: true }, start.initializationId);
  const netState = reduceInitialization(start, { kind: "scope-accepted", scope: net, blueprints: [] });
  assert.ok(initActiveTools(netState).includes("web_search"));
});

test("symlink escape resolves outside accepted roots and is blocked; tools restore on terminal state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-init-sym-"));
  const allowed = path.join(root, "allowed");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ops-init-out-"));
  fs.mkdirSync(allowed);
  const start = createInitialization(["read", "write"], "init-44444444-4444-4444-8444-444444444444");
  const scope = validateInitScope({ initializationId: start.initializationId, contextRoots: [allowed], outputRoot: allowed, allowNetwork: false }, { cwd: root, hasUI: true, networkRequested: false }, start.initializationId);
  const researching = reduceInitialization(start, { kind: "scope-accepted", scope, blueprints: [] });
  // A symlink inside the accepted root that resolves outside must be blocked.
  const link = path.join(allowed, "escape");
  fs.symlinkSync(outside, link);
  assert.equal(isAllowedInitToolCall(researching, "read", { path: link }), false);
  // Terminal state restores the exact original tool list once.
  const cancelled = reduceInitialization(researching, { kind: "cancel" });
  assert.deepEqual(initActiveTools(cancelled), ["read", "write"]);
});

test("registered read tools activate even when not originally active; missing in-root files are not misblocked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-init-reg-"));
  fs.writeFileSync(path.join(root, "README.md"), "hi");
  const start = createInitialization(["read", "bash", "edit", "write"], "init-66666666-6666-4666-8666-666666666666");
  const scope = validateInitScope({ initializationId: start.initializationId, contextRoots: [root], outputRoot: root, allowNetwork: false }, { cwd: root, hasUI: true, networkRequested: false }, start.initializationId);
  const researching = reduceInitialization(start, { kind: "scope-accepted", scope, blueprints: [] });
  const registered = new Set(["read", "grep", "find", "ls"]);
  assert.deepEqual(initActiveTools(researching, registered), [
    "ops_agent_init_scope", "ops_agent_init_stage", "ops_agent_init_commit", "ops_agent_init_cancel",
    "read", "grep", "find", "ls",
  ]);
  // read on a file that does not exist inside the root must not be blocked.
  assert.equal(isAllowedInitToolCall(researching, "read", { path: path.join(root, "missing.md") }), true);
  assert.equal(isAllowedInitToolCall(researching, "read", { path: path.join(root, "README.md") }), true);
  // ls/find are allowed inside the root only when the registered set is provided.
  assert.equal(isAllowedInitToolCall(researching, "ls", { path: root }, registered), true);
  assert.equal(isAllowedInitToolCall(researching, "find", { path: path.join(root, "sub"), pattern: "**/*" }, registered), true);
  assert.equal(isAllowedInitToolCall(researching, "ls", { path: "/etc" }, registered), false);
  // bash is never activated even when it was originally active.
  assert.equal(initActiveTools(researching, registered).includes("bash"), false);
});

test("recovery restores only latest legal non-terminal state and fails closed on corrupt transitions", () => {
  const start = createInitialization(["read"], "init-22222222-2222-4222-8222-222222222222");
  const research = reduceInitialization(start, { kind: "scope-accepted", scope: scope(start.initializationId), blueprints: [] });
  const staged = reduceInitialization(research, { kind: "stage", preview: preview(start.initializationId) });
  const restored = recoverInitialization([start, research, staged]);
  assert.equal(restored!.state, "staged");
  assert.equal(restored!.currentPreview!.previewId, staged.currentPreview!.previewId);
  const corrupt = recoverInitialization([research, { ...research, state: "completed" }]);
  assert.equal(corrupt!.state, "failed");
  assert.equal(recoverInitialization([{ nope: true }]), null);
});
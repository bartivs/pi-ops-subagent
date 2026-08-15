import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, fakeInvocation, execReq, type ExecResult } from "./helpers.ts";
import { createRun, transition, finishRun, LifecycleError, snapshotRuns } from "../extensions/observability.ts";
import type { TaskRunRequest } from "../extensions/runner.ts";

function req(fx: ReturnType<typeof makeFixture>, over: Partial<TaskRunRequest> = {}): TaskRunRequest {
  const entry = fx.catalog.entries.find((e) => e.name === "probe-host")!;
  return {
    task: { agent: "probe-host", task: "Run state check" },
    entry,
    inputIndex: 0,
    chainStep: null,
    mode: "single",
    cwdBase: fx.root,
    timeout: { requestedSeconds: 300, effectiveSeconds: 300, clamped: false },
    dispatchModel: "acme/parent-1",
    dispatchThinking: undefined,
    contractsPrompt: undefined,
    parentJobId: null,
    sessionKey: null,
    probePolicyPath: undefined,
    childrenInvocationOverride: fakeInvocation(),
    ...over,
  };
}

function terminal(outcome: ExecResult["outcome"]) {
  return outcome.state;
}

test("run-<UUID v4> identity is stable across every snapshot", async () => {
  const fx = makeFixture();
  const { outcome, snapshotsAfter } = await execReq(req(fx), { FAKE_PI_DIGEST: "digest A" });
  assert.match(outcome.runId, /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const snap of snapshotsAfter) {
    if (snap.runId === outcome.runId) assert.equal(snap.runId, outcome.runId);
  }
});

test("observed lifecycle follows starting -> running -> done without omissions or reversal", async () => {
  const fx = makeFixture();
  const { outcome, lifecycle } = await execReq(req(fx), {});
  assert.deepEqual(lifecycle, ["starting", "running", "done"]);
  assert.equal(terminal(outcome), "done");
});

test("provenance and timing details are exact", async () => {
  const fx = makeFixture();
  const { outcome, snapshotsAfter } = await execReq(req(fx), { FAKE_PI_MODEL: "acme/fake-2" });
  const snap = snapshotsAfter.find((r) => r.runId === outcome.runId)!;
  assert.equal(snap.agent, "probe-host");
  assert.equal(snap.agentSource, "bundled");
  assert.match(snap.manifestPath!, /probe-host\.md$/);
  assert.equal(snap.mode, "single");
  assert.equal(snap.inputIndex, 0);
  assert.equal(snap.chainStep, null);
  assert.equal(snap.cwd, fx.root);
  // registry model is the initially-created model (dispatch fallback); outcome reports the child model
  assert.equal(snap.model, "acme/parent-1");
  assert.equal(outcome.model, "acme/fake-2");
  assert.equal(snap.timeoutEffectiveSeconds, 300);
  assert.equal(snap.timeoutClamped, false);
  assert.ok(snap.startedAt);
  assert.ok(snap.finishedAt);
  assert.ok(Date.parse(snap.finishedAt) >= Date.parse(snap.startedAt));
  assert.ok(snap.elapsedMs === null || snap.elapsedMs >= 0);
  assert.equal(snap.terminal, true);
  assert.equal(snap.stopReason, "end");
});

test("malformed/unknown child events produce bounded diagnostics, not failure", async () => {
  const fx = makeFixture();
  const { outcome, snapshotsAfter } = await execReq(req(fx), { FAKE_PI_UNKNOWN: "1", FAKE_PI_MALFORMED: "1" });
  assert.equal(terminal(outcome), "done");
  const snap = snapshotsAfter.find((r) => r.runId === outcome.runId)!;
  assert.ok(snap.activity.some((a) => a.kind === "unknown_event"));
  assert.ok(outcome.malformedLineCount >= 2);
});

test("spawn failure: starting -> failed with redacted error, terminal snapshot", async () => {
  const fx = makeFixture();
  const { outcome, lifecycle, snapshotsAfter } = await execReq(req(fx, { childrenInvocationOverride: { command: "/nonexistent/pi-zzz" } }), {});
  assert.equal(terminal(outcome), "failed");
  assert.deepEqual(lifecycle, ["starting", "failed"]);
  const snap = snapshotsAfter.find((r) => r.runId === outcome.runId)!;
  assert.equal(snap.terminal, true);
  assert.equal(snap.state, "failed");
  assert.ok(outcome.errorMessage);
});

test("terminal snapshots are immutable: no transition after done", () => {
  const run = createRun({
    mode: "single",
    agent: "a",
    agentSource: null,
    manifestPath: null,
    taskLabel: "t",
    cwd: "/tmp",
    model: null,
    timeoutRequestedSeconds: null,
    timeoutEffectiveSeconds: null,
    timeoutClamped: false,
  });
  transition(run.runId, "starting");
  transition(run.runId, "running");
  finishRun(run.runId, { state: "done", stopReason: "end", digest: "d" });
  assert.throws(() => transition(run.runId, "failed"), LifecycleError);
  assert.equal(finishRun(run.runId, { state: "failed" }), false);
  assert.equal(snapshotRuns().find((r) => r.runId === run.runId)!.state, "done");
});
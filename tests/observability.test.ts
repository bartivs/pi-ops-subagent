import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resetRegistry,
  createRun,
  transition,
  pushActivity,
  pushOutputTail,
  addUsage,
  finishRun,
  updateStaleness,
  evictRetained,
  dismissRun,
  displayRuns,
  snapshotRuns,
  getRun,
  setLastActivityForTest,
  LifecycleError,
  type RunInit,
} from "../extensions/observability.ts";
import { ACTIVITY_LIMIT, OUTPUT_TAIL_LINES, OUTPUT_TAIL_LINE_BYTES } from "../extensions/constants.ts";

function init(over: Partial<RunInit> = {}): RunInit {
  return {
    mode: "single",
    agent: "probe-host",
    agentSource: "bundled",
    manifestPath: "/agents/probe-host.md",
    taskLabel: "check",
    cwd: "/tmp",
    model: "acme/m-1",
    timeoutRequestedSeconds: 300,
    timeoutEffectiveSeconds: 300,
    timeoutClamped: false,
    ...over,
  };
}

test("createRun assigns run-<uuid v4> and queued state", () => {
  resetRegistry();
  const snap = createRun(init());
  assert.match(snap.runId, /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(snap.state, "queued");
  assert.equal(snap.terminal, false);
});

test("successful lifecycle follows queued->starting->running->finalizing->done", () => {
  resetRegistry();
  const snap = createRun(init());
  const seen: string[] = [snap.state];
  for (const s of ["starting", "running", "finalizing", "done"] as const) {
    transition(snap.runId, s);
    seen.push(getRun(snap.runId)!.state);
  }
  assert.deepEqual(seen, ["queued", "starting", "running", "finalizing", "done"]);
  const done = getRun(snap.runId)!;
  assert.equal(done.terminal, true);
  assert.ok(done.finishedAt);
});

test("any non-terminal state may move to failed/timed_out/aborted", () => {
  const SEQUENCE = ["starting", "running", "finalizing"] as const;
  for (const from of ["queued", ...SEQUENCE] as const) {
    for (const to of ["failed", "timed_out", "aborted"] as const) {
      resetRegistry();
      const snap = createRun(init());
      // advance through the happy path up to `from`
      for (const s of SEQUENCE) {
        if (s === from) break;
        transition(snap.runId, s);
      }
      transition(snap.runId, to);
      assert.equal(getRun(snap.runId)!.state, to, `queued -> ${from} -> ${to}`);
      assert.equal(getRun(snap.runId)!.terminal, true);
    }
  }
});

test("invalid transitions throw; terminal snapshots are immutable", () => {
  resetRegistry();
  const snap = createRun(init());
  assert.throws(() => transition(snap.runId, "done"), LifecycleError);
  assert.throws(() => transition(snap.runId, "queued"), LifecycleError);
  transition(snap.runId, "starting");
  assert.throws(() => transition(snap.runId, "done"), LifecycleError); // starting -> done invalid
  transition(snap.runId, "running");
  transition(snap.runId, "finalizing");
  finishRun(snap.runId, { state: "done" });
  assert.throws(() => transition(snap.runId, "failed"), LifecycleError);
  assert.equal(finishRun(snap.runId, { state: "failed" }), false); // already terminal
  assert.equal(getRun(snap.runId)!.state, "done");
});

test("activity bounded to 200 events, redacted", () => {
  resetRegistry();
  const snap = createRun(init());
  for (let i = 0; i < 250; i++) pushActivity(snap.runId, "progress", `event ${i} token=secret-${i}`);
  const run = getRun(snap.runId)!;
  assert.equal(run.activity.length, ACTIVITY_LIMIT);
  assert.equal(run.activity.at(-1)!.detail, `event 249 token=[REDACTED]`);
  assert.match(run.activity[0]!.detail, /token=\[REDACTED\]/);
  assert.ok(run.lastActivityAt);
});

test("output tail bounded to 100 lines x 2000 bytes UTF-8 safe", () => {
  resetRegistry();
  const snap = createRun(init());
  for (let i = 0; i < 150; i++) pushOutputTail(snap.runId, `line${i}`);
  const run = getRun(snap.runId)!;
  assert.equal(run.outputTail.length, OUTPUT_TAIL_LINES);
  assert.equal(run.outputTail.at(-1), "line149");

  const long = "x".repeat(OUTPUT_TAIL_LINE_BYTES + 500);
  const unicode = "é".repeat(2000); // 2 bytes each -> 4000+ bytes
  pushOutputTail(snap.runId, `${long}\n${unicode}`);
  const run2 = getRun(snap.runId)!;
  for (const line of run2.outputTail) {
    assert.ok(Buffer.byteLength(line, "utf8") <= OUTPUT_TAIL_LINE_BYTES, "line within byte budget");
  }
});

test("usage accumulates per-run", () => {
  resetRegistry();
  const snap = createRun(init());
  addUsage(snap.runId, { turns: 1, input: 10, output: 20, cacheRead: 5, cacheWrite: 3, cost: 0.01 });
  addUsage(snap.runId, { turns: 1, input: 2, output: 1, cost: 0.005 });
  const run = getRun(snap.runId)!;
  assert.deepEqual(
    { turns: run.usage.turns, input: run.usage.input, output: run.usage.output, cacheRead: run.usage.cacheRead, cacheWrite: run.usage.cacheWrite, cost: run.usage.cost },
    { turns: 2, input: 12, output: 21, cacheRead: 5, cacheWrite: 3, cost: 0.015 },
  );
});

test("stale flagging: no progress after staleAfterMs marks stale; progress clears it", () => {
  resetRegistry();
  const snap = createRun(init());
  transition(snap.runId, "starting");
  transition(snap.runId, "running");
  const now = Date.now();
  assert.equal(updateStaleness(now, 30_000).has(snap.runId), false); // fresh: no stale yet
  setLastActivityForTest(snap.runId, new Date(now - 120_000).toISOString());
  assert.equal(updateStaleness(now, 30_000).has(snap.runId), true);

  pushActivity(snap.runId, "progress", "here");
  assert.equal(updateStaleness(now + 100, 30_000).has(snap.runId), false);

  // terminal runs are never stale
  finishRun(snap.runId, { state: "done" });
  assert.equal(getRun(snap.runId)!.stale, false);
});

test("retention eviction oldest-finished first; never evicts active; dismissal is display-only", () => {
  resetRegistry();
  const a = createRun(init({ taskLabel: "a" }));
  transition(a.runId, "starting");
  transition(a.runId, "running");
  const b = createRun(init({ taskLabel: "b" }));
  finishRun(b.runId, { state: "done", digest: "b-digest" });
  const c = createRun(init({ taskLabel: "c" }));
  finishRun(c.runId, { state: "done", digest: "c-digest" });
  const now = Date.now();
  const evicted = evictRetained(now, 900_000, 1);
  assert.deepEqual(evicted, [b.runId]);
  assert.ok(snapshotRuns().some((r) => r.runId === a.runId)); // active never evicted
  assert.ok(!snapshotRuns().some((r) => r.runId === b.runId));
  assert.ok(snapshotRuns().some((r) => r.runId === c.runId));

  resetRegistry();
  const d = createRun(init({ taskLabel: "d" }));
  finishRun(d.runId, { state: "done" });
  assert.equal(displayRuns().length, 1);
  dismissRun(d.runId);
  assert.equal(displayRuns().length, 0);
  assert.equal(snapshotRuns().length, 1); // durable record still present
});

test("snapshot API returns isolated copies (immutability)", () => {
  resetRegistry();
  const snap = createRun(init());
  pushActivity(snap.runId, "progress", "x");
  const copy = getRun(snap.runId)!;
  copy.activity.push({ timestamp: "t", kind: "fake", detail: "y" });
  copy.state = "failed";
  const fresh = getRun(snap.runId)!;
  assert.equal(fresh.state, "queued");
  assert.equal(fresh.activity.length, 1);
});

function finish(runId: string, info: Parameters<typeof finishRun>[1]) {
  finishRun(runId, info);
}
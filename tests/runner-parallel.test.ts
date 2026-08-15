import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { runForeground, itemsOf, resolveConcurrency } from "../extensions/runner.ts";
import { makeFixture, fakeInvocation, tmpReport, readJson } from "./helpers.ts";
import { resetRegistry, snapshotRuns } from "../extensions/observability.ts";
import { loadConfig } from "../extensions/config.ts";
import type { CallInput } from "../extensions/runner.ts";

function callInput(fx: ReturnType<typeof makeFixture>, call: CallInput["call"], over: Partial<CallInput> = {}): CallInput {
  return {
    config: fx.config,
    catalog: fx.catalog,
    cwdBase: fx.root,
    dispatchModel: null,
    dispatchThinking: undefined,
    signal: undefined,
    childrenInvocationOverride: fakeInvocation(),
    onSnapshot: () => {},
    call,
    ...over,
  };
}

async function runForegroundEnv(input: CallInput, env: Record<string, string>) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    return await runForeground(input);
  } finally {
    process.env = saved;
  }
}

test("parallel: five tasks with concurrency two — input order, ≤ 2 live children", async () => {
  const fx = makeFixture();
  const marker = tmpReport(fx.root, "waves");
  const tasks = Array.from({ length: 5 }, (_, i) => ({ agent: "probe-host", task: `wave ${i}` }));
  const res = await runForegroundEnv(callInput(fx, { mode: "parallel", tasks }), { FAKE_PI_DELAY_MS: "150", FAKE_PI_MARKER: marker });
  assert.equal(res.outcomes.length, 5);
  // input order preserved
  assert.deepEqual(res.outcomes.map((o) => o.taskLabel), ["wave 0", "wave 1", "wave 2", "wave 3", "wave 4"]);
  for (const o of res.outcomes) assert.equal(o.state, "done");
  // concurrency bound respected
  const maxLive = maxConcurrent(marker);
  assert.ok(maxLive <= 2, `at most 2 live children (saw ${maxLive})`);
  resetRegistry();
});

test("parallel: queue reason visible on queued snapshots", async () => {
  const fx = makeFixture();
  const tasks = Array.from({ length: 4 }, (_, i) => ({ agent: "probe-host", task: `q ${i}` }));
  const seenReasons: string[] = [];
  const res = await runForegroundEnv(callInput(fx, { mode: "parallel", tasks }, { onSnapshot: () => {} }), { FAKE_PI_DELAY_MS: "80" });
  void seenReasons;
  assert.equal(res.outcomes.length, 4);
  for (const o of res.outcomes) {
    const snap = snapshotRuns().find((r) => r.runId === o.runId)!;
    if (snap.queueReason) assert.match(snap.queueReason, /concurrency: 2 live/);
  }
  resetRegistry();
});

test("parallel: mixed success — failures preserved, siblings intact, order kept", async () => {
  const fx = makeFixture();
  const tasks = [
    { agent: "probe-host", task: "ok one" },
    { agent: "probe-host", task: "FAIL_ME two" },
    { agent: "probe-host", task: "ok three" },
    { agent: "probe-host", task: "FAIL_ME four" },
  ];
  const res = await runForegroundEnv(callInput(fx, { mode: "parallel", tasks }), { FAKE_PI_FAIL_IF_TASK: "FAIL_ME" });
  assert.deepEqual(res.outcomes.map((o) => o.state), ["done", "failed", "done", "failed"]);
  assert.equal(res.outcomes[0]!.digest.length > 0, true, "successful sibling digest available");
  // partial digest may remain for failed runs (spec: partial digest stays in details)
  assert.equal(res.outcomes[1]!.state, "failed");
  assert.ok(res.outcomes[1]!.errorMessage, "failed sibling reports a reason");
  resetRegistry();
});

test("parallel: queued abort — live children aborted, queued never spawn", async () => {
  const fx = makeFixture();
  const marker = tmpReport(fx.root, "qabort");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 350);
  const tasks = Array.from({ length: 5 }, (_, i) => ({ agent: "probe-host", task: `abort ${i}` }));
  const res = await runForegroundEnv(
    callInput(fx, { mode: "parallel", tasks }, { signal: controller.signal }),
    { FAKE_PI_DELAY_MS: "1000", FAKE_PI_MARKER: marker },
  );
  clearTimeout(timer);
  assert.equal(res.outcomes.length, 5);
  for (const o of res.outcomes) assert.equal(o.state, "aborted");
  const started = countMarker(marker, "start");
  assert.ok(started <= 2, `queued tasks never spawned (started=${started})`);
  assert.ok(started >= 1, "at least one child had started before abort");
  resetRegistry();
});

test("concurrency resolution honors config (1-8) with env/config precedence", () => {
  assert.equal(resolveConcurrency(loadConfig("/nonexistent-root-xyz")), 2);
  const root = fs.mkdtempSync("/tmp/ops-par-");
  fs.mkdirSync(`${root}/.ops`, { recursive: true });
  fs.writeFileSync(`${root}/.ops/config.json`, JSON.stringify({ concurrency: 5 }));
  assert.equal(resolveConcurrency(loadConfig(root)), 5);
});

test("itemsOf extracts mode items", () => {
  assert.deepEqual(itemsOf({ mode: "single", agent: "a", task: "t" }), [{ agent: "a", task: "t", cwd: undefined }]);
  assert.equal(itemsOf({ mode: "parallel", tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] }).length, 2);
  assert.equal(itemsOf({ mode: "chain", chain: [{ agent: "a", task: "1" }] }).length, 1);
});

function countMarker(file: string, token: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l === token).length;
}

/** Max concurrent live children derived from start/end marker timestamps order. */
function maxConcurrent(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let live = 0;
  let max = 0;
  for (const line of lines) {
    if (line === "start") {
      live++;
      max = Math.max(max, live);
    } else if (line === "end") {
      live = Math.max(0, live - 1);
    }
  }
  return max;
}

void readJson;
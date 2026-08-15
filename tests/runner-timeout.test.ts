import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { makeFixture, fakeInvocation, execReq, tmpReport, readJson } from "./helpers.ts";
import type { TaskRunRequest } from "../extensions/runner.ts";

function timeoutReq(fx: ReturnType<typeof makeFixture>, effectiveSeconds: number, over: Partial<TaskRunRequest> = {}): TaskRunRequest {
  const entry = fx.catalog.entries.find((e) => e.name === "probe-host")!;
  return {
    task: { agent: "probe-host", task: "Slow check" },
    entry,
    inputIndex: 0,
    chainStep: null,
    mode: "single",
    cwdBase: fx.root,
    timeout: { requestedSeconds: effectiveSeconds, effectiveSeconds, clamped: false },
    dispatchModel: null,
    dispatchThinking: undefined,
    contractsPrompt: undefined,
    parentJobId: null,
    sessionKey: null,
    probePolicyPath: undefined,
    childrenInvocationOverride: fakeInvocation(),
    ...over,
  };
}

test("timeout: child closes within cooldown of SIGTERM -> timed_out, no SIGKILL", async () => {
  const fx = makeFixture();
  const marker = tmpReport(fx.root, "term-exit");
  const { outcome, snapshotsAfter } = await execReq(
    timeoutReq(fx, 1),
    { FAKE_PI_DELAY_MS: "2500", FAKE_PI_TERM_MODE: "exit", FAKE_PI_MARKER: marker },
  );
  assert.equal(outcome.state, "timed_out");
  const snap = snapshotsAfter.find((r) => r.runId === outcome.runId)!;
  const kinds = snap.activity.map((a) => `${a.kind}:${a.detail}`);
  assert.ok(kinds.some((k) => k.startsWith("termination:SIGTERM")), "SIGTERM recorded");
  assert.ok(!kinds.some((k) => k.startsWith("termination:SIGKILL")), "no SIGKILL when TERM sufficed");
  assert.ok(kinds.some((k) => k.startsWith("timeout:")), "deadline recorded");
});

test("timeout: child ignores SIGTERM -> SIGKILL after the cooldown; both escalations recorded", async () => {
  const fx = makeFixture();
  const marker = tmpReport(fx.root, "term-hold");
  const { outcome, snapshotsAfter } = await execReq(
    timeoutReq(fx, 1, { killCooldownMs: 150 }),
    { FAKE_PI_DELAY_MS: "2500", FAKE_PI_TERM_MODE: "hold", FAKE_PI_MARKER: marker },
  );
  assert.equal(outcome.state, "timed_out");
  const snap = snapshotsAfter.find((r) => r.runId === outcome.runId)!;
  const kinds = snap.activity.map((a) => a.detail);
  assert.ok(kinds.some((k) => k.startsWith("SIGTERM")), "SIGTERM recorded");
  assert.ok(kinds.some((k) => k.startsWith("SIGKILL")), "SIGKILL recorded after cooldown");
  assert.match(fs.readFileSync(marker, "utf8"), /SIGTERM/); // fake received the signal
});

test("parent abort: every live child enters the ladder; abort ends as aborted", async () => {
  const fx = makeFixture();
  const controller = new AbortController();
  const marker = tmpReport(fx.root, "abort");
  const timer = setTimeout(() => controller.abort(), 500);
  const { outcome, snapshotsAfter } = await execReq(
    timeoutReq(fx, 60, { killCooldownMs: 120 }),
    { FAKE_PI_DELAY_MS: "3000", FAKE_PI_TERM_MODE: "hold", FAKE_PI_MARKER: marker },
    controller.signal,
  );
  clearTimeout(timer);
  assert.equal(outcome.state, "aborted");
  const snap = snapshotsAfter.find((r) => r.runId === outcome.runId)!;
  const kinds = snap.activity.map((a) => a.detail);
  assert.ok(kinds.some((k) => k.startsWith("SIGTERM")), "abort escalates TERM");
  assert.ok(kinds.some((k) => k.startsWith("SIGKILL")), "abort escalates to KILL for a holding child");
  assert.ok(kinds.some((k) => k.startsWith("parent abort")), "abort reason recorded");
});

test("abort before spawn: queued work never spawns and ends aborted", async () => {
  const fx = makeFixture();
  const report = tmpReport(fx.root, "no-spawn");
  const controller = new AbortController();
  controller.abort();
  const { outcome } = await execReq(timeoutReq(fx, 60), { FAKE_PI_REPORT: report }, controller.signal);
  assert.equal(outcome.state, "aborted");
  assert.ok(!fs.existsSync(report), "no child process was created");
  void readJson;
});
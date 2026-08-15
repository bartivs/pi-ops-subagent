import { test } from "node:test";
import assert from "node:assert/strict";
import { createRun, resetRegistry, transition, pushActivity, addUsage, finishRun, getRun } from "../extensions/observability.ts";
import { renderFleetWidget, fleetCounts, FleetWidget } from "../extensions/fleet-widget.ts";

function makeRun(agent: string, state: "running" | "queued" | "failed" | "done", taskLabel = "check") {
  const run = createRun({ mode: "single", agent, agentSource: "bundled", manifestPath: `/a/${agent}.md`, taskLabel, cwd: "/repo", model: "fake/model", timeoutRequestedSeconds: 300, timeoutEffectiveSeconds: 300, timeoutClamped: false });
  if (state !== "queued") transition(run.runId, "starting");
  if (state === "running" || state === "failed" || state === "done") transition(run.runId, "running");
  if (state === "failed") finishRun(run.runId, { state: "failed", error: "bad" });
  if (state === "done") finishRun(run.runId, { state: "done" });
  return run.runId;
}

test("default widget is the exact three-line passive template", () => {
  resetRegistry();
  const id = makeRun("probe-host", "running", "host check");
  pushActivity(id, "tool_result", "read");
  addUsage(id, { turns: 2, cost: 0.5 });
  const lines = renderFleetWidget(undefined, 120);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "OPS  run=1 wait=0 err=0 kept=0 cost=$0.5000");
  assert.match(lines[1]!, /> \[RUN\]/);
  assert.match(lines[1]!, /probe-host/);
  assert.match(lines[2]!, /Alt\+O fleet \| stale=0 \| tools=1 \| turns=2/);
});

test("parallel widget shows aggregate counts and retained failures", async () => {
  resetRegistry();
  makeRun("a", "running");
  makeRun("b", "queued");
  makeRun("c", "failed");
  makeRun("d", "done");
  assert.deepEqual(fleetCounts((await import("../extensions/observability.ts")).displayRuns()), { running: 1, queued: 1, failed: 1, retained: 2 });
  const lines = renderFleetWidget(undefined, 80);
  assert.match(lines[0]!, /run=1 wait=1 err=1 kept=2/);
});

test("widget respects line budget and terminal width; it has no input handler", () => {
  resetRegistry();
  makeRun("probe-host", "running");
  const lines = renderFleetWidget(undefined, 25, { lines: 1 });
  assert.equal(lines.length, 1);
  assert.ok(lines.every((line) => line.length <= 25));
  const widget = new FleetWidget({ lines: 3 });
  assert.equal((widget as unknown as { handleInput?: unknown }).handleInput, undefined);
});

test("very narrow widget remains ASCII and bounded", () => {
  resetRegistry();
  makeRun("very-long-agent-name", "running");
  for (const line of renderFleetWidget(undefined, 10)) {
    assert.ok(line.length <= 10);
    assert.ok(!/[\u2500-\uFFFF]/.test(line));
  }
});
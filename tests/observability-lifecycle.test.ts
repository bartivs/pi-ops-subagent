import { test } from "node:test";
import assert from "node:assert/strict";
import { createRun, displayRuns, evictRetained, finishRun, formatFleetStatus, resetRegistry, snapshotRuns } from "../extensions/observability.ts";
import { renderFleetWidget } from "../extensions/fleet-widget.ts";

test("ops:status uses the same machine-readable lifecycle snapshots as the widget", () => {
  resetRegistry();
  const run = createRun({ mode: "single", agent: "probe-host", agentSource: "bundled", manifestPath: "/a.md", taskLabel: "host", cwd: "/repo", model: null, timeoutRequestedSeconds: 300, timeoutEffectiveSeconds: 300, timeoutClamped: false });
  finishRun(run.runId, { state: "failed", stopReason: "error", error: "child failed" });
  const status = formatFleetStatus(displayRuns());
  assert.match(status, /ops:status — active=0 retained=1/);
  assert.match(status, new RegExp(run.runId));
  assert.match(status, /probe-host \[failed\]/);
  assert.match(status, /result=-/);
  assert.match(renderFleetWidget(displayRuns(), 120)[0]!, /kept=1/);
});

test("zero retention duration removes completed display entries immediately without touching active runs", () => {
  resetRegistry();
  const done = createRun({ mode: "single", agent: "done", agentSource: "bundled", manifestPath: null, taskLabel: "done", cwd: "/", model: null, timeoutRequestedSeconds: null, timeoutEffectiveSeconds: null, timeoutClamped: false });
  finishRun(done.runId, { state: "done" });
  const active = createRun({ mode: "single", agent: "active", agentSource: "bundled", manifestPath: null, taskLabel: "active", cwd: "/", model: null, timeoutRequestedSeconds: null, timeoutEffectiveSeconds: null, timeoutClamped: false });
  assert.deepEqual(evictRetained(Date.now(), 0, 50), [done.runId]);
  assert.deepEqual(snapshotRuns().map((r) => r.runId), [active.runId]);
});

test("headless status rendering is plain text and does not require TUI APIs", () => {
  resetRegistry();
  assert.doesNotThrow(() => formatFleetStatus([]));
  assert.doesNotThrow(() => renderFleetWidget([], 80));
  assert.match(formatFleetStatus([]), /No active or retained runs/);
});
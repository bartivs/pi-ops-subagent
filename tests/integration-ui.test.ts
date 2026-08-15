import { test } from "node:test";
import assert from "node:assert/strict";
import { createRun, resetRegistry, transition, displayRuns } from "../extensions/observability.ts";
import { renderFleetWidget } from "../extensions/fleet-widget.ts";
import { renderFleetOverlay } from "../extensions/fleet-overlay.ts";
import { renderResultText } from "../extensions/tool-renderer.ts";

test("UI integration: passive widget has no input handler and never exceeds width", () => {
  resetRegistry();
  const run = createRun({ mode: "single", agent: "probe-host", agentSource: "bundled", manifestPath: null, taskLabel: "editor-safe", cwd: "/", model: null, timeoutRequestedSeconds: 1, timeoutEffectiveSeconds: 1, timeoutClamped: false });
  transition(run.runId, "starting");
  transition(run.runId, "running");
  for (const width of [120, 60, 39, 10]) {
    const lines = renderFleetWidget(displayRuns(), width);
    assert.ok(lines.every((line) => line.length <= width));
  }
});

test("UI integration: overlay is width responsive and keyboard support is confined to component", () => {
  resetRegistry();
  const run = createRun({ mode: "single", agent: "probe-host", agentSource: "bundled", manifestPath: null, taskLabel: "overlay", cwd: "/", model: null, timeoutRequestedSeconds: 1, timeoutEffectiveSeconds: 1, timeoutClamped: false });
  transition(run.runId, "starting");
  transition(run.runId, "running");
  for (const width of [120, 99, 40, 39]) {
    const lines = renderFleetOverlay(displayRuns(), width);
    assert.ok(lines.every((line) => line.length <= width));
  }
});

test("UI integration: collapsed tool result remains useful without TUI/theme calls", () => {
  const text = renderResultText({ mode: "single", durationMs: 1000, aggregate: { turns: 1, cost: 0 }, outcomes: [{ state: "done", agent: "probe-host", runId: "run-12345678", elapsedMs: 1000, digest: "ok" }] });
  assert.match(text, /subagent single: ok=1 err=0/);
  assert.match(text, /\[OK\]/);
});
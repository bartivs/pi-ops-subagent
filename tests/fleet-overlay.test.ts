import { test } from "node:test";
import assert from "node:assert/strict";
import { createRun, resetRegistry, transition, pushActivity, finishRun, displayRuns } from "../extensions/observability.ts";
import { renderFleetOverlay, FleetOverlayComponent } from "../extensions/fleet-overlay.ts";

function run(agent: string, state: "running" | "done" | "failed" = "running") {
  const r = createRun({ mode: "parallel", agent, agentSource: "bundled", manifestPath: `/a/${agent}.md`, taskLabel: "check", cwd: "/repo", model: "fake", timeoutRequestedSeconds: 30, timeoutEffectiveSeconds: 30, timeoutClamped: false });
  transition(r.runId, "starting");
  transition(r.runId, "running");
  pushActivity(r.runId, "phase", "running");
  if (state !== "running") finishRun(r.runId, { state, digest: `${agent} digest` });
  return r.runId;
}

test("wide overlay uses the normative ASCII frame and width 100", () => {
  resetRegistry();
  const id = run("probe-host");
  const lines = renderFleetOverlay(displayRuns(), 100);
  assert.equal(lines[0], "+ OPS FLEET ---------------------------------------------------------------------------------------+");
  assert.equal(lines[0]!.length, 100);
  assert.equal(lines.at(-1)!.length, 100);
  assert.match(lines.join("\n"), /RUN DETAIL/);
  assert.match(lines.join("\n"), /ACTIVITY/);
  assert.match(lines.join("\n"), /DIGEST/);
  assert.match(lines.join("\n"), /probe-host/);
  assert.ok(id);
  assert.ok(lines.every((line) => line.length <= 100));
});

test("narrow overlay switches to the exact compact sections", () => {
  resetRegistry();
  run("probe-host", "failed");
  const lines = renderFleetOverlay(displayRuns(), 60);
  assert.match(lines[0]!, /^OPS FLEET  run=0 wait=0 err=1/);
  assert.match(lines.join("\n"), /-- DETAIL/);
  assert.match(lines.join("\n"), /-- ACTIVITY --/);
  assert.match(lines.join("\n"), /-- DIGEST --/);
  assert.ok(lines.every((line) => line.length <= 60));
});

test("very narrow fallback is four bounded ASCII lines", () => {
  resetRegistry();
  run("probe-host");
  const lines = renderFleetOverlay(displayRuns(), 30);
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "Alt+O");
  assert.ok(lines.every((line) => line.length <= 30));
});

test("overlay input is focus-scoped and supports selection, detail, follow, dismiss, close", () => {
  resetRegistry();
  run("a", "done");
  run("b", "done");
  let closed = false;
  let renders = 0;
  const component = new FleetOverlayComponent(() => { closed = true; }, () => { renders++; });
  component.handleInput("down");
  component.handleInput("f");
  assert.equal(component.isFollowing(), true);
  component.handleInput("d");
  assert.equal(displayRuns().length, 1, "dismiss only removes selected display entry");
  component.handleInput("q");
  assert.equal(closed, true);
  assert.ok(renders >= 3);
});
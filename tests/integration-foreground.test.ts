import { test } from "node:test";
import assert from "node:assert/strict";
import { subagentExecute } from "../extensions/index.ts";
import { makeFixture, fakeInvocation } from "./helpers.ts";
import { resetRegistry, snapshotRuns } from "../extensions/observability.ts";

function env(fx: ReturnType<typeof makeFixture>, signal?: AbortSignal) {
  return { cwd: fx.root, mode: "json" as const, hasUI: false, isProjectTrusted: () => true, signal, bundledAgentsDir: fx.bundledDir, userAgentsDir: fx.userDir, childrenInvocationOverride: fakeInvocation() };
}

test("foreground integration: single includes digest, usage, provenance, and observability", async () => {
  const fx = makeFixture();
  const result = await subagentExecute({ agent: "probe-host", task: "single integration" }, env(fx));
  assert.match(result.content[0]!.text, /single: done/);
  const details = result.details as { outcomes: Array<{ state: string; usage: { turns: number }; agentSource: string }>; };
  assert.equal(details.outcomes[0]!.state, "done");
  assert.equal(details.outcomes[0]!.agentSource, "bundled");
  assert.ok(snapshotRuns().length >= 1);
  resetRegistry();
});

test("foreground integration: parallel preserves order and chain stops after failure", async () => {
  const fx = makeFixture();
  const parallel = await subagentExecute({ tasks: [{ agent: "probe-host", task: "one" }, { agent: "probe-host", task: "two" }] }, env(fx));
  assert.match(parallel.content[0]!.text, /parallel: ok=2 err=0/);
  resetRegistry();
  const saved = { ...process.env };
  process.env.FAKE_PI_FAIL_IF_TASK = "FAIL";
  try {
    const chain = await subagentExecute({ chain: [{ agent: "probe-host", task: "first" }, { agent: "probe-host", task: "FAIL second" }, { agent: "probe-host", task: "third" }] }, env(fx));
    const outcomes = (chain.details as { outcomes: Array<{ state: string }> }).outcomes;
    assert.deepEqual(outcomes.map((o) => o.state), ["done", "failed"]);
  } finally {
    process.env = saved;
    resetRegistry();
  }
});

test("foreground integration: abort is a structured terminal outcome and headless path uses no TUI", async () => {
  const fx = makeFixture();
  const controller = new AbortController();
  controller.abort();
  const result = await subagentExecute({ agent: "probe-host", task: "aborted" }, env(fx, controller.signal));
  const outcomes = (result.details as { outcomes: Array<{ state: string; stopReason: string }> }).outcomes;
  assert.equal(outcomes[0]!.state, "aborted");
  assert.equal(outcomes[0]!.stopReason, "aborted");
  resetRegistry();
});
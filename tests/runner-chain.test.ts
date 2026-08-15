import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { runForeground, type CallInput } from "../extensions/runner.ts";
import { makeFixture, fakeInvocation, tmpReport } from "./helpers.ts";
import { resetRegistry } from "../extensions/observability.ts";

function callInput(fx: ReturnType<typeof makeFixture>, call: CallInput["call"]): CallInput {
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
  };
}

async function runChainEnv(input: CallInput, env: Record<string, string>) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    return await runForeground(input);
  } finally {
    process.env = saved;
    resetRegistry();
  }
}

test("chain: {previous} substitution with the prior bounded digest", async () => {
  const fx = makeFixture();
  const marker = tmpReport(fx.root, "chain-subst");
  const res = await runChainEnv(
    callInput(fx, {
      mode: "chain",
      chain: [
        { agent: "probe-host", task: "step one" },
        { agent: "probe-host", task: "step two sees {previous}" },
      ],
    }),
    { FAKE_PI_DIGEST_FROM_TASK: "1", FAKE_PI_MARK_TASKS: "1", FAKE_PI_MARKER: marker },
  );
  assert.equal(res.outcomes.length, 2);
  assert.deepEqual(res.outcomes.map((o) => o.state), ["done", "done"]);
  const taskLines = readTaskLines(marker);
  assert.equal(taskLines.length, 2);
  const step1Task = taskLines[0]!;
  const step2Task = taskLines[1]!;
  assert.match(step1Task, /step one/);
  assert.match(step2Task, /step two sees /);
  assert.ok(step2Task.includes(step1Task.trim()), `step2 embeds step1 digest: ${step2Task}`);
});

test("chain: stops after the first non-done step; later steps never spawn", async () => {
  const fx = makeFixture();
  const marker = tmpReport(fx.root, "chain-stop");
  const res = await runChainEnv(
    callInput(fx, {
      mode: "chain",
      chain: [
        { agent: "probe-host", task: "ok step" },
        { agent: "probe-host", task: "FAIL_ME step" },
        { agent: "probe-host", task: "never runs" },
      ],
    }),
    { FAKE_PI_FAIL_IF_TASK: "FAIL_ME" },
  );
  assert.equal(res.outcomes.length, 2);
  assert.deepEqual(res.outcomes.map((o) => o.state), ["done", "failed"]);
  void marker;
});

function readTaskLines(marker: string): string[] {
  return fs
    .readFileSync(marker, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("task: "))
    .map((l) => JSON.parse(l.slice("task: ".length)) as string);
}

test("chain: bounded digest handoff caps what the next step receives", async () => {
  const fx = makeFixture();
  const marker = tmpReport(fx.root, "chain-bound");
  const huge = "z".repeat(60_000);
  const res = await runChainEnv(
    callInput(fx, {
      mode: "chain",
      chain: [
        { agent: "probe-host", task: "big output" },
        { agent: "probe-host", task: "sees {previous}" },
      ],
    }),
    { FAKE_PI_DIGEST: huge, FAKE_PI_MARK_TASKS: "1", FAKE_PI_MARKER: marker },
  );
  assert.equal(res.outcomes.length, 2);
  const taskLines = readTaskLines(marker);
  const step2 = taskLines[1]!;
  // the substituted digest is the BOUNDED one (with the truncation marker), not the full 60k
  assert.match(step2, /\[Output truncated:/);
  assert.ok(Buffer.byteLength(step2, "utf8") < 60_000);
});
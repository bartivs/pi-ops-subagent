import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { resetRegistry, snapshotRuns } from "../extensions/observability.ts";
import { runOneTask, truncateOutput, type RunOutcome, type TaskRunRequest } from "../extensions/runner.ts";
import { makeFixture, fakeInvocation, tmpReport, readJson, type FixtureEnv } from "./helpers.ts";

interface ChildReport {
  argv: string[];
  promptFile: string | null;
  promptMode: number | null;
  promptContent: string | null;
  cwd: string;
}

function baseReq(fx: FixtureEnv, agent = "probe-host"): TaskRunRequest {
  const entry = fx.catalog.entries.find((e) => e.name === agent)!;
  assert.ok(entry, `agent ${agent} present in fixture catalog`);
  return {
    task: { agent, task: "Check host" },
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
  };
}

/** Run one task with fixture env, returning outcome plus observed lifecycle. */
async function execSingle(
  fx: FixtureEnv,
  env: Record<string, string>,
  agent = "probe-host",
): Promise<ExecResult> {
  const lifecycle: string[] = [];
  const savedEnv = { ...process.env };
  let report: ChildReport | undefined;
  let snapshotsAfter: ReturnType<typeof snapshotRuns> = [];
  try {
    Object.assign(process.env, env);
    const out = await runOneTask({ ...baseReq(fx, agent) }, undefined, (runId) => {
      const snap = snapshotRuns().find((r) => r.runId === runId);
      if (snap) lifecycle.push(snap.state);
    });
    snapshotsAfter = snapshotRuns();
    if (env.FAKE_PI_REPORT) report = readJson<ChildReport>(env.FAKE_PI_REPORT);
    return { outcome: out, lifecycle, report, snapshotsAfter };
  } finally {
    process.env = savedEnv;
    resetRegistry();
  }
}

interface ExecResult {
  outcome: RunOutcome;
  lifecycle: string[];
  report?: ChildReport;
  snapshotsAfter: ReturnType<typeof snapshotRuns>;
}

test("single run fixture: digest, usage, turns, model, provenance, temp prompt cleanup", async () => {
  const fx = makeFixture();
  const report = tmpReport(fx.root, "single");
  const { outcome, lifecycle, report: childReport } = await execSingle(fx, {
    FAKE_PI_REPORT: report,
    FAKE_PI_TURNS: "2",
    FAKE_PI_DIGEST: "The disk is 80% full.",
    FAKE_PI_USAGE: JSON.stringify({ input: 10, output: 20, cacheRead: 1, cacheWrite: 2, total: 30, cost: 0.01 }),
    FAKE_PI_MODEL: "acme/fake-1",
    FAKE_PI_TOOL: "grep",
  });

  assert.equal(outcome.state, "done");
  assert.equal(outcome.stopReason, "end");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.digest, "The disk is 80% full.");
  assert.equal(outcome.fullDigest, "The disk is 80% full.");
  assert.equal(outcome.agent, "probe-host");
  assert.equal(outcome.agentSource, "bundled");
  assert.match(outcome.manifestPath!, /probe-host\.md$/);
  assert.equal(outcome.usage.turns, 2);
  assert.equal(outcome.usage.input, 20);
  assert.equal(outcome.usage.output, 40);
  assert.equal(outcome.usage.cacheRead, 2);
  assert.equal(outcome.usage.cacheWrite, 4);
  assert.equal(outcome.usage.cost, 0.02);
  assert.equal(outcome.model, "acme/fake-1");
  assert.equal(outcome.artifactPath, null);
  assert.deepEqual(lifecycle, ["starting", "running", "done"]);

  const cr = childReport!;
  assert.equal(cr.promptMode, 0o600);
  assert.match(cr.promptContent ?? "", /You are the probe-host agent/);
  assert.match(cr.promptContent ?? "", /Delegated task: Check host/);
  assert.ok(cr.promptFile && !fs.existsSync(cr.promptFile), "temp prompt removed after run");
  assert.ok(cr.argv.includes("--no-session"), "ephemeral child uses --no-session");
  assert.ok(cr.argv.includes("--mode") && cr.argv.includes("json"));
  const toolsIdx = cr.argv.indexOf("--tools");
  assert.equal(cr.argv[toolsIdx + 1], "read,grep,find,ls,probe_exec");
  const modelIdx = cr.argv.indexOf("--model");
  assert.equal(cr.argv[modelIdx + 1], "acme/parent-1"); // entry has no manifest model -> dispatch model
  assert.ok(cr.argv.some((a: string) => a.startsWith("Task: ")));
  assert.equal(cr.cwd, fx.root);
});

test("multi-turn usage sums; unknown + malformed events are bounded diagnostics", async () => {
  const fx = makeFixture();
  const { outcome, snapshotsAfter } = await execSingle(fx, {
    FAKE_PI_TURNS: "3",
    FAKE_PI_USAGE: JSON.stringify({ input: 5, output: 6 }),
    FAKE_PI_UNKNOWN: "1",
    FAKE_PI_MALFORMED: "1",
  });
  assert.equal(outcome.state, "done");
  assert.equal(outcome.usage.turns, 3);
  assert.equal(outcome.usage.input, 15);
  assert.equal(outcome.usage.output, 18);
  assert.ok(outcome.malformedLineCount >= 2, `malformed diagnostics recorded (${outcome.malformedLineCount})`);
  const snap = snapshotsAfter.find((r) => r.runId === outcome.runId)!;
  assert.ok(snap.activity.some((a) => a.kind === "unknown_event"));
});

test("length stop reason keeps digest; run is done", async () => {
  const fx = makeFixture();
  const { outcome } = await execSingle(fx, { FAKE_PI_STOP: "length" });
  assert.equal(outcome.state, "done");
  assert.equal(outcome.stopReason, "length");
});

test("nonzero exit -> failed with redacted error details", async () => {
  const fx = makeFixture();
  const { outcome } = await execSingle(fx, { FAKE_PI_EXIT: "3", FAKE_PI_ERROR: "boom" });
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.exitCode, 3);
  assert.match(outcome.errorMessage!, /boom/);
});

test("spawn failure -> failed outcome, never throws", async () => {
  const fx = makeFixture();
  const req: TaskRunRequest = { ...baseReq(fx), childrenInvocationOverride: { command: "/nonexistent/pi-xx" } };
  const out = await runOneTask(req, undefined, () => {});
  assert.equal(out.state, "failed");
  assert.ok(out.errorMessage);
});

test("truncateOutput: byte cap, line cap, UTF-8 safety, exact marker", () => {
  const big = "A".repeat(60_000);
  const r = truncateOutput(big, "details (run-x)");
  assert.ok(Buffer.byteLength(r.text, "utf8") <= 51_400);
  assert.match(r.text, /^A+/);
  assert.match(r.text, /\[Output truncated: \d+ bytes and \d+ lines omitted\. Full output: details \(run-x\)\.\]$/);

  const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
  const r2 = truncateOutput(lines.join("\n"), "details (run-y)");
  assert.equal(r2.text.split("\n").length, 2001);
  assert.match(r2.text, /lines omitted/);

  const unicode = "é".repeat(30_000); // 60,000 bytes
  const r3 = truncateOutput(unicode, "details (run-z)");
  assert.ok(Buffer.byteLength(r3.text, "utf8") <= 51_400);
  const head = r3.text.slice(0, r3.text.indexOf("[Output truncated"));
  assert.ok(Buffer.byteLength(head, "utf8") <= 51_200);
});
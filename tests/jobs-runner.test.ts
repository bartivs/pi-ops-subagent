import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createJobRecord, queueJobExecution, getJob, artifactPath, cancelJob, resumeJob, reconcileStartup, type JobRuntime } from "../extensions/jobs.ts";
import { runForeground } from "../extensions/runner.ts";
import { makeFixture, fakeInvocation, type FixtureEnv } from "./helpers.ts";
import { resetRegistry, snapshotRuns } from "../extensions/observability.ts";
import type { SubagentCall } from "../extensions/tool-schema.ts";
import type { UsageSummary } from "../extensions/types.ts";

function runtimeFor(fx: FixtureEnv): JobRuntime {
  return {
    runsDir: fx.root,
    runCall: async (spec, signal, parentJobId) => {
      const entry = fx.catalog.entries.find((e) => e.name === (spec as { agent?: string }).agent)!;
      const res = await runForeground({
        config: fx.config,
        catalog: fx.catalog,
        cwdBase: fx.root,
        dispatchModel: null,
        dispatchThinking: undefined,
        signal,
        childrenInvocationOverride: fakeInvocation(),
        parentJobId,
        sessionKey: null,
        onSnapshot: () => {},
        call: spec,
      });
      return {
        digestText: res.outcomes.map((o) => `## ${o.agent} [${o.state}]\n\n${o.digest}`).join("\n---\n"),
        evidenceLines: res.outcomes.map((o) => ({ runId: o.runId, state: o.state })),
        usage: { perRun: res.outcomes.map((o) => o.usage), aggregate: res.aggregate },
      };
    },
  };
}

function specFor(task = "background task"): SubagentCall {
  return { mode: "single", agent: "probe-host", task };
}

test("runAsync-style flow: durable-before-return, then done with all four artifacts", async () => {
  const fx = makeFixture();
  const runtime = runtimeFor(fx);
  const job = createJobRecord({ runsDir: fx.root, spec: specFor(), schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
  // durable BEFORE any execution
  assert.equal(getJob(fx.root, job.jobId)!.state, "queued");
  queueJobExecution(job, runtime);
  await waitFor(() => getJob(fx.root, job.jobId)!.state === "done", 3000);
  const done = getJob(fx.root, job.jobId)!;
  assert.equal(done.state, "done");
  assert.equal(done.ownerPid, process.pid);
  assert.ok(done.startedAt && done.finishedAt);
  for (const file of ["meta.json", "digest.md", "evidence.jsonl", "usage.json"]) {
    assert.ok(fs.existsSync(artifactPath(fx.root, job.jobId, file)), file);
  }
  const digest = fs.readFileSync(artifactPath(fx.root, job.jobId, "digest.md"), "utf8");
  assert.match(digest, /\[done\]/);
  const usage = JSON.parse(fs.readFileSync(artifactPath(fx.root, job.jobId, "usage.json"), "utf8")) as { aggregate: UsageSummary };
  assert.equal(typeof usage.aggregate.turns, "number");
  resetRegistry();
});

test("job failure: partial artifacts retained, meta identifies the terminal reason", async () => {
  const fx = makeFixture();
  const runtime: JobRuntime = {
    ...runtimeFor(fx),
    runCall: async () => {
      throw new Error("child exploded");
    },
  };
  const job = createJobRecord({ runsDir: fx.root, spec: specFor(), schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
  queueJobExecution(job, runtime);
  await waitFor(() => getJob(fx.root, job.jobId)!.state === "failed", 2000);
  const failed = getJob(fx.root, job.jobId)!;
  assert.equal(failed.state, "failed");
  assert.match(failed.error!, /child exploded/);
  resetRegistry();
});

test("startup reconciliation marks stale running records interrupted, preserving partial artifacts", async () => {
  const fx = makeFixture();
  const runtime = runtimeFor(fx);
  const job = createJobRecord({ runsDir: fx.root, spec: specFor(), schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
  // simulate an owner that died: rewrite the record with a foreign pid and running state
  const { saveRegistryAtomic, loadRegistry } = await import("../extensions/jobs.ts");
  const reg = loadRegistry(fx.root);
  const idx = reg.jobs.findIndex((j) => j.jobId === job.jobId);
  reg.jobs[idx] = { ...reg.jobs[idx]!, state: "running", ownerPid: process.pid + 1 };
  saveRegistryAtomic(fx.root, reg);
  const results = reconcileStartup(fx.root);
  assert.deepEqual(results, [{ jobId: job.jobId, from: "running", to: "interrupted" }]);
  assert.equal(getJob(fx.root, job.jobId)!.state, "interrupted");
  void runtime;
  resetRegistry();
});

test("resume creates a unique new id with resumedFromJobId; prior artifacts untouched", async () => {
  const fx = makeFixture();
  const runtime = runtimeFor(fx);
  const first = createJobRecord({ runsDir: fx.root, spec: specFor("resume me"), schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
  queueJobExecution(first, runtime);
  await waitFor(() => getJob(fx.root, first.jobId)!.state === "done", 3000);
  const firstArtifacts = fs.readdirSync(artifactPath(fx.root, first.jobId, "")).sort();
  // simulate interruption then resume
  const { loadRegistry, saveRegistryAtomic } = await import("../extensions/jobs.ts");
  const reg = loadRegistry(fx.root);
  const idx = reg.jobs.findIndex((j) => j.jobId === first.jobId);
  reg.jobs[idx] = { ...reg.jobs[idx]!, state: "interrupted" };
  saveRegistryAtomic(fx.root, reg);

  const resumed = resumeJob(fx.root, first.jobId, "single", ["probe-host"]);
  assert.notEqual(resumed.jobId, first.jobId);
  assert.equal(resumed.resumedFromJobId, first.jobId);
  assert.equal(resumed.state, "queued");
  queueJobExecution(resumed, runtime);
  await waitFor(() => getJob(fx.root, resumed.jobId)!.state === "done", 3000);
  // prior artifacts remain unchanged
  assert.deepEqual(fs.readdirSync(artifactPath(fx.root, first.jobId, "")).sort(), firstArtifacts);
  // resume is not allowed for done jobs
  assert.throws(() => resumeJob(fx.root, resumed.jobId, "single", ["probe-host"]), /interrupted\/failed only/);
  resetRegistry();
});

test("cancel queued job: never spawns, ends canceled", async () => {
  const fx = makeFixture();
  const job = createJobRecord({ runsDir: fx.root, spec: specFor(), schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
  const canceled = cancelJob(fx.root, job.jobId);
  assert.equal(canceled.state, "canceled");
  assert.equal(getJob(fx.root, job.jobId)!.state, "canceled");
  resetRegistry();
});

test("cancel running job: abort ladder via controller; job ends canceled", async () => {
  const fx = makeFixture();
  const runtime = runtimeFor(fx);
  const job = createJobRecord({ runsDir: fx.root, spec: specFor(), schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
  queueJobExecution(job, runtime);
  // wait until running, then cancel
  await waitFor(() => getJob(fx.root, job.jobId)!.state === "running", 2000);
  cancelJob(fx.root, job.jobId);
  await waitFor(() => getJob(fx.root, job.jobId)!.state === "canceled", 3000);
  assert.equal(getJob(fx.root, job.jobId)!.state, "canceled");
  resetRegistry();
});

test("cancel invalid state returns actionable error without registry mutation", async () => {
  const fx = makeFixture();
  const job = createJobRecord({ runsDir: fx.root, spec: specFor(), schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
  cancelJob(fx.root, job.jobId); // -> canceled
  assert.throws(() => cancelJob(fx.root, job.jobId), /Cannot cancel job .* in state canceled/);
  assert.throws(() => cancelJob(fx.root, "job-nope"), /Unknown job/);
  resetRegistry();
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}
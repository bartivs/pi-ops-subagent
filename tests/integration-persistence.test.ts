import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJobRecord, getJob, queueJobExecution, type JobRuntime } from "../extensions/jobs.ts";
import { resolveSession, loadMeta, metaPath, acquireLock } from "../extensions/sessions.ts";
import { makeFixture, fakeInvocation } from "./helpers.ts";
import { runForeground } from "../extensions/runner.ts";

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "ops-integration-persist-")); }
function spec() { return { mode: "single" as const, agent: "probe-host", task: "persist" }; }

test("persistence integration: durable job completes with registry and artifacts", async () => {
  const fx = makeFixture();
  const runtime: JobRuntime = {
    runsDir: fx.root,
    runCall: async (call, signal, parentJobId) => {
      const result = await runForeground({ config: fx.config, catalog: fx.catalog, cwdBase: fx.root, dispatchModel: null, dispatchThinking: undefined, signal, childrenInvocationOverride: fakeInvocation(), parentJobId, sessionKey: null, onSnapshot: () => {}, call });
      return { digestText: result.outcomes[0]?.digest ?? "", evidenceLines: result.outcomes.map((o) => ({ runId: o.runId, state: o.state })), usage: { perRun: result.outcomes.map((o) => o.usage), aggregate: result.aggregate } };
    },
  };
  const job = createJobRecord({ runsDir: fx.root, spec: spec(), schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
  queueJobExecution(job, runtime);
  await waitFor(() => getJob(fx.root, job.jobId)?.state === "done", 3000);
  assert.equal(getJob(fx.root, job.jobId)!.state, "done");
  assert.ok(fs.existsSync(path.join(fx.root, job.jobId, "digest.md")));
});

test("persistence integration: named session creates metadata and continues exact child path", () => {
  const dir = tmpdir();
  const options = { sessionsDir: dir, parentSessionId: "parent", effectiveCwd: "/repo", agent: "probe-host", handle: "persistent", restartExpired: undefined };
  const first = resolveSession(options);
  const child = path.join(dir, first.key, "pi", "child.jsonl");
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, "session");
  const meta = loadMeta(dir, first.key)!;
  meta.childSessionPath = child;
  fs.writeFileSync(metaPath(dir, first.key), JSON.stringify(meta));
  const continued = resolveSession(options);
  assert.equal(continued.continuePath, child);
  const lock = acquireLock(dir, first.key, { pid: process.pid, runId: "run-session" });
  assert.equal(lock.ok, true);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not complete");
}
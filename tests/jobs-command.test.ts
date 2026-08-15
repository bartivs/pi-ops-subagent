import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJobRecord, formatJobsReport, formatJobInspect, registryPath, parseRegistry } from "../extensions/jobs.ts";
import type { SubagentCall } from "../extensions/tool-schema.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-jobs-cmd-"));
}

const spec: SubagentCall = { mode: "parallel", tasks: [{ agent: "probe-host", task: "a" }, { agent: "probe-db", task: "b" }] };

test("empty registry report gives next-step guidance", () => {
  const dir = tmpdir();
  const report = formatJobsReport(dir);
  assert.match(report, /ops:jobs — no jobs/);
  assert.match(report, /runAsync: true/);
});

test("populated registry report shows ids, agents, states, times, schedule, artifacts", () => {
  const dir = tmpdir();
  const job = createJobRecord({
    runsDir: dir,
    spec,
    schedule: { kind: "interval", intervalSec: 21600 },
    resumedFromJobId: null,
    agentNames: ["probe-host", "probe-db"],
    mode: "parallel",
  });
  const report = formatJobsReport(dir);
  assert.match(report, /ops:jobs — durable registry/);
  assert.match(report, /# job-/);
  assert.match(report, /\[queued\]/);
  assert.match(report, /agents: probe-host, probe-db/);
  assert.match(report, /created: /);
  assert.match(report, /started: -/);
  assert.match(report, /schedule: interval 21600s/);
  assert.match(report, /next run: /);
  assert.match(report, /artifacts: -/);
  assert.ok(report.includes(job.jobId));
});

test("corrupt registry report fails closed with path and parse error", () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(dir), "{ nope");
  const report = formatJobsReport(dir);
  assert.match(report, /registry unavailable: /);
  assert.match(report, /parse error: /);
  assert.match(report, /corrupt file was preserved/);
  const { error } = parseRegistry(dir);
  assert.ok(error);
});

test("inspect prints the full job record; unknown id prints guidance", () => {
  const dir = tmpdir();
  const job = createJobRecord({ runsDir: dir, spec, schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "parallel" });
  const inspected = formatJobInspect(dir, job.jobId);
  const parsed = JSON.parse(inspected) as { jobId: string; state: string };
  assert.equal(parsed.jobId, job.jobId);
  assert.equal(parsed.state, "queued");
  const unknown = formatJobInspect(dir, "job-nope");
  assert.match(unknown, /unknown job "job-nope"/);
  assert.match(unknown, /Use \/ops:jobs list/);
});
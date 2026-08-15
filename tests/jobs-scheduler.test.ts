import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  scheduleIsValid,
  computeNextRunAt,
  createJobRecord,
  triggerDueJobs,
  getJob,
  loadRegistry,
  saveRegistryAtomic,
} from "../extensions/jobs.ts";
import type { SubagentCall } from "../extensions/tool-schema.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-jobs-sched-"));
}

const spec: SubagentCall = { mode: "single", agent: "probe-host", task: "scheduled" };
const modeFor = () => ({ mode: "single" as const, agentNames: ["probe-host"] });

test("schedule schema: exactly one of intervalSec >= 60 or at RFC3339 with timezone; no cron", () => {
  assert.equal(scheduleIsValid({ intervalSec: 3600 }), true);
  assert.equal(scheduleIsValid({ intervalSec: 60 }), true);
  assert.equal(scheduleIsValid({ intervalSec: 59 }), false);
  assert.equal(scheduleIsValid({ at: "2026-01-02T03:04:05Z" }), true);
  assert.equal(scheduleIsValid({ at: "2026-01-02T03:04:05+02:00" }), true);
  assert.equal(scheduleIsValid({ at: "2026-01-02 03:04:05" }), false, "space separator not RFC3339");
  assert.equal(scheduleIsValid({}), false);
  assert.equal(scheduleIsValid({ intervalSec: 60, at: "2026-01-02T03:04:05Z" }), false, "both keys rejected");
  assert.equal(scheduleIsValid({ cron: "*/5 * * * *" }), false, "cron rejected");
  assert.equal(scheduleIsValid({ intervalSec: "60" }), false);
});

test("createJobRecord persists nextRunAt for scheduled jobs; null for unscheduled", () => {
  const dir = tmpdir();
  const intervalJob = createJobRecord({
    runsDir: dir,
    spec,
    schedule: { kind: "interval", intervalSec: 21600 },
    resumedFromJobId: null,
    agentNames: ["probe-host"],
    mode: "single",
  });
  assert.ok(intervalJob.nextRunAt);
  const parsed = Date.parse(intervalJob.nextRunAt!);
  assert.ok(parsed > Date.now() && parsed <= Date.now() + 21600_000);

  const unscheduled = createJobRecord({ runsDir: dir, spec, schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
  assert.equal(unscheduled.nextRunAt, null);
});

test("overdue interval fires exactly one run and advances from the current time", () => {
  const dir = tmpdir();
  const base = createJobRecord({
    runsDir: dir,
    spec,
    schedule: { kind: "interval", intervalSec: 3600 },
    resumedFromJobId: null,
    agentNames: ["probe-host"],
    mode: "single",
  });
  // make it overdue
  const reg = loadRegistry(dir);
  const idx = reg.jobs.findIndex((j) => j.jobId === base.jobId);
  reg.jobs[idx] = { ...reg.jobs[idx]!, nextRunAt: new Date(Date.now() - 60_000).toISOString() };
  saveRegistryAtomic(dir, reg);

  const due = triggerDueJobs(dir, modeFor);
  assert.equal(due.length, 1, "exactly one overdue run queued");
  assert.notEqual(due[0]!.jobId, base.jobId);
  assert.equal(getJob(dir, due[0]!.jobId)!.state, "queued");
  // the parent schedule advanced from the current time (not the missed time)
  const parent = getJob(dir, base.jobId)!;
  const advanced = Date.parse(parent.nextRunAt!);
  assert.ok(advanced > Date.now(), `nextRunAt advanced from now (${advanced})`);
  assert.ok(advanced <= Date.now() + 3600_000);

  // a second trigger does not re-fire (not yet due)
  assert.equal(triggerDueJobs(dir, modeFor).length, 0);
});

test("overdue one-shot fires once then completes (nextRunAt null)", () => {
  const dir = tmpdir();
  const base = createJobRecord({
    runsDir: dir,
    spec,
    schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
    resumedFromJobId: null,
    agentNames: ["probe-host"],
    mode: "single",
  });
  const reg = loadRegistry(dir);
  const idx = reg.jobs.findIndex((j) => j.jobId === base.jobId);
  reg.jobs[idx] = { ...reg.jobs[idx]!, nextRunAt: new Date(Date.now() - 1000).toISOString() };
  saveRegistryAtomic(dir, reg);

  const due = triggerDueJobs(dir, modeFor);
  assert.equal(due.length, 1);
  const parent = getJob(dir, base.jobId)!;
  assert.equal(parent.nextRunAt, null, "one-shot schedule complete after firing");
  assert.equal(triggerDueJobs(dir, modeFor).length, 0);
});

test("future scheduled jobs do not trigger", () => {
  const dir = tmpdir();
  createJobRecord({
    runsDir: dir,
    spec,
    schedule: { kind: "once", at: new Date(Date.now() + 3600_000).toISOString() },
    resumedFromJobId: null,
    agentNames: ["probe-host"],
    mode: "single",
  });
  assert.equal(triggerDueJobs(dir, modeFor).length, 0);
});

test("computeNextRunAt honors interval and at", () => {
  const before = Date.now();
  const interval = computeNextRunAt({ kind: "interval", intervalSec: 60 });
  const after = Date.now();
  assert.ok(Date.parse(interval) >= before + 60_000 - 100 && Date.parse(interval) <= after + 60_000 + 100);
  const at = "2026-01-02T03:04:05Z";
  assert.equal(computeNextRunAt({ kind: "once", at }), at);
});

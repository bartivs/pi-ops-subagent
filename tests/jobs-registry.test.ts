import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createJobRecord,
  getJob,
  loadRegistry,
  parseRegistry,
  registryPath,
  saveRegistryAtomic,
  setJobState,
  writeJobArtifacts,
  artifactPath,
  assertJobArtifactsExist,
  newJobId,
  JobError,
  emptyRegistry,
} from "../extensions/jobs.ts";
import type { SubagentCall } from "../extensions/tool-schema.ts";
import { loadConfig } from "../extensions/config.ts";
import { resolveRunsDir } from "../extensions/config.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-jobs-"));
}

const spec: SubagentCall = { mode: "single", agent: "probe-host", task: "background check", timeoutSeconds: 60 };

function makeJob(runsDir: string) {
  return createJobRecord({ runsDir, spec, schedule: null, resumedFromJobId: null, agentNames: ["probe-host"], mode: "single" });
}

test("createJobRecord persists a queued job before returning the id", () => {
  const dir = tmpdir();
  const job = makeJob(dir);
  assert.match(job.jobId, /^job-[0-9a-f-]{36}$/);
  assert.equal(job.state, "queued");
  assert.equal(job.ownerPid, process.pid);
  // durable before return: the registry on disk already contains it
  const onDisk = getJob(dir, job.jobId);
  assert.ok(onDisk);
  assert.deepEqual(onDisk!.spec, spec as unknown as Record<string, unknown>);
});

test("registry version 1 with strict parser; unknown fields rejected on load", () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(dir), JSON.stringify({ version: 2, jobs: [] }));
  const { error } = parseRegistry(dir);
  assert.match(error!, /unsupported shape or version/);
  fs.writeFileSync(registryPath(dir), "not json");
  const { error: e2 } = parseRegistry(dir);
  assert.match(e2!, /not valid JSON/);
});

test("corrupt registry fails closed, file preserved, empty registry reported", () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(dir), "{corrupt");
  const { registry, error } = parseRegistry(dir);
  assert.deepEqual(registry, emptyRegistry());
  assert.ok(error);
  assert.equal(fs.readFileSync(registryPath(dir), "utf8"), "{corrupt", "corrupt file preserved");
});

test("state transitions persist; unknown ids throw actionable errors", () => {
  const dir = tmpdir();
  const job = makeJob(dir);
  setJobState(dir, job.jobId, "running");
  assert.equal(getJob(dir, job.jobId)!.state, "running");
  assert.ok(getJob(dir, job.jobId)!.startedAt);
  setJobState(dir, job.jobId, "done");
  assert.equal(getJob(dir, job.jobId)!.state, "done");
  assert.ok(getJob(dir, job.jobId)!.finishedAt);
  assert.throws(() => setJobState(dir, "job-nope", "running"), (e) => e instanceof JobError && /Unknown job/.test(e.message));
});

test("artifacts are mode 0600: meta/digest/evidence/usage + registry artifact path", () => {
  const dir = tmpdir();
  const job = makeJob(dir);
  const artifacts = {
    digestText: "# result\n\ndisk 90%",
    evidenceLines: [{ runId: "run-x", state: "done" }],
    usage: { perRun: [], aggregate: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0, cost: 0 } },
    meta: { jobId: job.jobId, spec: job.spec },
  };
  const artifactDir = writeJobArtifacts(dir, getJob(dir, job.jobId)!, artifacts);
  for (const file of ["meta.json", "digest.md", "evidence.jsonl", "usage.json"]) {
    const p = artifactPath(dir, job.jobId, file);
    assert.ok(fs.existsSync(p), file);
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, `${file} mode 0600`);
  }
  assert.equal(getJob(dir, job.jobId)!.artifactDir, artifactDir);
  assert.doesNotThrow(() => assertJobArtifactsExist(dir, job.jobId));
});

test("temp+fsync+rename writes leave no temp files behind", () => {
  const dir = tmpdir();
  makeJob(dir);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("custom runsDir via config resolution", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".ops"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ops", "config.json"), JSON.stringify({ runsDir: "custom-runs" }));
  const config = loadConfig(root);
  const runsDir = resolveRunsDir(config);
  assert.equal(runsDir, path.join(root, ".ops", "custom-runs"));
  const job = createJobRecord({ runsDir, spec, schedule: null, resumedFromJobId: null, agentNames: ["a"], mode: "single" });
  assert.ok(fs.existsSync(path.join(runsDir, "registry.json")));
  assert.ok(getJob(runsDir, job.jobId));
});

test("saveRegistryAtomic round-trips and preserves order", () => {
  const dir = tmpdir();
  const reg = { version: 1 as const, jobs: [] };
  saveRegistryAtomic(dir, reg);
  const a = makeJob(dir);
  const b = makeJob(dir);
  const loaded = loadRegistry(dir);
  assert.deepEqual(loaded.jobs.map((j) => j.jobId), [a.jobId, b.jobId]);
});

test("newJobId is unique", () => {
  const ids = new Set(Array.from({ length: 100 }, () => newJobId()));
  assert.equal(ids.size, 100);
});
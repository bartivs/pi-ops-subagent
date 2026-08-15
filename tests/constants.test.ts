import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_CEILING_SECONDS,
  KILL_COOLDOWN_MS,
  DEFAULT_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  OUTPUT_CAP_BYTES,
  OUTPUT_CAP_LINES,
  FLEET_STATES,
  JOB_STATES,
  FLEET_STATUS_TAGS,
  SESSION_EXPIRY_MS,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  SCHEDULER_TICK_MS,
  FLEET_RETENTION_MS,
  FLEET_RETENTION_COUNT,
  FLEET_STALE_AFTER_MS,
  TIMEOUT_FIELD,
  ENV_TIMEOUT_MS,
  ENV_TIMEOUT_CEILING_MS,
  ENV_CONCURRENCY,
  ENV_ALLOW_PROJECT_AGENTS,
  CONFIG_DEFAULTS,
  TERMINAL_FLEET_STATES,
} from "../extensions/constants.ts";

test("v1 defaults match the design table", () => {
  assert.equal(TIMEOUT_FIELD, "timeoutSeconds");
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 300);
  assert.equal(DEFAULT_CEILING_SECONDS, 900);
  assert.equal(KILL_COOLDOWN_MS, 5000);
  assert.equal(CONFIG_DEFAULTS.timeoutSeconds, 300);
  assert.equal(CONFIG_DEFAULTS.timeoutCeilingSeconds, 900);
});

test("v1 concurrency and output caps match the design table", () => {
  assert.equal(DEFAULT_CONCURRENCY, 2);
  assert.equal(MAX_PARALLEL_TASKS, 8);
  assert.equal(OUTPUT_CAP_BYTES, 51200);
  assert.equal(OUTPUT_CAP_LINES, 2000);
});

test("fleet state set is exact and terminal states are closed", () => {
  assert.deepEqual(FLEET_STATES, [
    "queued",
    "starting",
    "running",
    "finalizing",
    "done",
    "failed",
    "timed_out",
    "aborted",
  ]);
  assert.deepEqual([...TERMINAL_FLEET_STATES].sort(), ["aborted", "done", "failed", "timed_out"]);
  for (const s of FLEET_STATES) {
    assert.equal(typeof FLEET_STATUS_TAGS[s], "string");
  }
  assert.equal(FLEET_STATUS_TAGS.queued, "[WAIT]");
  assert.equal(FLEET_STATUS_TAGS.starting, "[START]");
  assert.equal(FLEET_STATUS_TAGS.running, "[RUN]");
  assert.equal(FLEET_STATUS_TAGS.finalizing, "[FINAL]");
  assert.equal(FLEET_STATUS_TAGS.done, "[OK]");
  assert.equal(FLEET_STATUS_TAGS.failed, "[ERR]");
  assert.equal(FLEET_STATUS_TAGS.timed_out, "[TIME]");
  assert.equal(FLEET_STATUS_TAGS.aborted, "[ABRT]");
});

test("job states are exact", () => {
  assert.deepEqual(JOB_STATES, [
    "queued",
    "running",
    "done",
    "failed",
    "interrupted",
    "canceled",
  ]);
});

test("retention/stale/session numbers match the design table", () => {
  assert.equal(FLEET_RETENTION_MS, 900_000);
  assert.equal(FLEET_RETENTION_COUNT, 50);
  assert.equal(FLEET_STALE_AFTER_MS, 30_000);
  assert.equal(SESSION_EXPIRY_MS, 604_800_000);
  assert.equal(LOCK_HEARTBEAT_MS, 5_000);
  assert.equal(LOCK_STALE_MS, 30_000);
  assert.equal(SCHEDULER_TICK_MS, 10_000);
});

test("env var names are public vocabulary", () => {
  assert.equal(ENV_TIMEOUT_MS, "PI_OPS_TIMEOUT_MS");
  assert.equal(ENV_TIMEOUT_CEILING_MS, "PI_OPS_TIMEOUT_CEILING_MS");
  assert.equal(ENV_CONCURRENCY, "PI_OPS_CONCURRENCY");
  assert.equal(ENV_ALLOW_PROJECT_AGENTS, "PI_OPS_ALLOW_PROJECT_AGENTS");
});
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireLock,
  refreshLock,
  releaseLock,
  readLock,
  utcArchiveStamp,
} from "../extensions/sessions.ts";
import { LOCK_HEARTBEAT_MS, LOCK_STALE_MS } from "../extensions/constants.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-sess-lock-"));
}
const key = "a".repeat(32);

test("lock constants match the spec (5s heartbeat / 30s stale)", () => {
  assert.equal(LOCK_HEARTBEAT_MS, 5000);
  assert.equal(LOCK_STALE_MS, 30000);
});

test("acquire creates an atomic lock; second acquisition refuses with owner info", () => {
  const dir = tmpdir();
  const first = acquireLock(dir, key, { pid: process.pid, runId: "run-1" }, Date.now());
  assert.equal(first.ok, true);
  const lock = readLock(dir, key)!;
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.runId, "run-1");
  assert.ok(lock.acquiredAt && lock.heartbeatAt);

  const second = acquireLock(dir, key, { pid: process.pid + 1, runId: "run-2" }, Date.now());
  assert.equal(second.ok, false);
  assert.match(second.reason!, /session busy/);
  assert.equal(second.owner!.pid, process.pid);
});

test("heartbeat refresh updates heartbeatAt (5s cadence)", () => {
  const dir = tmpdir();
  acquireLock(dir, key, { pid: process.pid, runId: "run-1" }, 1_000_000);
  const before = readLock(dir, key)!.heartbeatAt;
  refreshLock(dir, key, process.pid, 1_006_000);
  const after = readLock(dir, key)!.heartbeatAt;
  assert.notEqual(before, after);
  // refreshLock from a non-owner is a no-op
  refreshLock(dir, key, process.pid + 99, 2_000_000);
  assert.equal(readLock(dir, key)!.heartbeatAt, after);
});

test("release removes the lock only for the owner", () => {
  const dir = tmpdir();
  acquireLock(dir, key, { pid: process.pid, runId: "run-1" }, Date.now());
  releaseLock(dir, key, process.pid + 1); // wrong owner: no-op
  assert.ok(fs.existsSync(path.join(dir, key, "lock.json")));
  releaseLock(dir, key, process.pid);
  assert.ok(!fs.existsSync(path.join(dir, key, "lock.json")));
});

test("stale + dead pid lock is renamed lock.stale.<UTC stamp>.json and reclaimed", () => {
  const dir = tmpdir();
  // Acquire with an explicitly old heartbeat and a pid that is certainly dead.
  const old = Date.now();
  acquireLock(dir, key, { pid: 999_999, runId: "run-dead" }, old - LOCK_STALE_MS - 1);
  const reclaimed = acquireLock(dir, key, { pid: process.pid, runId: "run-new" }, old);
  assert.equal(reclaimed.ok, true);
  const dirFiles = fs.readdirSync(path.join(dir, key));
  const stale = dirFiles.find((f) => f.startsWith("lock.stale."));
  assert.ok(stale, "stale lock renamed");
  assert.match(stale!, /^lock\.stale\.\d{8}T\d{9}Z\.json$/);
  // archive suffix is UTC YYYYMMDDTHHMMSSmmmZ
  assert.match(utcArchiveStamp(), /^\d{8}T\d{9}Z$/);
  assert.equal(readLock(dir, key)!.pid, process.pid);
});

test("old-but-live owner refuses automatic reclaim", async () => {
  const dir = tmpdir();
  // spawn a real long-lived child as the lock owner
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  try {
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const old = Date.now();
    acquireLock(dir, key, { pid: child.pid!, runId: "run-live" }, old - LOCK_STALE_MS - 1);
    const attempt = acquireLock(dir, key, { pid: process.pid, runId: "run-2" }, old);
    assert.equal(attempt.ok, false);
    assert.match(attempt.reason!, /alive but heartbeat is stale|session busy/);
    assert.equal(attempt.owner!.pid, child.pid);
    // The lock remains in place; automatic reclaim did not remove it.
    assert.equal(readLock(dir, key)!.pid, child.pid);
  } finally {
    child.kill("SIGKILL");
  }
});

test("lock removal happens in finally (release path clears all state)", () => {
  const dir = tmpdir();
  acquireLock(dir, key, { pid: process.pid, runId: "run-1" }, Date.now());
  try {
    // simulate work
    refreshLock(dir, key, process.pid, Date.now());
  } finally {
    releaseLock(dir, key, process.pid);
  }
  assert.ok(!fs.existsSync(path.join(dir, key, "lock.json")), "lock removed in finally");
});

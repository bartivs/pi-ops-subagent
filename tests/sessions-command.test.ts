import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveSession,
  loadMeta,
  metaPath,
  formatSessionsReport,
  formatSessionInfo,
  listSessions,
  endSession,
  cleanupSessionFiles,
  SessionError,
} from "../extensions/sessions.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-sess-cmd-"));
}
const base = { parentSessionId: "parent", effectiveCwd: "/repo", agent: "probe-host", handle: "diag", restartExpired: undefined };

test("ops:session list report includes deterministic key/status and required fields", () => {
  const dir = tmpdir();
  const result = resolveSession({ ...base, sessionsDir: dir });
  const report = formatSessionsReport(dir);
  assert.match(report, /ops:session — named child sessions/);
  assert.match(report, new RegExp(`# ${result.key} \\[active\\]`));
  for (const field of ["handle: diag", "agent: probe-host", "cwd: /repo", "child: -", "last used:", "expires:"]) {
    assert.match(report, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("ops:session info formats the selected session summary", () => {
  const dir = tmpdir();
  resolveSession({ ...base, sessionsDir: dir });
  const summary = listSessions(dir)[0]!;
  const info = JSON.parse(formatSessionInfo(summary)) as Record<string, unknown>;
  assert.equal(info.handle, "diag");
  assert.equal(info.agent, "probe-host");
  assert.equal(info.canonicalCwd, "/repo");
  assert.equal(info.state, "active");
  assert.ok("lockOwnerPid" in info);
  assert.ok("lockAgeMs" in info);
});

test("end retains files and changes state; cleanup is explicit", () => {
  const dir = tmpdir();
  const result = resolveSession({ ...base, sessionsDir: dir });
  const child = path.join(dir, result.key, "pi", "child.jsonl");
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, "child");
  const meta = loadMeta(dir, result.key)!;
  meta.childSessionPath = child;
  fs.writeFileSync(metaPath(dir, result.key), JSON.stringify(meta));

  assert.equal(endSession(dir, result.key).state, "ended");
  assert.ok(fs.existsSync(child));
  assert.equal(listSessions(dir)[0]!.state, "ended");
  assert.ok(cleanupSessionFiles(dir, result.key).length > 0);
  assert.equal(listSessions(dir).length, 0);
});

test("cleanup refuses a live lock", async () => {
  const dir = tmpdir();
  const result = resolveSession({ ...base, sessionsDir: dir });
  const meta = loadMeta(dir, result.key)!;
  const child = path.join(dir, result.key, "pi", "child.jsonl");
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, "child");
  meta.childSessionPath = child;
  fs.writeFileSync(metaPath(dir, result.key), JSON.stringify(meta));
  const { acquireLock } = await import("../extensions/sessions.ts");
  acquireLock(dir, result.key, { pid: process.pid, runId: "run-live" });
  assert.throws(() => cleanupSessionFiles(dir, result.key), (e) => e instanceof SessionError && /live lock/.test(e.message));
});
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveSession,
  loadMeta,
  metaPath,
  listSessions,
  SessionError,
  deriveKey,
} from "../extensions/sessions.ts";
import { makeSessionResolver } from "../extensions/index.ts";
import { SESSION_EXPIRY_MS, MIN_SESSION_EXPIRY_MS } from "../extensions/constants.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-sess-life-"));
}
const base = {
  parentSessionId: "parent-1",
  effectiveCwd: "/work",
  agent: "probe-host",
  handle: "db",
  restartExpired: undefined,
};

test("default expiry is seven days and custom expiry is accepted at >= 60000ms", () => {
  assert.equal(SESSION_EXPIRY_MS, 604_800_000);
  assert.equal(MIN_SESSION_EXPIRY_MS, 60_000);
  const dir = tmpdir();
  const created = resolveSession({ ...base, sessionsDir: dir, sessionExpiryMs: 60_000 });
  const rows = listSessions(dir, Date.now(), 60_000);
  assert.ok(rows[0]!.expiresAt);
  assert.equal(Date.parse(rows[0]!.expiresAt!) - Date.parse(loadMeta(dir, created.key)!.lastUsedAt), 60_000);
});

test("expired touch without restartExpired fails before continuation", () => {
  const dir = tmpdir();
  const created = resolveSession({ ...base, sessionsDir: dir, sessionExpiryMs: 60_000 });
  const meta = loadMeta(dir, created.key)!;
  meta.lastUsedAt = new Date(Date.now() - 60_001).toISOString();
  // Add a path so expiry—not missing-child—is the decisive failure.
  meta.childSessionPath = path.join(dir, created.key, "pi", "child.jsonl");
  fs.mkdirSync(path.dirname(meta.childSessionPath), { recursive: true });
  fs.writeFileSync(meta.childSessionPath, "child");
  fs.writeFileSync(metaPath(dir, created.key), JSON.stringify(meta));

  assert.throws(
    () => resolveSession({ ...base, sessionsDir: dir, sessionExpiryMs: 60_000 }),
    (e) => e instanceof SessionError && e.category === "expired" && /restartExpired/.test(e.message),
  );
  assert.equal(loadMeta(dir, created.key)!.state, "active", "failed touch does not mutate active metadata");
});

test("restartExpired archives prior metadata and creates a fresh child setup", () => {
  const dir = tmpdir();
  const created = resolveSession({ ...base, sessionsDir: dir, sessionExpiryMs: 60_000 });
  const oldMeta = loadMeta(dir, created.key)!;
  oldMeta.lastUsedAt = new Date(Date.now() - 60_001).toISOString();
  oldMeta.childSessionPath = path.join(dir, created.key, "pi", "old-child.jsonl");
  fs.mkdirSync(path.dirname(oldMeta.childSessionPath), { recursive: true });
  fs.writeFileSync(oldMeta.childSessionPath, "old");
  fs.writeFileSync(metaPath(dir, created.key), JSON.stringify(oldMeta));

  const restarted = resolveSession({ ...base, sessionsDir: dir, sessionExpiryMs: 60_000, restartExpired: true });
  assert.equal(restarted.status, "created");
  assert.equal(restarted.firstUse!.dir, path.join(dir, created.key, "pi"));
  const fresh = loadMeta(dir, created.key)!;
  assert.equal(fresh.state, "active");
  assert.equal(fresh.childSessionPath, null);
  assert.equal(fresh.createdAt >= oldMeta.createdAt, true);
  const files = fs.readdirSync(path.join(dir, created.key));
  assert.ok(files.some((f) => /^meta\.expired\.\d{8}T\d{9}Z\.json$/.test(f)), files.join(", "));
});

test("expired entries are reported as expired without mutating metadata", () => {
  const dir = tmpdir();
  const created = resolveSession({ ...base, sessionsDir: dir, sessionExpiryMs: 60_000 });
  const meta = loadMeta(dir, created.key)!;
  meta.lastUsedAt = new Date(Date.now() - 60_001).toISOString();
  fs.writeFileSync(metaPath(dir, created.key), JSON.stringify(meta));
  assert.equal(listSessions(dir, Date.now(), 60_000)[0]!.state, "expired");
  assert.equal(loadMeta(dir, created.key)!.state, "active");
});

test("ephemeral parent is rejected before key directory or lock creation", async () => {
  const dir = tmpdir();
  const env = {
    cwd: dir,
    mode: "json" as const,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionPersisted: false,
    parentSessionId: null,
  };
  const resolver = makeSessionResolver(env);
  await assert.rejects(
    () => resolver({ mode: "single", agent: "probe-host", task: "x", session: "db" }, env),
    (e) => e instanceof SessionError && e.category === "parent" && /persisted/.test(e.message),
  );
  assert.deepEqual(fs.readdirSync(dir), [], "no session directory or lock created");
});
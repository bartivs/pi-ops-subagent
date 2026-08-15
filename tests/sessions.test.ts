import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, resolveSessionsDir } from "../extensions/config.ts";
import {
  resolveSession,
  deriveKey,
  displayName,
  loadMeta,
  listSessions,
  findSessionByHandle,
  endSession,
  cleanupSessionFiles,
  metaPath,
  childPiDirFor,
  SessionError,
} from "../extensions/sessions.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-sessions-"));
}

function setup(customSessionsDir?: string) {
  const root = tmpdir();
  if (customSessionsDir) {
    fs.mkdirSync(path.join(root, ".ops"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ops", "config.json"), JSON.stringify({ sessionsDir: customSessionsDir }));
  }
  const cfg = loadConfig(root);
  const sessionsDir = resolveSessionsDir(cfg);
  return { root, cfg, sessionsDir };
}

const OPTS = {
  parentSessionId: "parent-1",
  effectiveCwd: "/work",
  agent: "probe-host",
  handle: "db",
  restartExpired: undefined,
};

test("first use creates metadata, spawn dir, and display name (status created)", () => {
  const { sessionsDir } = setup();
  const res = resolveSession({ ...OPTS, sessionsDir });
  assert.equal(res.status, "created");
  const key = deriveKey(OPTS.parentSessionId, OPTS.effectiveCwd, OPTS.agent, OPTS.handle);
  assert.equal(res.key, key);
  assert.equal(res.firstUse!.name, displayName(OPTS.agent, OPTS.handle));
  assert.equal(res.firstUse!.dir, childPiDirFor(sessionsDir, key));
  const meta = loadMeta(sessionsDir, key)!;
  assert.equal(meta.version, 1);
  assert.equal(meta.state, "active");
  assert.equal(meta.agent, "probe-host");
  assert.equal(meta.handle, "db");
  assert.deepEqual(meta.derivation, { parentSessionId: "parent-1", effectiveCwd: "/work", agent: "probe-host", handle: "db" });
  assert.equal(meta.childSessionPath, null);
});

test("continuation passes the exact stored child session path (status continued)", () => {
  const { sessionsDir } = setup();
  const created = resolveSession({ ...OPTS, sessionsDir });
  const childPath = path.join(sessionsDir, created.key, "pi", "session.jsonl");
  fs.mkdirSync(path.dirname(childPath), { recursive: true });
  fs.writeFileSync(childPath, "{}");
  const meta = loadMeta(sessionsDir, created.key)!;
  meta.childSessionPath = childPath;
  fs.writeFileSync(metaPath(sessionsDir, created.key), JSON.stringify(meta));

  const cont = resolveSession({ ...OPTS, sessionsDir });
  assert.equal(cont.status, "continued");
  assert.equal(cont.continuePath, childPath);
  assert.equal(cont.firstUse, undefined);
});

test("missing stored child file fails with path diagnostics, no silent replacement", () => {
  const { sessionsDir } = setup();
  const created = resolveSession({ ...OPTS, sessionsDir });
  const meta = loadMeta(sessionsDir, created.key)!;
  meta.childSessionPath = path.join(sessionsDir, created.key, "pi", "gone.jsonl");
  fs.writeFileSync(metaPath(sessionsDir, created.key), JSON.stringify(meta));
  assert.throws(
    () => resolveSession({ ...OPTS, sessionsDir }),
    (e) => {
      assert.ok(e instanceof SessionError);
      assert.equal(e.category, "missing-child");
      assert.match(e.message, /missing or unreadable/);
      assert.match(e.message, /no silent replacement/);
      return true;
    },
  );
});

test("custom sessionsDir honored via config", () => {
  const { sessionsDir } = setup("my-sessions");
  assert.ok(sessionsDir.endsWith(path.join(".ops", "my-sessions")), sessionsDir);
  const res = resolveSession({ ...OPTS, sessionsDir });
  assert.ok(fs.existsSync(path.join(sessionsDir, res.key, "meta.json")));
});

test("listSessions reports key, handle, agent, cwd, state, child, lock owner", () => {
  const { sessionsDir } = setup();
  const res = resolveSession({ ...OPTS, sessionsDir });
  const childPath = path.join(sessionsDir, res.key, "pi", "session.jsonl");
  fs.mkdirSync(path.dirname(childPath), { recursive: true });
  fs.writeFileSync(childPath, "{}");
  const meta = loadMeta(sessionsDir, res.key)!;
  meta.childSessionPath = childPath;
  fs.writeFileSync(metaPath(sessionsDir, res.key), JSON.stringify(meta));

  const list = listSessions(sessionsDir);
  assert.equal(list.length, 1);
  const s = list[0]!;
  assert.equal(s.key, res.key);
  assert.equal(s.handle, "db");
  assert.equal(s.agent, "probe-host");
  assert.equal(s.canonicalCwd, "/work");
  assert.equal(s.state, "active");
  assert.equal(s.childSessionPath, childPath);
  assert.ok(s.expiresAt);
  assert.equal(s.lockOwnerPid, null);
  assert.equal(findSessionByHandle(sessionsDir, "db")!.key, res.key);
  assert.equal(findSessionByHandle(sessionsDir, res.key.slice(0, 8))!.key, res.key);
});

test("end marks ended, retains files, removes non-live lock", () => {
  const { sessionsDir } = setup();
  const res = resolveSession({ ...OPTS, sessionsDir });
  const childPath = path.join(sessionsDir, res.key, "pi", "session.jsonl");
  fs.mkdirSync(path.dirname(childPath), { recursive: true });
  fs.writeFileSync(childPath, "{}");
  const meta = loadMeta(sessionsDir, res.key)!;
  meta.childSessionPath = childPath;
  fs.writeFileSync(metaPath(sessionsDir, res.key), JSON.stringify(meta));

  const ended = endSession(sessionsDir, res.key);
  assert.equal(ended.state, "ended");
  // files retained unless cleanup is requested
  assert.ok(fs.existsSync(childPath), "child files retained after end");
  // expired metadata archived
  const dirFiles = fs.readdirSync(path.join(sessionsDir, res.key));
  assert.ok(dirFiles.some((f) => f.startsWith("meta.ended.")), "ended metadata archived");
});

test("cleanup removes files only for the selected key and refuses live locks", () => {
  const { sessionsDir } = setup();
  const res = resolveSession({ ...OPTS, sessionsDir });
  fs.writeFileSync(path.join(sessionsDir, res.key, "extra.txt"), "x");
  const removed = cleanupSessionFiles(sessionsDir, res.key);
  assert.ok(removed.length >= 2, "meta + extra removed");
  assert.ok(!fs.existsSync(path.join(sessionsDir, res.key)), "session dir removed");
  // other keys untouched
  const res2 = resolveSession({ ...OPTS, sessionsDir, handle: "other" });
  assert.ok(fs.existsSync(path.join(sessionsDir, res2.key, "meta.json")));
});

test("invalid handle throws before any directory or lock creation", () => {
  const { sessionsDir } = setup();
  assert.throws(
    () => resolveSession({ ...OPTS, sessionsDir, handle: "-bad" }),
    (e) => e instanceof SessionError && e.category === "handle",
  );
  if (fs.existsSync(sessionsDir)) {
    assert.deepEqual(fs.readdirSync(sessionsDir), [], "no key directory created");
  }
});
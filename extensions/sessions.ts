/**
 * Named child sessions (named-sessions spec, design D7).
 *
 * - Handle validation and deterministic key derivation: NUL-joined
 *   `ops/v1 \0 parentSessionId \0 effectiveCwd \0 agentName \0 handle`,
 *   SHA-256, first 32 lowercase hex chars. Display name `ops: <agent> · <handle>`.
 * - Versioned metadata at `<sessionsDir>/<key>/meta.json`; first use spawns
 *   with `--session-dir <sessionsDir>/<key>/pi --name <display>` and stores
 *   the created child path; continuation passes that exact `--session` path.
 * - Exclusive lock: atomic `lock.json`, 5,000 ms heartbeat, reclaim only when
 *   heartbeat is older than 30,000 ms AND the recorded pid is dead; stale
 *   locks are renamed `lock.stale.<YYYYMMDDTHHMMSSmmmZ>.json`. Removal in
 *   `finally`.
 * - Idle expiry (default 7 days); `restartExpired: true` required to restart;
 *   expired/ended metadata retained as `meta.expired.<ts>.json`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { SessionLock, SessionMeta, SessionSummary } from "./types.ts";
import {
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  SESSION_DERIVATION_PREFIX,
  SESSION_DISPLAY_PREFIX,
  SESSION_DISPLAY_SEPARATOR,
  SESSION_EXPIRY_MS,
  SESSION_LOCK_FILE,
  SESSION_META_FILE,
} from "./constants.ts";
import type { OpsConfig } from "./config.ts";
import { resolveSessionsDir } from "./config.ts";

export const HANDLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export class SessionError extends Error {
  constructor(message: string, public readonly category: "handle" | "lock" | "meta" | "expired" | "parent" | "missing-child") {
    super(message);
    this.name = "SessionError";
  }
}

export function validateHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

export interface SessionDerivationInput {
  parentSessionId: string;
  effectiveCwd: string;
  agent: string;
  handle: string;
}

function normalizeDerivation(
  inputOrParent: SessionDerivationInput | string,
  effectiveCwd?: string,
  agent?: string,
  handle?: string,
): SessionDerivationInput {
  if (typeof inputOrParent === "object") return inputOrParent;
  if (effectiveCwd === undefined || agent === undefined || handle === undefined) {
    throw new TypeError("deriveKey requires parentSessionId, effectiveCwd, agent, and handle");
  }
  return { parentSessionId: inputOrParent, effectiveCwd, agent, handle };
}

/** Full derivation input: NUL-joined UTF-8 strings in exact order. */
export function derivationInput(input: SessionDerivationInput): string;
export function derivationInput(parentSessionId: string, effectiveCwd: string, agent: string, handle: string): string;
export function derivationInput(inputOrParent: SessionDerivationInput | string, effectiveCwd?: string, agent?: string, handle?: string): string {
  const value = normalizeDerivation(inputOrParent, effectiveCwd, agent, handle);
  return [SESSION_DERIVATION_PREFIX, value.parentSessionId, value.effectiveCwd, value.agent, value.handle].join("\0");
}

/** Storage key: first 32 lowercase hex characters of SHA-256 over the input. */
export function deriveKey(input: SessionDerivationInput): string;
export function deriveKey(parentSessionId: string, effectiveCwd: string, agent: string, handle: string): string;
export function deriveKey(inputOrParent: SessionDerivationInput | string, effectiveCwd?: string, agent?: string, handle?: string): string {
  const value = normalizeDerivation(inputOrParent, effectiveCwd, agent, handle);
  const hash = createHash("sha256").update(derivationInput(value), "utf8").digest("hex");
  return hash.slice(0, 32);
}

export function displayName(agent: string, handle: string): string {
  return `${SESSION_DISPLAY_PREFIX}${agent}${SESSION_DISPLAY_SEPARATOR}${handle}`;
}

export function sessionDirFor(sessionsDir: string, key: string): string {
  return path.join(sessionsDir, key);
}

export function metaPath(sessionsDir: string, key: string): string {
  return path.join(sessionDirFor(sessionsDir, key), SESSION_META_FILE);
}

export function lockPath(sessionsDir: string, key: string): string {
  return path.join(sessionDirFor(sessionsDir, key), SESSION_LOCK_FILE);
}

export function childPiDirFor(sessionsDir: string, key: string): string {
  return path.join(sessionDirFor(sessionsDir, key), "pi");
}

/** Exact archive suffix: UTC `YYYYMMDDTHHMMSSmmmZ`. */
export function utcArchiveStamp(ms = Date.now()): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}Z`;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export function loadMeta(sessionsDir: string, key: string): SessionMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(sessionsDir, key), "utf8")) as SessionMeta;
    if (parsed.version !== 1 || typeof parsed.key !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveMetaAtomic(sessionsDir: string, key: string, meta: SessionMeta): void {
  const dir = sessionDirFor(sessionsDir, key);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.meta.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, metaPath(sessionsDir, key));
}

export function newMeta(sessionsDir: string, key: string, agent: string, handle: string, parentSessionId: string, effectiveCwd: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    version: 1,
    key,
    agent,
    handle,
    displayName: displayName(agent, handle),
    derivation: { parentSessionId, effectiveCwd, agent, handle },
    childSessionPath: null,
    state: "active",
    createdAt: now,
    lastUsedAt: now,
  };
}

/** Archive an expired/ended session: copy metadata to `meta.expired.<ts>.json`. */
export function archiveMeta(sessionsDir: string, key: string, meta: SessionMeta, suffix: "expired" | "ended"): string {
  const dir = sessionDirFor(sessionsDir, key);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, `meta.${suffix}.${utcArchiveStamp()}.json`);
  fs.writeFileSync(archive, JSON.stringify(meta, null, 2), { mode: 0o600 });
  return archive;
}

/** Capture the child pi session file created beneath the first-use directory. */
export function captureChildSessionPath(sessionsDir: string, key: string, firstUseDir: string, nowMs = Date.now()): string | null {
  const candidates: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.name.endsWith(".jsonl")) candidates.push(candidate);
    }
  };
  walk(firstUseDir);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const childSessionPath = candidates[0]!;
  const meta = loadMeta(sessionsDir, key);
  if (!meta) return null;
  meta.childSessionPath = childSessionPath;
  meta.lastUsedAt = new Date(nowMs).toISOString();
  saveMetaAtomic(sessionsDir, key, meta);
  return childSessionPath;
}

export function markSessionState(sessionsDir: string, key: string, state: SessionMeta["state"]): SessionMeta {
  const meta = loadMeta(sessionsDir, key);
  if (!meta) throw new SessionError(`No session metadata for key "${key}".`, "meta");
  meta.state = state;
  saveMetaAtomic(sessionsDir, key, meta);
  return meta;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

export interface LockResult {
  ok: boolean;
  reason?: string;
  owner?: SessionLock;
  lockAgeMs?: number;
}

export function readLock(sessionsDir: string, key: string): SessionLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath(sessionsDir, key), "utf8")) as SessionLock;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeLockAtomic(sessionsDir: string, key: string, lock: SessionLock): void {
  const dir = sessionDirFor(sessionsDir, key);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.lock.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, lockPath(sessionsDir, key));
}

/**
 * Acquire the exclusive lock atomically. Reclaim only when the heartbeat is
 * older than LOCK_STALE_MS AND the recorded pid is dead; stale locks are
 * renamed `lock.stale.<UTC archive stamp>.json`. Old-but-live owners are
 * refused (cleanup requires explicit user action).
 */
export function acquireLock(sessionsDir: string, key: string, owner: { pid: number; runId: string | null }, nowMs = Date.now()): LockResult {
  const file = lockPath(sessionsDir, key);
  const lock: SessionLock = {
    pid: owner.pid,
    runId: owner.runId,
    acquiredAt: new Date(nowMs).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
  };
  fs.mkdirSync(sessionDirFor(sessionsDir, key), { recursive: true });

  // O_EXCL (`wx`) is the acquisition primitive. Never use rename-overwrite
  // for the first write: that would allow a concurrent caller to clobber the
  // existing owner's lock.
  const tryCreate = (): boolean => {
    try {
      fs.writeFileSync(file, JSON.stringify(lock, null, 2), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (tryCreate()) return { ok: true };

  const existing = readLock(sessionsDir, key);
  if (!existing) return { ok: false, reason: "lock race: existing lock could not be read", lockAgeMs: 0 };
  const heartbeatAge = nowMs - Date.parse(existing.heartbeatAt);
  const staleByAge = heartbeatAge > LOCK_STALE_MS;
  const ownerDead = !isPidAlive(existing.pid);
  if (staleByAge && ownerDead) {
    const staleName = `lock.stale.${utcArchiveStamp(nowMs)}.json`;
    try {
      fs.renameSync(file, path.join(sessionDirFor(sessionsDir, key), staleName));
    } catch {
      return { ok: false, reason: "lock race: stale lock could not be renamed", owner: existing, lockAgeMs: heartbeatAge };
    }
    if (tryCreate()) return { ok: true };
    const winner = readLock(sessionsDir, key);
    return { ok: false, reason: "lock race: another caller reclaimed first", owner: winner ?? existing, lockAgeMs: heartbeatAge };
  }
  if (staleByAge) {
    return {
      ok: false,
      reason: `session lock owner (pid ${existing.pid}) is alive but heartbeat is stale; reclaim refused — use /ops:session end or cleanup`,
      owner: existing,
      lockAgeMs: heartbeatAge,
    };
  }
  return {
    ok: false,
    reason: `session busy: owned by run ${existing.runId ?? "(unknown)"}`,
    owner: existing,
    lockAgeMs: heartbeatAge,
  };
}

export function refreshLock(sessionsDir: string, key: string, pid: number, nowMs = Date.now()): void {
  const lock = readLock(sessionsDir, key);
  if (!lock) return;
  if (lock.pid !== pid) return; // lost ownership
  lock.heartbeatAt = new Date(nowMs).toISOString();
  writeLockAtomic(sessionsDir, key, lock);
}

export function releaseLock(sessionsDir: string, key: string, pid: number): void {
  const lock = readLock(sessionsDir, key);
  if (lock && lock.pid === pid) {
    try {
      fs.unlinkSync(lockPath(sessionsDir, key));
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution (used by the tool + tests)
// ---------------------------------------------------------------------------

export interface SessionResolutionResult {
  key: string;
  meta: SessionMeta;
  /** First use: spawn with --session-dir + --name. */
  firstUse?: { dir: string; name: string };
  /** Continuation: pass the exact stored child session path. */
  continuePath?: string;
  status: "created" | "continued";
}

export interface ResolveSessionOptions {
  sessionsDir: string;
  parentSessionId: string;
  effectiveCwd: string;
  agent: string;
  handle: string;
  restartExpired: boolean | undefined;
  sessionExpiryMs?: number;
  nowMs?: number;
}

/**
 * Resolve one named-session call to either first-use or continuation wiring.
 * Missing stored child files fail with path diagnostics (no silent replace).
 */
export function resolveSession(opts: ResolveSessionOptions): SessionResolutionResult {
  if (!validateHandle(opts.handle)) {
    throw new SessionError(
      `Invalid session handle "${opts.handle}". Handles match ${String(HANDLE_PATTERN)} (max 64 chars).`,
      "handle",
    );
  }
  const key = deriveKey(opts.parentSessionId, opts.effectiveCwd, opts.agent, opts.handle);
  const existing = loadMeta(opts.sessionsDir, key);
  const nowMs = opts.nowMs ?? Date.now();

  if (!existing || existing.state === "ended") {
    const meta = newMeta(opts.sessionsDir, key, opts.agent, opts.handle, opts.parentSessionId, opts.effectiveCwd);
    saveMetaAtomic(opts.sessionsDir, key, meta);
    return {
      key,
      meta,
      firstUse: { dir: childPiDirFor(opts.sessionsDir, key), name: displayName(opts.agent, opts.handle) },
      status: "created",
    };
  }

  const idleMs = nowMs - Date.parse(existing.lastUsedAt);
  if (idleMs > (opts.sessionExpiryMs ?? SESSION_EXPIRY_MS)) {
    if (!opts.restartExpired) {
      throw new SessionError(
        `Session "${opts.handle}" (${key}) expired after ${SESSION_EXPIRY_MS} ms idle. Pass restartExpired: true to create a fresh child session.`,
        "expired",
      );
    }
    archiveMeta(opts.sessionsDir, key, existing, "expired");
    existing.state = "expired";
    saveMetaAtomic(opts.sessionsDir, key, existing);
    const meta = newMeta(opts.sessionsDir, key, opts.agent, opts.handle, opts.parentSessionId, opts.effectiveCwd);
    saveMetaAtomic(opts.sessionsDir, key, meta);
    return {
      key,
      meta,
      firstUse: { dir: childPiDirFor(opts.sessionsDir, key), name: displayName(opts.agent, opts.handle) },
      status: "created",
    };
  }

  if (!existing.childSessionPath || !isReadableFile(existing.childSessionPath)) {
    throw new SessionError(
      `Stored child session for "${opts.handle}" is missing or unreadable: ${existing.childSessionPath ?? "(none)"}. Continuation requires the exact stored path; no silent replacement.`,
      "missing-child",
    );
  }
  existing.lastUsedAt = new Date(nowMs).toISOString();
  saveMetaAtomic(opts.sessionsDir, key, existing);
  return { key, meta: existing, continuePath: existing.childSessionPath, status: "continued" };
}

function isReadableFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inspection (list/info) and lifecycle (end/cleanup)
// ---------------------------------------------------------------------------

export function listSessions(sessionsDir: string, nowMs = Date.now(), sessionExpiryMs = SESSION_EXPIRY_MS): SessionSummary[] {
  const out: SessionSummary[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = loadMeta(sessionsDir, entry.name);
    if (!meta) continue;
    const lock = readLock(sessionsDir, entry.name);
    const idleMs = nowMs - Date.parse(meta.lastUsedAt);
    const state: SessionMeta["state"] = meta.state === "active" && idleMs > sessionExpiryMs ? "expired" : meta.state;
    out.push({
      key: meta.key,
      handle: meta.handle,
      agent: meta.agent,
      displayName: meta.displayName,
      canonicalCwd: meta.derivation.effectiveCwd,
      state,
      childSessionPath: meta.childSessionPath,
      lastUsedAt: meta.lastUsedAt,
      expiresAt: meta.state === "active" ? new Date(Date.parse(meta.lastUsedAt) + sessionExpiryMs).toISOString() : null,
      lockOwnerPid: lock?.pid ?? null,
      lockAgeMs: lock ? nowMs - Date.parse(lock.heartbeatAt) : null,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function findSessionByHandle(sessionsDir: string, handleOrKey: string): SessionSummary | null {
  const list = listSessions(sessionsDir);
  return list.find((s) => s.handle === handleOrKey || s.key.startsWith(handleOrKey)) ?? null;
}

export function endSession(sessionsDir: string, key: string): SessionSummary {
  const meta = loadMeta(sessionsDir, key);
  if (!meta) throw new SessionError(`No session "${key}".`, "meta");
  const lock = readLock(sessionsDir, key);
  if (lock && isPidAlive(lock.pid)) {
    throw new SessionError(
      `Session "${meta.handle}" has a live lock (pid ${lock.pid}); end it only after the child finishes or use cleanup with explicit selection.`,
      "lock",
    );
  }
  if (lock) {
    try {
      fs.unlinkSync(lockPath(sessionsDir, key));
    } catch {
      /* ignore */
    }
  }
  if (meta.state === "active") archiveMeta(sessionsDir, key, meta, "ended");
  markSessionState(sessionsDir, key, "ended");
  return listSessions(sessionsDir).find((s) => s.key === key)!;
}

export function cleanupSessionFiles(sessionsDir: string, key: string): string[] {
  const dir = sessionDirFor(sessionsDir, key);
  const removed: string[] = [];
  const lock = readLock(sessionsDir, key);
  if (lock && isPidAlive(lock.pid)) {
    throw new SessionError(`Refusing cleanup: session "${key}" has a live lock (pid ${lock.pid}).`, "lock");
  }
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          fs.unlinkSync(p);
          removed.push(p);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  try {
    fs.rmdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return removed;
}

// ---------------------------------------------------------------------------
// /ops:session report (pure formatter)
// ---------------------------------------------------------------------------

export function formatSessionsReport(sessionsDir: string, nowMs = Date.now(), sessionExpiryMs = SESSION_EXPIRY_MS): string {
  const list = listSessions(sessionsDir, nowMs, sessionExpiryMs);
  const lines: string[] = [];
  if (list.length === 0) {
    return "ops:session — no named sessions. Run the subagent tool with a session handle to create one.";
  }
  lines.push("ops:session — named child sessions");
  for (const s of list) {
    lines.push(`# ${s.key} [${s.state}]`);
    lines.push(`  handle: ${s.handle}`);
    lines.push(`  agent: ${s.agent}`);
    lines.push(`  cwd: ${s.canonicalCwd}`);
    lines.push(`  child: ${s.childSessionPath ?? "-"}`);
    lines.push(`  last used: ${s.lastUsedAt ?? "-"}`);
    lines.push(`  expires: ${s.expiresAt ?? "-"}`);
    if (s.lockOwnerPid !== null) lines.push(`  lock owner: pid ${s.lockOwnerPid}, age ${s.lockAgeMs} ms`);
  }
  return lines.join("\n");
}

export function formatSessionInfo(s: SessionSummary): string {
  return JSON.stringify(s, null, 2);
}
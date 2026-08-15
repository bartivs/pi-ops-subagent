import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateHandle,
  deriveKey,
  derivationInput,
  displayName,
  HANDLE_PATTERN,
} from "../extensions/sessions.ts";
import { createHash } from "node:crypto";

function sha256First32(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

test("derivation input is the exact NUL-joined order", () => {
  assert.equal(derivationInput("p1", "/work", "probe-host", "session-a"), "ops/v1\0p1\0/work\0probe-host\0session-a");
});

test("key is the first 32 lowercase hex chars of SHA-256 over the derivation", () => {
  const input = derivationInput("p1", "/work", "probe-host", "session-a");
  assert.equal(deriveKey("p1", "/work", "probe-host", "session-a"), sha256First32(input));
  assert.match(deriveKey("p1", "/work", "probe-host", "session-a"), /^[0-9a-f]{32}$/);
});

test("any dimension change yields a distinct key", () => {
  const base = deriveKey("parent-1", "/work", "probe-host", "session-a");
  const variants = [
    deriveKey("parent-2", "/work", "probe-host", "session-a"),
    deriveKey("parent-1", "/other", "probe-host", "session-a"),
    deriveKey("parent-1", "/work", "probe-db", "session-a"),
    deriveKey("parent-1", "/work", "probe-host", "session-b"),
  ];
  for (const v of variants) {
    assert.notEqual(v, base);
  }
  const same = deriveKey("parent-1", "/work", "probe-host", "session-a");
  assert.equal(same, base, "same inputs are deterministic");
});

test("handle validation accepts the pattern and rejects bad handles", () => {
  for (const ok of ["a", "session-1", "db.diag_2", "X9.y-z"]) {
    assert.equal(validateHandle(ok), true, ok);
  }
  for (const bad of ["", "-lead", ".lead", "has space", "bad#char", "x".repeat(65), "ümlaut"]) {
    assert.equal(validateHandle(bad), false, JSON.stringify(bad));
  }
  assert.equal(HANDLE_PATTERN.test("a"), true);
});

test("display name is ops: <agent> · <handle>", () => {
  assert.equal(displayName("probe-host", "session-a"), "ops: probe-host · session-a");
});
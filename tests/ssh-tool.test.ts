/**
 * Hermetic tests for the minimal `ssh` runtime tool (extensions/ssh-tool.ts).
 * All runs use an injected fake runner; nothing spawns a real ssh binary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeSsh, type SshExecResult, type SshInitParams } from "../extensions/ssh-tool.ts";

function trustedEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    hasUI: false,
    isProjectTrusted: () => true,
    run: async (p: SshInitParams, _timeoutMs: number): Promise<SshExecResult> => ({
      exitCode: 0,
      output: `service ls output for ${p.host}`,
      error: "",
      timedOut: false,
    }),
    ...overrides,
  };
}

test("executeSsh requires a trusted project", async () => {
  await assert.rejects(
    () => executeSsh({ host: "web1", command: "docker service ls" }, { ...trustedEnv(), isProjectTrusted: () => false }),
    /trusted project/,
  );
});

test("executeSsh rejects an empty command", async () => {
  await assert.rejects(
    () => executeSsh({ host: "web1", command: "   " }, trustedEnv()),
    /must not be empty/,
  );
});

test("executeSsh honors UI confirmation and cancels when declined", async () => {
  let asked = 0;
  await assert.rejects(
    () =>
      executeSsh(
        { host: "web1", command: "docker service ls" },
        trustedEnv({
          hasUI: true,
          uiConfirm: async () => {
            asked++;
            return false;
          },
        }),
      ),
    /cancelled/,
  );
  assert.equal(asked, 1);
});

test("executeSsh builds a shell-safe argv (no local interpolation)", async () => {
  const capture: { p?: SshInitParams } = {};
  await executeSsh(
    { host: "web1.example.com", user: "ops", port: 2222, identity: "/home/ops/.ssh/id_ed25519", command: "docker service ls; echo injected" },
    trustedEnv({
      run: async (p: SshInitParams) => {
        capture.p = p;
        return { exitCode: 0, output: "ok", error: "", timedOut: false };
      },
    }),
  );
  // The full command string travels as one opaque argument to ssh argv; the
  // injected runner receives it verbatim with no local shell ever involved.
  assert.equal(capture.p?.command, "docker service ls; echo injected");
  assert.equal(capture.p?.host, "web1.example.com");
  assert.equal(capture.p?.user, "ops");
  assert.equal(capture.p?.port, 2222);
  assert.equal(capture.p?.identity, "/home/ops/.ssh/id_ed25519");
});

test("executeSsh summarizes host + first output lines and bounds output", async () => {
  const r = await executeSsh(
    { host: "web1", command: "docker service ls" },
    trustedEnv({
      maxOutputBytes: 64,
      run: async () => ({ exitCode: 0, output: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10", error: "", timedOut: false }),
    }),
  );
  assert.ok(r.summary.startsWith("web1: line1"));
  assert.ok(r.output.length <= 64);
});

test("executeSsh reports nonzero exit and timeout notes", async () => {
  const failed = await executeSsh(
    { host: "web1", command: "docker service ls" },
    trustedEnv({ run: async () => ({ exitCode: 2, output: "denied", error: "permission", timedOut: false }) }),
  );
  assert.match(failed.summary, /exit 2/);

  const timed = await executeSsh(
    { host: "web1", command: "docker service ls" },
    trustedEnv({ run: async () => ({ exitCode: 1, output: "", error: "killed", timedOut: true }) }),
  );
  assert.match(timed.summary, /timed out/);
});

test("executeSsh redacts sensitive material from output", async () => {
  const r = await executeSsh(
    { host: "web1", command: "cat /etc/app.conf" },
    trustedEnv({
      run: async () => ({ exitCode: 0, output: "Authorization: Bearer secret-token-123\nok", error: "", timedOut: false }),
    }),
  );
  assert.ok(!r.output.includes("secret-token-123"));
  assert.ok(r.output.length > 0);
});

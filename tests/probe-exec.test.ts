import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PROBE_PREAMBLE,
  PROBE_TOOL_ALLOWLIST,
  PROBE_DENIED_TOOLS,
  writeProbePolicy,
  readProbePolicy,
  runProbeExec,
  validateProbeExecInput,
  readEvidence,
  normalizeIdentity,
  ProbeError,
  type ProbePolicy,
  type ProbeRunContext,
} from "../extensions/probe.ts";
import { effectiveChildTools } from "../extensions/runner.ts";
import { makeFixture, type FixtureEnv } from "./helpers.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-probe-"));
}

function policyFor(over: Partial<ProbePolicy> = {}): { dir: string; policy: ProbePolicy } {
  const dir = tmpdir();
  const policy: ProbePolicy = {
    version: 1,
    runId: "run-00000000-0000-4000-8000-000000000000",
    targetId: "prod",
    expectedIdentity: "prod-db-01",
    verifyProfile: "hostname",
    evidenceFile: path.join(dir, "evidence.jsonl"),
    failMarker: path.join(dir, "FAILED.json"),
    ...over,
  };
  return { dir, policy };
}

function ctxFor(policy: ProbePolicy | null): ProbeRunContext {
  return {
    policy,
    verifiedTargets: new Map(),
    cwd: "/",
    timeoutMs: 10_000,
    maxOutputBytes: 8192,
  };
}

test("probe preamble states read-only restrictions, target verification, no fabrication", () => {
  assert.match(PROBE_PREAMBLE, /read-only/);
  assert.match(PROBE_PREAMBLE, /bash/);
  assert.match(PROBE_PREAMBLE, /write/);
  assert.match(PROBE_PREAMBLE, /edit/);
  assert.match(PROBE_PREAMBLE, /verifyProfile|Verify the target/);
  assert.match(PROBE_PREAMBLE, /Never fall back to the local machine/);
  assert.match(PROBE_PREAMBLE, /not_evaluated|not collected/);
  assert.match(PROBE_PREAMBLE, /approvalRequired: true/);
});

test("probe tool narrowing: probe children exclude bash/write/edit; general agents unchanged", () => {
  const fx = makeFixture();
  const probe = fx.catalog.entries.find((e) => e.name === "probe-host")!;
  const general = fx.catalog.entries.find((e) => e.name === "general")!;
  const probeTools = effectiveChildTools(probe);
  assert.deepEqual(probeTools, ["read", "grep", "find", "ls", "probe_exec"]);
  for (const denied of PROBE_DENIED_TOOLS) {
    assert.ok(!probeTools.includes(denied), `${denied} excluded from probe children`);
  }
  for (const allowed of PROBE_TOOL_ALLOWLIST) {
    assert.ok(probeTools.includes(allowed), `${allowed} included`);
  }
  // general agents keep their manifest tools
  const generalTools = effectiveChildTools(general);
  assert.deepEqual(generalTools, ["read", "bash"]);
  assert.ok(generalTools.includes("bash"), "general agents unchanged");
});

test("probe policy file round-trip with mode 0600", () => {
  const { dir, policy } = policyFor();
  const file = writeProbePolicy(dir, policy);
  assert.deepEqual(readProbePolicy(file), policy);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(readProbePolicy(path.join(dir, "missing.json")), null);
});

test("approved diagnostic executes the fixed binary; evidence collected with ids", async () => {
  const { policy } = policyFor();
  // pre-verify so the gate passes for the non-verify profile
  const ctx = ctxFor(policy);
  ctx.verifiedTargets.set(policy.targetId!, true);
  const res = await runProbeExec({ profile: "hostname", args: ["-s"], target: "prod" }, ctx);
  const evidence = readEvidence(policy.evidenceFile);
  assert.equal(evidence.length, 1);
  assert.match(evidence[0]!.evidenceId, /^ev-[0-9a-f-]{36}$/);
  assert.equal(evidence[0]!.profile, "hostname");
  assert.equal(evidence[0]!.targetId, "prod");
  assert.equal(evidence[0]!.status, "collected");
  assert.equal(evidence[0]!.exitCode, 0);
  assert.ok(evidence[0]!.output.length > 0, "bounded observed output captured");
  assert.equal(res.evidence.evidenceId, evidence[0]!.evidenceId);
});

test("unknown profile rejected before spawn with registered list; policy_denied not recorded", async () => {
  const { policy } = policyFor();
  const ctx = ctxFor(policy);
  await assert.rejects(
    () => runProbeExec({ profile: "rm", args: ["-rf", "/"], target: "prod" }, ctx),
    (e: Error) => e instanceof ProbeError && /Unknown profile "rm"/.test(e.message) && /Registered profiles/.test(e.message),
  );
  assert.equal(readEvidence(policy.evidenceFile).length, 0, "no process was created");
});

test("shell/redirection/control bypass attempts rejected before spawn", async () => {
  const { policy } = policyFor();
  const ctx = ctxFor(policy);
  for (const [profile, args] of [
    ["hostname", ["-s; cat /etc/shadow"]],
    ["df", ["-h", "/var; rm -rf /"]],
    ["hostname", ["$(id)"]],
    ["hostname", ["`whoami`"]],
    ["proc-file", ["/proc/meminfo | head"]],
    ["ps", ["-ef", "> /tmp/x"]],
  ] as const) {
    await assert.rejects(
      () => runProbeExec({ profile, args: [...args], target: "prod" }, ctx),
      (e: Error) => e instanceof ProbeError && e.category === "policy",
      `${JSON.stringify(args)} rejected`,
    );
  }
  assert.equal(readEvidence(policy.evidenceFile).length, 0);
});

test("target mismatch on the request is rejected with policy evidence", async () => {
  const { policy } = policyFor();
  const ctx = ctxFor(policy);
  ctx.verifiedTargets.set("prod", true);
  await assert.rejects(
    () => runProbeExec({ profile: "hostname", args: ["-s"], target: "staging" }, ctx),
    (e: Error) => e instanceof ProbeError && /target mismatch/.test(e.message),
  );
});

test("verify-profile-first gate: other profiles denied until verification matches", async () => {
  const realHost = execSync("hostname -s", { encoding: "utf8" }).trim();
  const { policy } = policyFor({ expectedIdentity: realHost, verifyProfile: "hostname" });
  const ctx = ctxFor(policy);
  // diagnostic before verification -> denied with target guidance
  await assert.rejects(
    () => runProbeExec({ profile: "df", args: ["-h"], target: "prod" }, ctx),
    (e: Error) => e instanceof ProbeError && /target not verified/.test(e.message) && /hostname/.test(e.message),
  );
  const deniedEvidence = readEvidence(policy.evidenceFile);
  assert.equal(deniedEvidence.length, 1);
  assert.equal(deniedEvidence[0]!.status, "policy_denied");

  // verify with a matching hostname
  const ok = await runProbeExec({ profile: "hostname", args: ["-s"], target: "prod" }, ctx);
  assert.equal(ctx.verifiedTargets.get("prod"), true);
  assert.ok(ok.evidence.evidenceId);

  // now other profiles run
  const after = await runProbeExec({ profile: "uptime", args: ["-p"], target: "prod" }, ctx);
  assert.ok(after.evidence.evidenceId);
  assert.equal(ctx.verifiedTargets.get("prod"), true);
});

test("verification mismatch aborts with expected/observed and no local fallback", async () => {
  const realHost = execSync("hostname -s", { encoding: "utf8" }).trim();
  const impossible = realHost === "prod-db-01" ? "another-host" : "prod-db-01";
  const { dir, policy } = policyFor({ expectedIdentity: impossible, verifyProfile: "hostname" });
  // make the observed hostname differ from the expected identity
  const ctx = ctxFor(policy);
  await assert.rejects(
    () => runProbeExec({ profile: "hostname", args: ["-s"], target: "prod" }, ctx),
    (e: Error) => {
      assert.ok(e instanceof ProbeError);
      assert.match(e.message, /Target verification FAILED/);
      assert.match(e.message, /expected identity "prod-db-01"/);
      assert.match(e.message, /No local fallback/);
      return true;
    },
  );
  // fail marker written with non-secret identities
  const marker = JSON.parse(fs.readFileSync(path.join(dir, "FAILED.json"), "utf8"));
  assert.equal(marker.expected, "prod-db-01");
  assert.equal(typeof marker.observed, "string");
  // no further diagnostic can run
  await assert.rejects(
    () => runProbeExec({ profile: "uptime", args: ["-p"], target: "prod" }, ctx),
    /target not verified/,
  );
});

test("no contract: probe_exec unavailable with target-not-configured guidance", async () => {
  const fx = makeFixture();
  void fx;
  await assert.rejects(
    () => runProbeExec({ profile: "hostname", args: ["-s"], target: null }, ctxFor(null)),
    (e: Error) => e instanceof ProbeError && e.category === "contract" && /target not configured/.test(e.message),
  );
});

test("validateProbeExecInput enforces shape, args, profile registry, target", () => {
  const { policy } = policyFor();
  assert.throws(() => validateProbeExecInput("nope", policy), ProbeError);
  assert.throws(() => validateProbeExecInput({ profile: "nope", args: [] }, policy), ProbeError);
  assert.throws(() => validateProbeExecInput({ profile: "hostname", args: "x" }, policy), ProbeError);
  assert.throws(() => validateProbeExecInput({ profile: "hostname", args: ["-s;ls"] }, policy), ProbeError);
  const ok = validateProbeExecInput({ profile: "hostname", args: ["-s"], target: "prod" }, policy);
  assert.deepEqual(ok, { profile: "hostname", args: ["-s"], target: "prod" });
});

test("normalizeIdentity collapses whitespace and case for exact matching", () => {
  assert.equal(normalizeIdentity("  Prod-DB-01 \n"), "prod-db-01");
  assert.equal(normalizeIdentity("prod-db-01"), "prod-db-01");
});
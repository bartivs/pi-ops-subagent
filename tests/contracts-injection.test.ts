import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { subagentExecute, makeContractsResolver, type ToolEnv } from "../extensions/index.ts";
import { makeFixture, fakeInvocation, tmpReport, readJson, type FixtureEnv } from "./helpers.ts";
import { resetRegistry } from "../extensions/observability.ts";

function toolEnv(fx: FixtureEnv, over: Partial<ToolEnv> = {}): ToolEnv {
  return {
    cwd: fx.root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    signal: undefined,
    bundledAgentsDir: fx.bundledDir,
    userAgentsDir: fx.userDir,
    childrenInvocationOverride: fakeInvocation(),
    contracts: makeContractsResolver(),
    onUpdate: () => {},
    ...over,
  };
}

function writeContract(root: string, name: string, body: string, over: Record<string, string> = {}): void {
  fs.mkdirSync(path.join(root, ".ops", "contracts"), { recursive: true });
  const fm = { version: 1, name, targetId: "prod", expectedIdentity: "prod-db-01", verifyProfile: "hostname", connectionProfile: "prod-db-readonly", ...over };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "string" && /[:#]/.test(v) ? JSON.stringify(v) : v}`)
    .join("\n");
  fs.writeFileSync(path.join(root, ".ops", "contracts", `${name}.md`), `---\n${yaml}\n---\n\n${body}\n`);
}

async function exec(params: unknown, env: ToolEnv) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { FAKE_PI_DIGEST: "injected", FAKE_PI_REPORT: tmpReport(env.cwd, "inject") });
    const result = await subagentExecute(params, env);
    const report = readJson(path.join(env.cwd, "report-inject.json"));
    return { result, report };
  } finally {
    process.env = saved;
    resetRegistry();
  }
}

test("injection: ordered contract blocks then unchanged delegated_task; details record name/path/hash", async () => {
  const fx = makeFixture();
  writeContract(fx.root, "a", "notes A");
  writeContract(fx.root, "b", "notes B");
  const { result, report } = await exec(
    { agent: "probe-host", task: "Check the target disk.", contracts: ["a", "b"] },
    toolEnv(fx, { cwd: fx.root }),
  );
  const prompt = report.promptContent as string;
  const aIdx = prompt.indexOf('<ops_contract name="a">');
  const bIdx = prompt.indexOf('<ops_contract name="b">');
  const taskIdx = prompt.indexOf("<delegated_task>");
  assert.ok(aIdx !== -1 && bIdx !== -1 && taskIdx !== -1, "blocks present");
  assert.ok(aIdx < bIdx, "selection order preserved");
  assert.ok(bIdx < taskIdx, "delegated task follows all contract blocks");
  assert.match(prompt, /targetId: prod/);
  assert.match(prompt, /expectedIdentity: prod-db-01/);
  assert.match(prompt, /verifyProfile: hostname/);
  assert.match(prompt, /connectionProfile: prod-db-readonly/);
  assert.match(prompt, /notes A/);
  assert.match(prompt, /notes B/);
  assert.match(prompt, /Verify expectedIdentity with verifyProfile before diagnostics\. Never fall back to the local machine\./);
  // the original delegated task is not rewritten
  assert.match(prompt, /<delegated_task>Check the target disk\.<\/delegated_task>/);

  const details = result.details as { contracts?: Array<{ name: string; canonicalPath: string; contentHash: string }> };
  assert.equal(details.contracts?.length, 2);
  assert.deepEqual(details.contracts!.map((c) => c.name), ["a", "b"]);
  for (const c of details.contracts!) {
    assert.match(c.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(c.canonicalPath.endsWith(".md"));
  }
});

test("explicit call contracts override manifest/config defaults", async () => {
  const fx = makeFixture();
  writeContract(fx.root, "explicit", "explicit notes");
  writeContract(fx.root, "fallback", "fallback notes");
  const { report } = await exec(
    { agent: "probe-host", task: "t", contracts: ["explicit"] },
    toolEnv(fx),
  );
  const prompt = report.promptContent as string;
  assert.match(prompt, /<ops_contract name="explicit">/);
  assert.ok(!prompt.includes('<ops_contract name="fallback">'), "manifest/config defaults ignored");
});

test("no contract: child prompt uses the plain task line; details record no contracts", async () => {
  const fx = makeFixture();
  const { result, report } = await exec({ agent: "probe-host", task: "no contract task" }, toolEnv(fx));
  const prompt = report.promptContent as string;
  assert.ok(!prompt.includes("<ops_contract"), "no contract blocks");
  assert.ok(!prompt.includes("<delegated_task>"), "no delegated_task wrapper");
  assert.match(prompt, /Delegated task: no contract task/);
  const details = result.details as { contracts?: unknown[] };
  assert.equal(details.contracts, undefined);
});

test("conflicting multi-contract selection fails before spawn", async () => {
  const fx = makeFixture();
  writeContract(fx.root, "prod-a", "a", { targetId: "prod" });
  writeContract(fx.root, "stage-b", "b", { targetId: "staging" });
  await assert.rejects(
    () => exec({ agent: "probe-host", task: "t", contracts: ["prod-a", "stage-b"] }, toolEnv(fx)),
    (e: Error) => /Conflicting contracts/.test(e.message) && /targetId differs/.test(e.message),
  );
});
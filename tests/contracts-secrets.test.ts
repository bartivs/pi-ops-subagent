import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { subagentExecute, makeContractsResolver, type ToolEnv } from "../extensions/index.ts";
import { makeFixture, fakeInvocation, type FixtureEnv } from "./helpers.ts";
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

function writeContract(root: string, name: string, body = "Contract notes."): void {
  fs.mkdirSync(path.join(root, ".ops", "contracts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".ops", "contracts", `${name}.md`),
    `---\nversion: 1\nname: ${name}\ntargetId: prod\nexpectedIdentity: prod-db-01\nverifyProfile: hostname\nconnectionProfile: prod-db-readonly\n---\n\n${body}\n`,
  );
}

async function exec(params: unknown, env: ToolEnv) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { FAKE_PI_DIGEST: "contract run ok" });
    return await subagentExecute(params, env);
  } finally {
    process.env = saved;
    resetRegistry();
  }
}

test("secret literals in a contract are rejected before spawn with file/line/category", async () => {
  const fx = makeFixture();
  writeContract(fx.root, "leaky", "password: hunter2");
  await assert.rejects(
    () => exec({ agent: "probe-host", task: "check", contracts: ["leaky"] }, toolEnv(fx)),
    (e: Error) => {
      assert.match(e.message, /credential-like content/);
      assert.match(e.message, /leaky\.md:\d+:\d+ \[password-assignment\]/);
      return true;
    },
  );
});

test("private-key block, bearer token, and URI userinfo in contracts rejected", async () => {
  const fx = makeFixture();
  writeContract(fx.root, "pk", "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----");
  writeContract(fx.root, "bearer", "Authorization: Bearer abc.def");
  writeContract(fx.root, "uri", "postgres://admin:supersecret@db.example.com/prod");
  for (const name of ["pk", "bearer", "uri"]) {
    await assert.rejects(
      () => exec({ agent: "probe-host", task: "check", contracts: [name] }, toolEnv(fx)),
      (e: Error) => /credential-like content/.test(e.message) && e.message.includes(name),
      name,
    );
  }
});

test("allowed placeholders and profile identifiers do not trip secret scanning", async () => {
  const fx = makeFixture();
  writeContract(fx.root, "ok", "password: ${DB_PASSWORD}\ntoken: ${API_TOKEN}\nconnectionProfile: prod-db-readonly");
  const result = await exec({ agent: "probe-host", task: "check", contracts: ["ok"] }, toolEnv(fx));
  const details = result.details as { outcomes: Array<{ state: string }> };
  assert.equal(details.outcomes[0]!.state, "done");
});

test("literal secret never reaches prompts, observability, or artifacts", async () => {
  const fx = makeFixture();
  writeContract(fx.root, "leaky", "apiKey: sk-live-12345");
  try {
    await exec({ agent: "probe-host", task: "check", contracts: ["leaky"] }, toolEnv(fx));
    assert.fail("should have rejected the secret contract");
  } catch {
    // the child never spawned: no evidence file was created
    const runsDir = path.join(fx.root, ".ops", "runs");
    assert.ok(!fs.existsSync(runsDir), "no run artifacts created before spawn");
  }
});

test("unknown selected contract fails preflight before spawn", async () => {
  const fx = makeFixture();
  await assert.rejects(
    () => exec({ agent: "probe-host", task: "check", contracts: ["does-not-exist"] }, toolEnv(fx)),
    (e: Error) => /Unknown contract "does-not-exist"/.test(e.message) && /Available contracts:/.test(e.message),
  );
});
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { subagentExecute, type ToolEnv } from "../extensions/index.ts";
import { makeFixture, fakeInvocation, type FixtureEnv } from "./helpers.ts";
import { resetRegistry, snapshotRuns } from "../extensions/observability.ts";


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
    onUpdate: () => {},
    ...over,
  };
}

async function execTool(params: unknown, env: ToolEnv, extraEnv: Record<string, string> = {}) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { FAKE_PI_DIGEST: "tool digest result", ...extraEnv });
    const result = await subagentExecute(params, env);
    return result;
  } finally {
    process.env = saved;
    resetRegistry();
  }
}

test("single mode: returns bounded digest + structured details with full provenance", async () => {
  const fx = makeFixture();
  const result = await execTool({ agent: "probe-host", task: "Check host" }, toolEnv(fx));
  const text = result.content[0]!.text;
  assert.match(text, /single: done/);
  assert.match(text, /\[OK\] probe-host/);
  const details = result.details as { outcomes: Array<{ state: string; digest: string; agentSource: string; manifestPath: string }> };
  assert.equal(details.outcomes.length, 1);
  const o = details.outcomes[0]!;
  assert.equal(o.state, "done");
  assert.equal(o.digest, "tool digest result");
  assert.equal(o.agentSource, "bundled");
  assert.match(o.manifestPath!, /probe-host\.md$/);
});

test("parallel mode: structured outcomes in input order, mixed results preserved", async () => {
  const fx = makeFixture();
  const result = await execTool(
    { tasks: [{ agent: "probe-host", task: "ok" }, { agent: "probe-host", task: "FAIL_ME" }] },
    toolEnv(fx),
    { FAKE_PI_FAIL_IF_TASK: "FAIL_ME" },
  );
  const details = result.details as { outcomes: Array<{ state: string; agent: string }> };
  assert.deepEqual(details.outcomes.map((o) => o.state), ["done", "failed"]);
  assert.match(result.content[0]!.text, /parallel: ok=1 err=1/);
});

test("preflight: unknown agent throws before any child spawns", async () => {
  const fx = makeFixture();
  await assert.rejects(
    execTool({ agent: "does-not-exist", task: "x" }, toolEnv(fx)),
    (e: Error) => /Unknown agent/.test(e.message) && /Valid agents:/.test(e.message),
  );
  // no runs were created
  assert.equal(snapshotRuns().length, 0);
});

test("preflight: invalid mode shape throws before spawn", async () => {
  const fx = makeFixture();
  await assert.rejects(execTool({ agent: "probe-host", task: "t", tasks: [] }, toolEnv(fx)), /mutually exclusive/);
  await assert.rejects(execTool({}, toolEnv(fx)), /exactly one mode/);
});

test("chain mode: {previous} substitution and stop-after-first-failure through the tool", async () => {
  const fx = makeFixture();
  const result = await execTool(
    { chain: [{ agent: "probe-host", task: "first" }, { agent: "probe-host", task: "FAIL_ME second" }, { agent: "probe-host", task: "third" }] },
    toolEnv(fx),
    { FAKE_PI_FAIL_IF_TASK: "FAIL_ME" },
  );
  const details = result.details as { outcomes: Array<{ state: string }> };
  assert.deepEqual(details.outcomes.map((o) => o.state), ["done", "failed"]);
});

test("onUpdate streams complete snapshots while running", async () => {
  const fx = makeFixture();
  const updates: Array<{ state: string }> = [];
  const env = toolEnv(fx, {
    onUpdate: (partial) => {
      const runs = (partial.details as { runs?: Array<{ state: string }> })?.runs ?? [];
      if (runs.length > 0) updates.push(runs[runs.length - 1]!);
    },
  });
  await execTool({ agent: "probe-host", task: "stream" }, env);
  assert.ok(updates.length >= 2, `streamed updates observed (${updates.length})`);
});

test("headless fail-closed for unapproved project agents; env override permits", async () => {
  const fx = makeFixture();
  const projectAgents = path.join(fx.root, ".pi", "agents");
  fs.mkdirSync(projectAgents, { recursive: true });
  const file = path.join(projectAgents, "proj-agent.md");
  fs.writeFileSync(file, "---\nname: proj-agent\ndescription: project agent\n---\n\nbody");
  const trustFile = path.join(fx.root, "trust.json");

  // headless (json mode) without approval -> throws before spawn
  await assert.rejects(
    execTool({ agent: "proj-agent", task: "x" }, { ...toolEnv(fx), mode: "json", hasUI: false, trustFile }),
    (e: Error) => /not approved/.test(e.message) && /PI_OPS_ALLOW_PROJECT_AGENTS/.test(e.message),
  );

  // CI override allows it headless
  const saved = { ...process.env };
  process.env.PI_OPS_ALLOW_PROJECT_AGENTS = "1";
  try {
    const result = await execTool({ agent: "proj-agent", task: "x" }, { ...toolEnv(fx), mode: "json", hasUI: false, trustFile });
    const details = result.details as { outcomes: Array<{ state: string }> };
    assert.equal(details.outcomes[0]!.state, "done");
  } finally {
    process.env = saved;
    resetRegistry();
  }
});

test("interactive approval is remembered after confirm", async () => {
  const fx = makeFixture();
  const projectAgents = path.join(fx.root, ".pi", "agents");
  fs.mkdirSync(projectAgents, { recursive: true });
  const file = path.join(projectAgents, "proj-agent2.md");
  fs.writeFileSync(file, "---\nname: proj-agent2\ndescription: project agent 2\n---\n\nbody");
  const trustFile = path.join(fx.root, "trust.json");

  let confirmations = 0;
  const env = toolEnv(fx, {
    trustFile,
    uiConfirm: async () => {
      confirmations++;
      return true;
    },
  });
  await execTool({ agent: "proj-agent2", task: "x" }, env);
  assert.equal(confirmations, 1);

  // approval persisted; second call does not prompt
  const record = JSON.parse(fs.readFileSync(trustFile, "utf8"));
  assert.ok(record.approvals[fx.root].length >= 1);
  const env2 = toolEnv(fx, { trustFile, uiConfirm: async () => { confirmations++; return false; } });
  await execTool({ agent: "proj-agent2", task: "x" }, env2);
  assert.equal(confirmations, 1, "no re-prompt when already approved");
});

test("runAsync without the background-jobs wiring fails closed with guidance", async () => {
  const fx = makeFixture();
  await assert.rejects(
    execTool({ agent: "probe-host", task: "x", runAsync: true }, toolEnv(fx)),
    /runAsync requires the background-jobs registry/,
  );
});

test("named session first use captures child path and continuation reports created then continued", async () => {
  const fx = makeFixture();
  const { makeSessionResolver } = await import("../extensions/index.ts");
  const env = toolEnv(fx, {
    sessionPersisted: true,
    parentSessionId: "parent-session",
    sessionResolution: (call, e) => makeSessionResolver(e)(call, e),
  });
  const first = await execTool({ agent: "probe-host", task: "first", session: "diag" }, env);
  assert.equal(first.details.sessionStatus, "created");
  const { resolveSessionsDir } = await import("../extensions/config.ts");
  const { deriveKey, loadMeta } = await import("../extensions/sessions.ts");
  const sessionsDir = resolveSessionsDir(fx.config);
  const key = deriveKey("parent-session", fx.root, "probe-host", "diag");
  assert.equal(loadMeta(sessionsDir, key)!.childSessionPath?.endsWith("child-session.jsonl"), true);

  const second = await execTool({ agent: "probe-host", task: "continue", session: "diag" }, env);
  assert.equal(second.details.sessionStatus, "continued");
});

test("parallel duplicate named-session keys reject before spawning", async () => {
  const fx = makeFixture();
  const { makeSessionResolver } = await import("../extensions/index.ts");
  const env = toolEnv(fx, {
    sessionPersisted: true,
    parentSessionId: "parent-session",
    sessionResolution: (call, e) => makeSessionResolver(e)(call, e),
  });
  await assert.rejects(
    execTool({ tasks: [{ agent: "probe-host", task: "a" }, { agent: "probe-host", task: "b" }], session: "diag" }, env),
    /duplicate session keys/,
  );
  assert.equal(snapshotRuns().length, 0);
});

test("runAsync with the queue wiring returns a durable jobId immediately and completes in background", async () => {
  const fx = makeFixture();
  const { makeBackgroundQueue } = await import("../extensions/index.ts");
  const env = toolEnv(fx, {
    queueBackground: (call, e) => makeBackgroundQueue(e)(call),
  });
  const result = await execTool({ agent: "probe-host", task: "bg task", runAsync: true }, env);
  assert.match(result.content[0]!.text, /Queued background job job-/);
  const jobId = (result.details as { jobId: string }).jobId;
  assert.match(jobId, /^job-/);
  // durable before return
  const { getJob } = await import("../extensions/jobs.ts");
  const { resolveRunsDir } = await import("../extensions/config.ts");
  const runsDir = resolveRunsDir(fx.config);
  assert.ok(getJob(runsDir, jobId), "job durable in registry");
  // completes in the background
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const job = getJob(runsDir, jobId);
    if (job && job.state === "done") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(getJob(runsDir, jobId)!.state, "done");
});


import { test } from "node:test";
import assert from "node:assert/strict";
import { subagentParameters, checkSubagentInput } from "../extensions/tool-schema.ts";
import { Check } from "typebox/value";

function jsonSchema(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(subagentParameters)) as Record<string, unknown>;
}

test("schema text is self-describing: modes, units, bounds, dependencies", () => {
  const text = JSON.stringify(subagentParameters);
  assert.match(text, /exactly one/);
  assert.match(text, /single/);
  assert.match(text, /parallel/);
  assert.match(text, /chain/);
  assert.match(text, /timeoutSeconds/);
  assert.match(text, /"minimum":1/);
  assert.match(text, /seconds/);
  assert.match(text, /contracts/);
  assert.match(text, /"maxItems":4/);
  assert.match(text, /runAsync/);
  assert.match(text, /restartExpired/);
  assert.match(text, /schedule/);
  // mode arrays bounded at 8
  assert.match(text, /"maxItems":8/);
  const flat = JSON.stringify((subagentParameters as unknown as { anyOf?: unknown[] }).anyOf ?? []);
  assert.match(flat, /"tasks"?/);
});

test("schema has three mode members with additionalProperties: false", () => {
  const members = (subagentParameters as unknown as { anyOf?: unknown[] }).anyOf ?? [];
  assert.equal(members.length, 3);
  for (const m of members) {
    const asObj = m as { additionalProperties?: unknown };
    assert.equal(asObj.additionalProperties, false);
  }
});

test("single mode valid input passes", () => {
  const call = checkSubagentInput({ agent: "probe-host", task: "Check disk" });
  assert.equal(call.mode, "single");
  assert.equal(call.agent, "probe-host");
  assert.equal(call.task, "Check disk");
  assert.equal(call.cwd ?? null, null);
  const withCwd = checkSubagentInput({ agent: "a", task: "t", cwd: "/x", timeoutSeconds: 90, runAsync: true });
  assert.equal(withCwd.mode, "single");
  assert.equal(withCwd.cwd, "/x");
  assert.equal(withCwd.timeoutSeconds, 90);
});

test("parallel and chain modes validate; results in order", () => {
  const tasks = checkSubagentInput({ tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] });
  assert.equal(tasks.mode, "parallel");
  assert.equal(tasks.tasks!.length, 2);
  const chain = checkSubagentInput({ chain: [{ agent: "a", task: "1 {previous}" }] });
  assert.equal(chain.mode, "chain");
});

test("no mode / multiple modes rejected before spawn", () => {
  assert.throws(() => checkSubagentInput({}), /exactly one mode/);
  assert.throws(() => checkSubagentInput({}), /exactly one/);
  assert.throws(() => checkSubagentInput({ agent: "a", task: "t", tasks: [{ agent: "b", task: "u" }] }), /mutually exclusive/);
  assert.throws(() => checkSubagentInput({ tasks: [], chain: [] }), /mutually exclusive|at least one/);
});

test("empty arrays and > 8 items rejected", () => {
  assert.throws(() => checkSubagentInput({ tasks: [] }), /at least one/);
  assert.throws(() => checkSubagentInput({ chain: [] }), /at least one/);
  const nine = Array.from({ length: 9 }, (_, i) => ({ agent: `a${i}`, task: "t" }));
  assert.throws(() => checkSubagentInput({ tasks: nine }), /hard maximum of 8/);
  const nineChain = Array.from({ length: 9 }, (_, i) => ({ agent: `a${i}`, task: "t" }));
  assert.throws(() => checkSubagentInput({ chain: nineChain }), /hard maximum of 8/);
});

test("unknown modes and malformed members rejected", () => {
  assert.throws(() => checkSubagentInput({ tasks: "nope" }), /must be an array/);
  assert.throws(() => checkSubagentInput({ tasks: [{ agent: "" }] }), /\.agent must be a non-empty string/);
  assert.throws(() => checkSubagentInput({ tasks: [{ agent: "a" }] }), /\.task must be a non-empty string/);
});

test("dependent fields enforced: schedule needs runAsync; restartExpired needs session", () => {
  assert.throws(
    () => checkSubagentInput({ agent: "a", task: "t", schedule: { intervalSec: 60 } }),
    /schedule requires runAsync/,
  );
  assert.throws(
    () => checkSubagentInput({ agent: "a", task: "t", restartExpired: true }),
    /restartExpired requires session/,
  );
  const ok = checkSubagentInput({ agent: "a", task: "t", runAsync: true, schedule: { intervalSec: 3600 } });
  assert.deepEqual(ok.schedule, { intervalSec: 3600 });
  const ok2 = checkSubagentInput({ agent: "a", task: "t", session: "s1", restartExpired: true });
  assert.equal(ok2.restartExpired, true);
});

test("schedule validation: exactly one key, ranges, RFC3339, no cron", () => {
  assert.throws(
    () => checkSubagentInput({ agent: "a", task: "t", runAsync: true, schedule: { intervalSec: 59 } }),
    /intervalSec must be an integer >= 60/,
  );
  assert.throws(
    () => checkSubagentInput({ agent: "a", task: "t", runAsync: true, schedule: { intervalSec: 60, at: "2026-01-01T00:00:00Z" } }),
    /exactly one of "intervalSec" or "at"/,
  );
  assert.throws(
    () => checkSubagentInput({ agent: "a", task: "t", runAsync: true, schedule: { at: "not-a-date" } }),
    /RFC3339/,
  );
  const once = checkSubagentInput({ agent: "a", task: "t", runAsync: true, schedule: { at: "2026-01-02T03:04:05Z" } });
  assert.deepEqual(once.schedule, { at: "2026-01-02T03:04:05Z" });
});

test("timeoutSeconds must be an integer >= 1", () => {
  assert.throws(() => checkSubagentInput({ agent: "a", task: "t", timeoutSeconds: 0 }), />= 1/);
  assert.throws(() => checkSubagentInput({ agent: "a", task: "t", timeoutSeconds: 1.5 }), />= 1/);
  const ok = checkSubagentInput({ agent: "a", task: "t", timeoutSeconds: 30 });
  assert.equal(ok.timeoutSeconds, 30);
});

test("session handle pattern enforced", () => {
  assert.throws(() => checkSubagentInput({ agent: "a", task: "t", session: "-bad" }), /handle/);
  assert.throws(() => checkSubagentInput({ agent: "a", task: "t", session: "x".repeat(65) }), /handle/);
  const ok = checkSubagentInput({ agent: "a", task: "t", session: "ok-handle.1" });
  assert.equal(ok.session, "ok-handle.1");
});

test("contracts array bounded to 0-4 unique names", () => {
  assert.throws(() => checkSubagentInput({ agent: "a", task: "t", contracts: ["1", "2", "3", "4", "5"] }), /0-4/);
  assert.throws(() => checkSubagentInput({ agent: "a", task: "t", contracts: ["x", "x"] }), /unique/);
  const ok = checkSubagentInput({ agent: "a", task: "t", contracts: ["prod"] });
  assert.deepEqual(ok.contracts, ["prod"]);
});

test("typebox Value.Check consistent with the runtime checker for valid/invalid", () => {
  const valid = { agent: "a", task: "t" };
  assert.equal(Check(subagentParameters, valid), true);
  const invalid = { agent: "a", task: "t", tasks: [] };
  assert.equal(Check(subagentParameters, invalid), false);
});

test("generate the invalid/mixed/empty/>8 cases all throw (no partial run)", () => {
  const bad: unknown[] = [
    {},
    { agent: "a" },
    { task: "t" },
    { agent: "a", task: "t", tasks: [{ agent: "b", task: "u" }] },
    { tasks: [] },
    { chain: [] },
    { tasks: Array.from({ length: 9 }, () => ({ agent: "x", task: "y" })) },
    { agent: "a", task: "t", nonexistent: 1 },
  ];
  for (const b of bad) {
    assert.throws(() => checkSubagentInput(b), (e) => e instanceof Error, JSON.stringify(b));
  }
});
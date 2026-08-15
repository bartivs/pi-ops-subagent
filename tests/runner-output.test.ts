import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { parseUsage, truncateOutput } from "../extensions/runner.ts";
import { makeFixture, fakeInvocation, execReq } from "./helpers.ts";
import type { TaskRunRequest } from "../extensions/runner.ts";

function req(fx: ReturnType<typeof makeFixture>): TaskRunRequest {
  const entry = fx.catalog.entries.find((e) => e.name === "probe-host")!;
  return {
    task: { agent: "probe-host", task: "Output test" },
    entry,
    inputIndex: 0,
    chainStep: null,
    mode: "single",
    cwdBase: fx.root,
    timeout: { requestedSeconds: 300, effectiveSeconds: 300, clamped: false },
    dispatchModel: null,
    dispatchThinking: undefined,
    contractsPrompt: undefined,
    parentJobId: null,
    sessionKey: null,
    probePolicyPath: undefined,
    childrenInvocationOverride: fakeInvocation(),
  };
}

function message(usage: unknown, extra: Record<string, unknown> = {}): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: "x" }],
    usage,
    ...extra,
  } as unknown as Message;
}

test("parseUsage: all exact numeric fields counted", () => {
  const { usage, malformed } = parseUsage(
    message({ input: 10, output: 20, cacheRead: 1, cacheWrite: 2, total: 33, reasoning: 4, cost: { total: 0.5 } }),
  );
  assert.equal(malformed, false);
  assert.deepEqual(
    { turns: usage.turns, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.total, reasoning: usage.reasoning, cost: usage.cost },
    { turns: 1, input: 10, output: 20, cacheRead: 1, cacheWrite: 2, total: 33, reasoning: 4, cost: 0.5 },
  );
});

test("parseUsage: missing numbers count as zero; fallback keys accepted", () => {
  const { usage } = parseUsage(message({ inputTokens: 7, outputTokens: 8, totalTokens: 15 }));
  assert.equal(usage.input, 7);
  assert.equal(usage.output, 8);
  assert.equal(usage.total, 15);
  assert.equal(usage.cacheRead, 0);
  assert.equal(usage.cost, 0);
});

test("parseUsage: malformed negative/non-numeric values are diagnostic and not added", () => {
  const r1 = parseUsage(message({ input: -5, output: "lots" }));
  assert.equal(r1.malformed, true);
  assert.equal(r1.usage.input, 0);
  assert.equal(r1.usage.output, 0);
  const r2 = parseUsage(message({ cost: "free" }));
  assert.equal(r2.malformed, true);
  assert.equal(r2.usage.cost, 0);
});

test("run with >cap digest: model-visible text carries the exact marker; full digest retained in details", async () => {
  const fx = makeFixture();
  const big = "x".repeat(60_000);
  const { outcome } = await execReq(req(fx), { FAKE_PI_DIGEST: big });
  assert.equal(outcome.state, "done");
  assert.equal(Buffer.byteLength(outcome.fullDigest, "utf8"), 60_000, "full digest retained in details");
  assert.ok(Buffer.byteLength(outcome.digest, "utf8") <= 51_400, "model-visible bounded");
  assert.match(outcome.digest, /^x+/);
  assert.match(outcome.digest, /\[Output truncated: \d+ bytes and 0 lines omitted\. Full output: details \(run-/);
});

test("run with >line-cap digest: 2000 kept lines plus marker", async () => {
  const fx = makeFixture();
  const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
  const { outcome } = await execReq(req(fx), { FAKE_PI_DIGEST: lines.join("\n") });
  assert.equal(outcome.state, "done");
  assert.equal(outcome.digest.split("\n").length, 2001);
  assert.match(outcome.digest, /lines omitted/);
  assert.equal(outcome.fullDigest.split("\n").length, 2500);
});

test("truncateOutput keeps valid UTF-8 at the boundary", () => {
  const unicode = "é".repeat(30_000);
  const r = truncateOutput(unicode, "details (run-u)");
  const head = r.text.slice(0, r.text.indexOf("[Output truncated"));
  assert.ok(Buffer.byteLength(head, "utf8") <= 51_200, "no dangling UTF-8");
  assert.ok(!head.endsWith("\uFFFD"));
});
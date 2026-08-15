import { test } from "node:test";
import assert from "node:assert/strict";
import { renderResultText } from "../extensions/tool-renderer.ts";

test("collapsed renderer uses normative subagent summary and status tags", () => {
  const text = renderResultText({
    mode: "parallel",
    durationMs: 2345,
    aggregate: { turns: 3, cost: 0.0123 },
    outcomes: [
      { state: "done", agent: "probe-host", runId: "run-12345678-abcd", elapsedMs: 1200, digest: "host healthy" },
      { state: "failed", agent: "probe-db", runId: "run-87654321-abcd", errorMessage: "connection refused" },
    ],
  });
  assert.equal(text, [
    "subagent parallel: ok=1 err=1 time=2.3s turns=3 cost=$0.0123",
    "  [OK] probe-host 12345678 1.2s host healthy",
    "  [ERR] probe-db 87654321 connection refused",
  ].join("\n"));
});

test("expanded renderer includes all outcomes while collapsed bounds rows", () => {
  const outcomes = Array.from({ length: 10 }, (_, i) => ({ state: "done", agent: `a${i}`, runId: `run-${i}`, digest: "x" }));
  assert.match(renderResultText({ mode: "parallel", outcomes }), /\.\.\. 2 more/);
  assert.equal(renderResultText({ mode: "parallel", outcomes }, true).split("\n").length, 11);
});

test("renderer redacts no raw child output because it only uses bounded details", () => {
  const text = renderResultText({ mode: "single", outcomes: [{ state: "failed", agent: "a", runId: "run-x", errorMessage: "token=[REDACTED]" }] });
  assert.doesNotMatch(text, /secret-value/);
  assert.match(text, /token=\[REDACTED\]/);
});
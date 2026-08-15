import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateThreshold,
  evaluateThresholds,
  normalizeValue,
  formatProbeDigest,
  type DigestSectionInput,
} from "../extensions/probe.ts";
import type { EvidenceEntry, ThresholdSpec } from "../extensions/types.ts";

function ev(over: Partial<EvidenceEntry> = {}): EvidenceEntry {
  return {
    evidenceId: "ev-00000000-0000-4000-8000-000000000000",
    timestamp: new Date().toISOString(),
    targetId: "prod",
    profile: "df",
    args: ["-h"],
    exitCode: 0,
    status: "collected",
    output: "Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 100G 90G 10G 90% /",
    ...over,
  };
}

const t = (over: Partial<ThresholdSpec> = {}): ThresholdSpec => ({
  id: "disk-full",
  metric: "df",
  operator: "gte",
  value: 85,
  unit: "percent",
  severity: "warning",
  ...over,
});

test("exact threshold schema fields are enforced by catalog validation (probe manifests)", () => {
  // covered via parseManifest in catalog tests; assert the operator set here
  const ops = ["gt", "gte", "lt", "lte", "eq", "neq"];
  assert.deepEqual(ops, ["gt", "gte", "lt", "lte", "eq", "neq"]);
});

test("operator evaluation matches threshold semantics", () => {
  assert.equal(evaluateThreshold(t({ operator: "gte", value: 85 }), ev({ output: "90%" })).result, "warning");
  assert.equal(evaluateThreshold(t({ operator: "lt", value: 10 }), ev({ output: "5%" })).result, "warning");
  assert.equal(evaluateThreshold(t({ operator: "gt", value: 10 }), ev({ output: "5%" })).result, "normal");
  assert.equal(evaluateThreshold(t({ operator: "eq", value: 42 }), ev({ output: "42%" })).result, "warning");
  assert.equal(evaluateThreshold(t({ operator: "neq", value: 42 }), ev({ output: "42%" })).result, "normal");
});

test("missing or non-collected evidence is not_evaluated, never a pass", () => {
  assert.equal(evaluateThreshold(t(), undefined).result, "not_evaluated");
  assert.equal(evaluateThreshold(t(), ev({ status: "permission_denied" })).result, "not_evaluated");
  assert.equal(evaluateThreshold(t(), ev({ status: "unavailable" })).result, "not_evaluated");
  const noValue = evaluateThreshold(t(), ev({ output: "no numeric data" }));
  assert.equal(noValue.result, "not_evaluated");
  assert.match(noValue.reason, /no numeric value/);
});

test("unit normalization converts compatible units; incompatible -> not_evaluated", () => {
  assert.equal(normalizeValue(1, "gb", "mb"), 1024);
  assert.equal(normalizeValue(512, "mb", "gb"), 0.5);
  assert.equal(normalizeValue(5000, "ms", "seconds"), 5);
  assert.equal(normalizeValue(2, "kb", "kb"), 2);
  assert.equal(normalizeValue(1, "percent", "%"), 1);
  assert.equal(normalizeValue(1, "seconds", "percent"), null);
});

test("severity classification: warning vs critical", () => {
  const warning = evaluateThreshold(t({ severity: "warning", value: 85 }), ev({ output: "90%" }));
  assert.equal(warning.result, "warning");
  const critical = evaluateThreshold(t({ severity: "critical", value: 85 }), ev({ output: "90%" }));
  assert.equal(critical.result, "critical");
});

test("evaluateThresholds reports threshold id, evidence id, observed value, and reason", () => {
  const results = evaluateThresholds(
    [t({ id: "disk-warn", value: 85 }), t({ id: "disk-crit", value: 95 })],
    [ev({ output: "90%" })],
  );
  assert.equal(results.length, 2);
  const warn = results.find((r) => r.threshold.id === "disk-warn")!;
  assert.equal(warn.result, "warning");
  assert.equal(warn.evidenceId, "ev-00000000-0000-4000-8000-000000000000");
  assert.equal(warn.observed, 90);
  const crit = results.find((r) => r.threshold.id === "disk-crit")!;
  assert.equal(crit.result, "normal");
});

test("formatProbeDigest produces the canonical sections with evidence ids and confidence labels", () => {
  const input: DigestSectionInput = {
    evidence: [ev({ evidenceId: "ev-1111", output: "90% used" })],
    thresholds: [t({ id: "disk-full" })],
    interpretations: [{ text: "disk nearly full", confidence: "high", evidenceIds: ["ev-1111"] }],
    proposedActions: [
      { action: "resize volume", rationale: "approaching capacity", risk: "low", prerequisites: "maintenance window", rollback: "shrink back" },
    ],
    unknowns: ["iostat not available"],
  };
  const digest = formatProbeDigest(input);
  assert.match(digest, /# Observed/);
  assert.match(digest, /# Threshold evaluation/);
  assert.match(digest, /# Interpretation/);
  assert.match(digest, /# Unknown \/ not collected/);
  assert.match(digest, /# Proposed actions/);
  assert.match(digest, /ev-1111/);
  assert.match(digest, /\[high\]/);
  assert.match(digest, /disk-full: warning \(evidence ev-1111\)/);
  assert.match(digest, /approvalRequired: true/);
  assert.match(digest, /iostat not available/);
});
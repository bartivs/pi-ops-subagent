import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTriage, validateComms, validatePir, validateArtifact, ArtifactValidationError } from "../extensions/artifacts.ts";

const shared = { schemaVersion: "1", generatedAt: "2026-01-02T03:04:05Z", missingInformation: [], redactions: 0 };
const triage = { ...shared, artifactType: "triage", incidentSummary: "latency", severity: "SEV3", observations: [{ id: "o1", evidenceId: "ev-1", fact: "slow" }], hypotheses: [{ summary: "load", evidenceIds: ["ev-1"], confidence: 0.5 }], immediateActions: [{ action: "review", mutation: false, approvalRequired: false, runbook: "latency" }], runbookAlignment: "latency" };
const comms = { ...shared, artifactType: "comms", status: "investigating", severity: "SEV3", slackUpdate: "investigating", stakeholderBrief: "impact unknown", knownImpact: "UNKNOWN", nextUpdateAt: "UNKNOWN" };
const pir = { ...shared, artifactType: "pir", title: "review", status: "draft", timeline: [{ timestamp: "UNKNOWN", event: "UNKNOWN", evidenceIds: [] }], customerImpact: { summary: "UNKNOWN", quantified: "UNKNOWN" }, rootCause: "UNKNOWN", contributingFactors: [], preventionActions: [{ action: "collect", owner: "UNKNOWN", dueDate: "UNKNOWN", status: "open" }] };

test("valid triage/comms/PIR schemas validate with exact shared fields", () => {
  assert.equal(validateTriage(triage, ["ev-1"]).artifactType, "triage");
  assert.equal(validateComms(comms).artifactType, "comms");
  assert.equal(validatePir(pir).artifactType, "pir");
});

test("all artifact validators reject unknown keys and wrong enums/types", () => {
  assert.throws(() => validateTriage({ ...triage, extra: true }), ArtifactValidationError);
  assert.throws(() => validateComms({ ...comms, status: "bad" }), ArtifactValidationError);
  assert.throws(() => validatePir({ ...pir, customerImpact: { summary: "x", quantified: "y", extra: true } }), ArtifactValidationError);
  assert.throws(() => validateTriage({ ...triage, severity: "SEV9" }), /severity/);
});

test("triage evidence references, confidence range, and mutation approval are enforced", () => {
  assert.throws(() => validateTriage(triage, ["other"]), /supplied evidence/);
  assert.throws(() => validateTriage({ ...triage, hypotheses: [{ summary: "unsupported", evidenceIds: [], confidence: 0.1 }] }), /confidence 0/);
  assert.throws(() => validateTriage({ ...triage, immediateActions: [{ action: "change", mutation: true, approvalRequired: false, runbook: "x" }] }), /approvalRequired/);
  assert.throws(() => validateTriage({ ...triage, hypotheses: [{ summary: "x", evidenceIds: ["ev-1"], confidence: 2 }] }), /range/);
});

test("PIR final is forbidden while root cause, impact, or timeline facts are unknown", () => {
  assert.throws(() => validatePir({ ...pir, status: "final" }), /draft/);
  const complete = { ...pir, status: "final", timeline: [{ timestamp: "2026-01-02T03:04:05Z", event: "detected", evidenceIds: [] }], customerImpact: { summary: "one user", quantified: "1 request" }, rootCause: "bad deploy" };
  assert.equal(validatePir(complete).status, "final");
});

test("timestamps accept RFC3339 or UNKNOWN and reject prose", () => {
  assert.throws(() => validateComms({ ...comms, generatedAt: "tomorrow" }), /RFC3339/);
  assert.throws(() => validateComms({ ...comms, nextUpdateAt: "2026-01-02 03:04:05" }), /RFC3339/);
});

test("validateArtifact dispatches by artifactType", () => {
  assert.equal(validateArtifact(triage).artifactType, "triage");
  assert.throws(() => validateArtifact({ ...comms, artifactType: "unknown" }), /unsupported/);
});
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeArtifacts } from "../extensions/artifacts.ts";

const base = { schemaVersion: "1", generatedAt: "UNKNOWN", missingInformation: [], redactions: 0 };
const triage = { ...base, artifactType: "triage", incidentSummary: "x", severity: "UNKNOWN", observations: [], hypotheses: [], immediateActions: [], runbookAlignment: "UNKNOWN" };
const comms = { ...base, artifactType: "comms", status: "UNKNOWN", severity: "UNKNOWN", slackUpdate: "x", stakeholderBrief: "x", knownImpact: "UNKNOWN", nextUpdateAt: "UNKNOWN" };

test("composition runs requested artifact types concurrently and preserves partial success", async () => {
  const result = await composeArtifacts(["triage", "comms", "pir"], async (type) => {
    if (type === "triage") return JSON.stringify(triage);
    if (type === "comms") return JSON.stringify(comms);
    return "truncated";
  });
  assert.equal(result.triage?.status, "done");
  assert.equal(result.comms?.status, "done");
  assert.equal(result.pir?.status, "failed");
  assert.deepEqual(Object.keys(result).sort(), ["comms", "pir", "triage"]);
});

test("composition returns only requested keys and redacts thrown diagnostics", async () => {
  const result = await composeArtifacts(["comms"], async () => { throw new Error("password=literal"); });
  assert.deepEqual(Object.keys(result), ["comms"]);
  assert.equal(result.comms?.status, "failed");
  assert.doesNotMatch(result.comms?.error ?? "", /literal/);
});
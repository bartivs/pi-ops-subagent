import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArtifactOutput, redactArtifactText, composeArtifacts } from "../extensions/artifacts.ts";
import { normalizeManifestEntry, ManifestValidationError, sha256Hex } from "../extensions/catalog.ts";

const triage = { schemaVersion: "1", artifactType: "triage", generatedAt: "UNKNOWN", missingInformation: [], redactions: 0, incidentSummary: "x", severity: "UNKNOWN", observations: [], hypotheses: [], immediateActions: [], runbookAlignment: "UNKNOWN" };
const comms = { schemaVersion: "1", artifactType: "comms", generatedAt: "UNKNOWN", missingInformation: [], redactions: 0, status: "UNKNOWN", severity: "UNKNOWN", slackUpdate: "x", stakeholderBrief: "x", knownImpact: "UNKNOWN", nextUpdateAt: "UNKNOWN" };
const pir = { schemaVersion: "1", artifactType: "pir", generatedAt: "UNKNOWN", missingInformation: [], redactions: 0, title: "x", status: "draft", timeline: [], customerImpact: { summary: "UNKNOWN", quantified: "UNKNOWN" }, rootCause: "UNKNOWN", contributingFactors: [], preventionActions: [] };

test("parser is one-pass: valid JSON succeeds and malformed/truncated output fails without repair", () => {
  assert.equal(parseArtifactOutput(JSON.stringify(triage), { expectedType: "triage" }).status, "done");
  assert.equal(parseArtifactOutput('{"schemaVersion":"1"', { expectedType: "triage" }).status, "failed");
  const truncated = parseArtifactOutput(JSON.stringify(triage), { expectedType: "triage", stopReason: "length" });
  assert.equal(truncated.status, "failed");
  assert.match(truncated.error!, /length/);
});

test("secret-like artifact text is redacted before parsing and counted", () => {
  const raw = JSON.stringify({ ...comms, slackUpdate: "password=super-secret", redactions: 1 });
  const redacted = redactArtifactText(raw);
  assert.equal(redacted.redactions, 1);
  assert.doesNotMatch(redacted.text, /super-secret/);
  const result = parseArtifactOutput(raw, { expectedType: "comms" });
  assert.equal(result.status, "done");
  assert.equal((result.artifact as any).slackUpdate, "password=[REDACTED]");
  assert.equal((result.artifact as any).redactions, 1);
});

test("parser rejects wrong type, unknown keys, invalid evidence, and redaction mismatch", () => {
  assert.equal(parseArtifactOutput(JSON.stringify(comms), { expectedType: "triage" }).status, "failed");
  assert.equal(parseArtifactOutput(JSON.stringify({ ...triage, extra: 1 }), { expectedType: "triage" }).status, "failed");
  const evidence = { ...triage, observations: [{ id: "o", evidenceId: "missing", fact: "x" }] };
  assert.equal(parseArtifactOutput(JSON.stringify(evidence), { expectedType: "triage", evidenceIds: ["ev-1"] }).status, "failed");
  assert.equal(parseArtifactOutput(JSON.stringify({ ...triage, redactions: 2 }), { expectedType: "triage" }).status, "failed");
});

test("parallel composition preserves successful siblings and reports only failed types", async () => {
  const result = await composeArtifacts(["triage", "comms", "pir"], async (type) => {
    if (type === "triage") return JSON.stringify(triage);
    if (type === "comms") return JSON.stringify(comms);
    return "not-json";
  });
  assert.equal(result.triage!.status, "done");
  assert.equal(result.comms!.status, "done");
  assert.equal(result.pir!.status, "failed");
  assert.deepEqual(Object.keys(result).sort(), ["comms", "pir", "triage"]);
});

test("composition deduplicates requested types and retains thrown diagnostics redacted", async () => {
  let calls = 0;
  const result = await composeArtifacts(["comms", "comms"], async () => { calls++; throw new Error("token=secret"); });
  assert.equal(calls, 1);
  assert.equal(result.comms!.status, "failed");
  assert.doesNotMatch(result.comms!.error!, /secret/);
});

void pir;

test("shared manifest normalization is source-agnostic and fingerprintable", () => {
  // The factored catalog normalizer must be callable with a hand-built frontmatter
  // (no executable file on disk), which is exactly the initializer reuse path.
  const canonical = "/tmp/source-agnostic.md";
  const content = "---\nname: sn\ndescription: Source agnostic\ntools: [ls, find]\n---\n\nBody.";
  const { entry } = normalizeManifestEntry(
    { name: "sn", description: "Source agnostic", tools: ["ls", "find"] } as Record<string, unknown>,
    "Body.",
    content,
    canonical,
    "bundled",
  );
  assert.equal(entry.kind, "general");
  assert.deepEqual(entry.tools, ["ls", "find"]);
  assert.equal(entry.canonicalPath, canonical);
  assert.equal(entry.source, "bundled");
  assert.equal(entry.contentHash, sha256Hex(content));
  assert.doesNotThrow(() => normalizeManifestEntry(
    { name: "ok", description: "d", kind: "probe" } as Record<string, unknown>,
    "body",
    content,
    canonical,
    "project",
  ));
  assert.throws(
    () => normalizeManifestEntry({ name: "9bad" } as Record<string, unknown>, "body", content, canonical),
    ManifestValidationError as any,
  );
});
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageRoot, discoverCatalog } from "../extensions/catalog.ts";
import { loadConfig } from "../extensions/config.ts";

const agentsDir = path.join(findPackageRoot(), "agents");
const expected = {
  triage: ["incidentSummary", "severity", "observations", "hypotheses", "immediateActions", "runbookAlignment"],
  comms: ["status", "severity", "slackUpdate", "stakeholderBrief", "knownImpact", "nextUpdateAt"],
  pir: ["title", "status", "timeline", "customerImpact", "rootCause", "contributingFactors", "preventionActions"],
};

test("bundled artifact agents have artifact kind and explicit JSON-only prompts", () => {
  for (const [name, fields] of Object.entries(expected)) {
    const text = fs.readFileSync(path.join(agentsDir, `${name}.md`), "utf8");
    assert.match(text, new RegExp(`name: ${name}`));
    assert.match(text, /kind: artifact/);
    assert.match(text, /JSON/);
    assert.match(text, /Return JSON only/);
    assert.match(text, /no prose/);
    assert.match(text, /no fenced code block/);
    assert.match(text, /additionalProperties/);
    for (const field of fields) assert.match(text, new RegExp(`"${field}"`), `${name} contains ${field}`);
    assert.match(text, /Valid example/);
  }
});

test("artifact prompts are discoverable and synchronized to artifact kind", () => {
  const root = fs.mkdtempSync(path.join("/tmp", "ops-artifact-prompt-"));
  const config = loadConfig(root);
  const snapshot = discoverCatalog(config, true, { bundledAgentsDir: agentsDir, userAgentsDir: path.join(root, "none") });
  for (const name of Object.keys(expected)) {
    const entry = snapshot.entries.find((candidate) => candidate.name === name);
    assert.ok(entry, name);
    assert.equal(entry!.kind, "artifact");
    assert.match(entry!.systemPrompt, /schemaVersion/);
    assert.match(entry!.systemPrompt, new RegExp(`artifactType\\":\\"${name}`));
  }
});
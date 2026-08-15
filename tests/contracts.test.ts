import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../extensions/config.ts";
import {
  discoverContracts,
  parseContract,
  selectContracts,
  checkContractSecrets,
  buildContractsPrompt,
  contractDetails,
  ContractValidationError,
  ContractSelectionError,
  ContractSecretError,
  type ContractCatalog,
} from "../extensions/contracts.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-contracts-"));
}

function setup() {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".ops", "contracts"), { recursive: true });
  const cfg = loadConfig(root);
  return { root, cfg };
}

function writeContract(root: string, name: string, over: Record<string, unknown> = {}): string {
  const base = {
    version: 1,
    name,
    targetId: "prod",
    expectedIdentity: "prod-db-01",
    verifyProfile: "hostname",
    connectionProfile: "prod-db-readonly",
  };
  const body = typeof over["body"] === "string" ? (over["body"] as string) : `Notes for ${name}.`;
  const { body: _body, ...rest } = over;
  const fm = { ...base, ...rest };
  const yaml = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.join(", ")}]`;
      if (typeof v === "object" && v !== null) return `${k}:\n${Object.entries(v as Record<string, unknown>).map(([a, b]) => `  ${a}: ${JSON.stringify(b)}`).join("\n")}`;
      return `${k}: ${typeof v === "string" && /[:#]/.test(v) ? JSON.stringify(v) : v}`;
    })
    .join("\n");
  const file = path.join(root, ".ops", "contracts", `${name}.md`);
  fs.writeFileSync(file, `---\n${yaml}\n---\n\n${body}\n`);
  return file;
}

test("valid v1 contract parses with canonical path and SHA-256 hash", () => {
  const { root, cfg } = setup();
  const file = writeContract(root, "prod");
  const cat = discoverContracts(cfg);
  assert.equal(cat.contracts.length, 1);
  const doc = cat.contracts[0]!;
  assert.equal(doc.name, "prod");
  assert.equal(doc.version, 1);
  assert.equal(doc.targetId, "prod");
  assert.equal(doc.expectedIdentity, "prod-db-01");
  assert.equal(doc.verifyProfile, "hostname");
  assert.equal(doc.connectionProfile, "prod-db-readonly");
  assert.equal(doc.canonicalPath, path.resolve(file));
  assert.match(doc.contentHash, /^[0-9a-f]{64}$/);
  assert.match(doc.notes, /Notes for prod/);
});

test("unsupported version rejected with supported-version guidance", () => {
  const { root, cfg } = setup();
  writeContract(root, "v2", { version: 2 });
  const cat = discoverContracts(cfg);
  assert.equal(cat.contracts.length, 0);
  assert.equal(cat.diagnostics.invalid.length, 1);
  assert.match(cat.diagnostics.invalid[0]!.message, /Unsupported contract version 2/);
  assert.match(cat.diagnostics.invalid[0]!.message, /supported version: 1/);
});

test("unknown keys, wrong types, empty required values invalidate only that contract", () => {
  const { root, cfg } = setup();
  writeContract(root, "good", {});
  writeContract(root, "unknown-key", { secretStuff: "x" });
  writeContract(root, "empty-target", { targetId: "" });
  writeContract(root, "bad-profile", { verifyProfile: "" });
  const cat = discoverContracts(cfg);
  assert.equal(cat.contracts.length, 1);
  assert.equal(cat.contracts[0]!.name, "good");
  assert.equal(cat.diagnostics.invalid.length, 3);
  assert.ok(cat.diagnostics.invalid.some((d) => /Unknown frontmatter key "secretStuff"/.test(d.message)));
  assert.ok(cat.diagnostics.invalid.some((d) => /"targetId" must be a non-empty string/.test(d.message)));
});

test("duplicate contract names report both canonical paths", () => {
  const { root, cfg } = setup();
  const f1 = writeContract(root, "dup", {});
  const f2 = writeContract(root, "dup2", {});
  fs.writeFileSync(f1, fs.readFileSync(f1, "utf8").replace(/name: dup/, "name: same"));
  fs.writeFileSync(f2, fs.readFileSync(f2, "utf8").replace(/name: dup2/, "name: same"));
  const cat = discoverContracts(cfg);
  assert.equal(cat.diagnostics.duplicates.length, 1);
  assert.equal(cat.diagnostics.duplicates[0]!.name, "same");
  assert.equal(cat.diagnostics.duplicates[0]!.canonicalPaths.length, 2);
});

test("nested files are not discovered", () => {
  const { root, cfg } = setup();
  fs.mkdirSync(path.join(root, ".ops", "contracts", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ops", "contracts", "nested", "deep.md"), "---\nname: deep\nversion: 1\ntargetId: t\nexpectedIdentity: e\nverifyProfile: hostname\nconnectionProfile: c\n---\nbody");
  const cat = discoverContracts(cfg);
  assert.equal(cat.contracts.length, 0);
});

test("selection precedence: call > manifest > config > none", () => {
  const { root, cfg } = setup();
  writeContract(root, "prod");
  writeContract(root, "stage");
  const cat = discoverContracts(cfg);

  // call wins
  const callSel = selectContracts(["prod"], ["stage"], "prod", cat);
  assert.equal(callSel.source, "call");
  assert.deepEqual(callSel.contracts.map((c) => c.name), ["prod"]);

  // manifest (one-item) wins over config
  const manifestSel = selectContracts(undefined, ["stage"], "prod", cat);
  assert.equal(manifestSel.source, "manifest");
  assert.deepEqual(manifestSel.contracts.map((c) => c.name), ["stage"]);

  // config default
  const configSel = selectContracts(undefined, [], "prod", cat);
  assert.equal(configSel.source, "config");
  assert.deepEqual(configSel.contracts.map((c) => c.name), ["prod"]);

  // none
  const noneSel = selectContracts(undefined, [], null, cat);
  assert.equal(noneSel.source, "none");
  assert.deepEqual(noneSel.contracts, []);
});

test("unique 0-4 list enforced; duplicates and >4 rejected", () => {
  const { root, cfg } = setup();
  for (const n of ["a", "b", "c", "d", "e"]) writeContract(root, n);
  const cat = discoverContracts(cfg);
  assert.throws(() => selectContracts(["a", "a"], [], null, cat), ContractSelectionError);
  assert.throws(() => selectContracts(["a", "b", "c", "d", "e"], [], null, cat), /At most 4/);
  const ok = selectContracts(["a", "b"], [], null, cat);
  assert.equal(ok.contracts.length, 2);
});

test("existence check: unknown selected name fails with available list", () => {
  const { root, cfg } = setup();
  writeContract(root, "prod");
  const cat = discoverContracts(cfg);
  assert.throws(
    () => selectContracts(["nope"], [], null, cat),
    (e) => e instanceof ContractSelectionError && e.category === "missing" && /Available contracts: prod/.test(e.message),
  );
});

test("multi-contract compatibility: conflicting targets/profiles fail before spawn", () => {
  const { root, cfg } = setup();
  writeContract(root, "a", { targetId: "prod", connectionProfile: "p1" });
  writeContract(root, "b", { targetId: "staging", connectionProfile: "p1" });
  const cat = discoverContracts(cfg);
  assert.throws(
    () => selectContracts(["a", "b"], [], null, cat),
    (e) => e instanceof ContractSelectionError && e.category === "conflict" && /targetId differs/.test(e.message),
  );
  writeContract(root, "c", { targetId: "prod", connectionProfile: "p2", expectedIdentity: "prod-db-01", verifyProfile: "hostname" });
  const cat2 = discoverContracts(cfg);
  assert.throws(() => selectContracts(["a", "c"], [], null, cat2), /connectionProfile differs/);
});

test("secret-safe validation rejects literal credentials with file/line/category", () => {
  const { root, cfg } = setup();
  writeContract(root, "leaky", { body: "password: hunter2\n" });
  const cat = discoverContracts(cfg);
  assert.throws(
    () => checkContractSecrets(cat.contracts.find((c) => c.name === "leaky")!),
    (e) => {
      assert.ok(e instanceof ContractSecretError);
      assert.match(e.message, /credential-like content \(1 hit\(s\)\)/);
      assert.match(e.message, /leaky\.md:\d+:\d+ \[password-assignment\]/);
      assert.equal(e.hits[0]!.category, "password-assignment");
      return true;
    },
  );
});

test("private keys, bearer tokens, and URI userinfo are rejected", () => {
  const { root, cfg } = setup();
  writeContract(root, "pk", { body: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----" });
  writeContract(root, "bearer", { body: "Authorization: Bearer abc.def.ghi" });
  writeContract(root, "uri", { body: "postgres://admin:supersecret@db.example.com/prod" });
  const cat = discoverContracts(cfg);
  for (const name of ["pk", "bearer", "uri"]) {
    assert.throws(() => checkContractSecrets(cat.contracts.find((c) => c.name === name)!), ContractSecretError, name);
  }
});

test("placeholders and connection-profile identifiers are allowed", () => {
  const { root, cfg } = setup();
  writeContract(root, "ok", { body: "password: ${DB_PASSWORD}\ntoken: ${API_TOKEN}\nconn: prod-db-readonly" });
  const cat = discoverContracts(cfg);
  const doc = cat.contracts.find((c) => c.name === "ok")!;
  assert.doesNotThrow(() => checkContractSecrets(doc));
});

test("injection: ordered ops_contract blocks then unchanged delegated_task", () => {
  const { root, cfg } = setup();
  writeContract(root, "a", { body: "notes A" });
  writeContract(root, "b", { body: "notes B" });
  const cat = discoverContracts(cfg);
  const [a, b] = ["a", "b"].map((n) => cat.contracts.find((c) => c.name === n)!);
  const prompt = buildContractsPrompt([a, b], "Check the target disk.");
  const aIdx = prompt.indexOf("<ops_contract name=\"a\">");
  const bIdx = prompt.indexOf("<ops_contract name=\"b\">");
  const taskIdx = prompt.indexOf("<delegated_task>");
  assert.ok(aIdx !== -1 && bIdx !== -1 && taskIdx !== -1);
  assert.ok(aIdx < bIdx, "selection order preserved");
  assert.ok(bIdx < taskIdx, "delegated task follows all contract blocks");
  assert.match(prompt, /version: 1/);
  assert.match(prompt, /targetId: prod/);
  assert.match(prompt, /Verify expectedIdentity with verifyProfile before diagnostics\. Never fall back to the local machine\./);
  assert.match(prompt, /<delegated_task>Check the target disk\.<\/delegated_task>/);
  assert.match(prompt, /notes A/);
  assert.match(prompt, /notes B/);
});

test("contractDetails records name, path, hash for details", () => {
  const { root, cfg } = setup();
  writeContract(root, "prod");
  const cat = discoverContracts(cfg);
  const details = contractDetails(selectContracts(["prod"], [], null, cat).contracts);
  assert.deepEqual(Object.keys(details[0]!).sort(), ["canonicalPath", "contentHash", "name"]);
});

test("parseContract rejects bad baselines/naming/runbooks shapes", () => {
  const { root, cfg } = setup();
  writeContract(root, "bad-baseline", { baselines: { load: [1, 2] } });
  writeContract(root, "bad-naming", { naming: "x" });
  writeContract(root, "bad-runbooks", { runbooks: "nope" });
  const cat = discoverContracts(cfg);
  assert.equal(cat.contracts.length, 0);
  assert.equal(cat.diagnostics.invalid.length, 3);
});
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  analyzeAgentsMd,
  renderAgentsGuidance,
  renderAgentsSection,
  escapeGuidanceDescription,
  truncateUtf8,
  validateMarkers,
  discoverGuidanceManifests,
  composeGuidanceAgents,
  AgentsMdError,
} from "../extensions/usage-guidance.ts";
import { INIT_MARKER_START, INIT_MARKER_END } from "../extensions/constants.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-usage-"));
}
const tmpdir = tmp;

const AGENTS = [
  { name: "reader", description: "Reads and reports" },
  { name: "writer", description: "Writes safely" },
];

test("marker structure accepts none and a single ordered pair, rejects others", () => {
  assert.equal(validateMarkers("# no markers here"), "none");
  assert.equal(validateMarkers(`${INIT_MARKER_START}\nbody\n${INIT_MARKER_END}`), "pair");
  assert.throws(() => validateMarkers(INIT_MARKER_START), /malformed/);
  assert.throws(() => validateMarkers(INIT_MARKER_END), /malformed/);
  assert.throws(() => validateMarkers(`${INIT_MARKER_END}\n${INIT_MARKER_START}`), /malformed/);
  assert.throws(() => validateMarkers(`${INIT_MARKER_START}\n${INIT_MARKER_START}`), /malformed/);
  assert.throws(() => validateMarkers(`${INIT_MARKER_START}\n${INIT_MARKER_END}\n${INIT_MARKER_END}`), /malformed/);
  // indented lookalike is not a real marker
  assert.equal(validateMarkers(`  ${INIT_MARKER_START}`), "none");
});

test("analyze rejects symlink, oversized, and invalid UTF-8 AGENTS.md", () => {
  const root = tmp();

  const big = path.join(root, "big.md");
  fs.writeFileSync(big, "x".repeat(1_100_000));
  assert.throws(() => analyzeAgentsMd(big), /exceeds/);

  const bad = path.join(root, "bad.md");
  fs.writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x00, 0x61]));
  assert.throws(() => analyzeAgentsMd(bad), /UTF-8/);

  const link = path.join(root, "link.md");
  fs.symlinkSync(path.join(root, "target.md"), link);
  assert.throws(() => analyzeAgentsMd(link), /symbolic link/);

  assert.equal(analyzeAgentsMd(path.join(root, "missing.md")), null);
});

test("create: absent file yields a create action and an LF one-managed-section file", () => {
  const out = renderAgentsGuidance(null, AGENTS, ".ops");
  assert.equal(out.action, "create");
  assert.equal(out.beforeBytes, null);
  assert.equal(out.beforeHash, null);
  assert.ok(out.afterBytes.startsWith(INIT_MARKER_START));
  assert.ok(out.afterBytes.trimEnd().endsWith(INIT_MARKER_END));
  assert.ok(out.afterBytes.endsWith("\n"));
  // LF only
  assert.ok(!out.afterBytes.includes("\r"));
  assert.ok(out.afterHash.length === 64);
  // exactly the two agent rows in a table, in lexical order
  const rows = out.afterBytes.split("\n").filter((l) => /^\| `/.test(l));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^\| `reader`/);
  assert.match(rows[1], /^\| `writer`/);
  assert.ok(out.afterBytes.includes("| Agent | Kind | Purpose |"));
});

test("existing no-marker AGENTS.md is preserved with one blank line before the section", () => {
  const root = tmp();
  const f = path.join(root, "AGENTS.md");
  fs.writeFileSync(f, "My own parent guidance\nsecond line");
  const analyzed = analyzeAgentsMd(f);
  const out = renderAgentsGuidance(analyzed, AGENTS, ".ops");
  assert.equal(out.action, "replace");
  assert.ok(out.beforeBytes === "My own parent guidance\nsecond line");
  assert.ok(out.afterBytes.startsWith("My own parent guidance\nsecond line\n\n"));
  assert.ok(out.afterBytes.includes(INIT_MARKER_START));
});

test("existing managed pair is replaced while prefix and suffix bytes are preserved", () => {
  const root = tmpdir();
  const f = path.join(root, "AGENTS.md");
  const before = `PREFIX\n${INIT_MARKER_START}\nold\n${INIT_MARKER_END}\nSUFFIX`;
  fs.writeFileSync(f, before);
  const analyzed = analyzeAgentsMd(f);
  const out = renderAgentsGuidance(analyzed, AGENTS, ".ops");
  assert.equal(out.action, "replace");
  assert.ok(out.afterBytes.startsWith("PREFIX\n"));
  assert.ok(out.afterBytes.endsWith("\nSUFFIX"));
  assert.ok(out.afterBytes.includes("### Available agents"));
  // exactly one managed pair remains
  assert.equal((out.afterBytes.match(new RegExp(escapeRe(INIT_MARKER_START), "g")) ?? []).length, 1);
  assert.equal((out.afterBytes.match(new RegExp(escapeRe(INIT_MARKER_END), "g")) ?? []).length, 1);
});

test("re-render of the unchanged managed output is a no-op", () => {
  const root = tmpdir();
  const f = path.join(root, "AGENTS.md");
  const out = renderAgentsGuidance(null, AGENTS, ".ops");
  fs.writeFileSync(f, out.afterBytes);
  const twice = renderAgentsGuidance(analyzeAgentsMd(f), AGENTS, ".ops");
  assert.equal(twice.action, "unchanged");
  assert.equal(twice.afterBytes, out.afterBytes);
});

test("CRLF existing file yields CRLF section line endings", () => {
  const root = tmpdir();
  const f = path.join(root, "AGENTS.md");
  fs.writeFileSync(f, "line1\r\nline2");
  const out = renderAgentsGuidance(analyzeAgentsMd(f), AGENTS, ".ops");
  // every line break in the generated section is \r\n
  assert.ok(out.afterBytes.includes("\r\n"));
  const sample = out.afterBytes.slice(out.afterBytes.indexOf(INIT_MARKER_START));
  assert.doesNotMatch(sample, /(?<!\r)\n/);
});

test("description escaping, whitespace collapse, and truncation", () => {
  assert.equal(escapeGuidanceDescription("a  b\tc"), "a b c");
  assert.equal(escapeGuidanceDescription("x <y> & z"), "x &lt;y&gt; & z");
  const special = "`*_[]()#+-!|";
  const out = escapeGuidanceDescription(special);
  assert.match(out, /\\`/);
  assert.match(out, /\\\*/);
  assert.match(out, /\\_/);
  assert.match(out, /\\\[/);
  assert.match(out, /\\#/);
  const long = "z".repeat(500);
  const truncated = escapeGuidanceDescription(long, 300);
  assert.ok(truncated.endsWith("..."));
  assert.ok(Buffer.byteLength(truncated.slice(0, -3), "utf8") <= 300);
});

test("truncateUtf8 keeps a valid UTF-8 boundary", () => {
  const emoji = "\u{1F600}".repeat(200); // 4 bytes each
  const t = truncateUtf8("a".repeat(200) + emoji, 320);
  assert.ok(Buffer.byteLength(t, "utf8") <= 323); // ≤320 + 3 for "..."
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(t, "utf8")));
});

function writeManifest(dir: string, name: string, body = "You are a specialist."): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} does work\nkind: general\n---\n\n${body}\n`);
  return file;
}

test("guidance discovery returns valid mains and diagnostics for invalid existing files", () => {
  const root = tmpdir();
  const dir = path.join(root, "agents");
  writeManifest(dir, "alpha");
  fs.writeFileSync(path.join(dir, "badkind.md"), "---\nname: badkind\nkind: evil\ndescription: nope\n---\n\nbody\n");
  fs.writeFileSync(path.join(dir, "broken.md"), "not frontmatter at all");
  const discovered = discoverGuidanceManifests(dir);
  assert.deepEqual(discovered.valid.map((m) => m.name).sort(), ["alpha"]);
  assert.ok(discovered.invalid.length === 2);
  assert.ok(discovered.invalid.some((m) => m.canonicalPath.endsWith("broken.md")));
  assert.ok(discovered.invalid.some((m) => m.canonicalPath.endsWith("badkind.md")));
  assert.equal(discoverGuidanceManifests(path.join(root, "missing")).valid.length, 0);
});

test("colliding declared name across a different filename is surfaced for composition", () => {
  const root = tmpdir();
  const dir = path.join(root, "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "legacy.md"), "---\nname: review\ndescription: legacy review\n---\n\nbody\n");
  const discovered = discoverGuidanceManifests(dir);
  assert.equal(discovered.valid.length, 1);
  assert.equal(discovered.valid[0].name, "review");
  assert.ok(discovered.valid[0].canonicalPath.endsWith("legacy.md"));
});

test("composition honors staged manifests while keeping unchanged existing rows and sorting", () => {
  const existing = [
    { name: "zebra", description: "z", kind: "probe" },
    { name: "alpha", description: "a", kind: "general" },
  ];
  const staged = [
    { name: "alpha", description: "a (revised)", kind: "worker" },
    { name: "new-agent", description: "n", kind: "general" },
  ];
  const rows = composeGuidanceAgents(existing, staged);
  assert.deepEqual(rows.map((r) => r.name), ["alpha", "new-agent", "zebra"]);
  assert.equal(rows.find((r) => r.name === "alpha")!.description, "a (revised)");
  assert.equal(rows.find((r) => r.name === "alpha")!.kind, "worker");
});

test("available agents render as an escaped Markdown table with Agent/Kind/Purpose", () => {
  const section = renderAgentsSection(
    [
      { name: "beta", description: "escapes | pipe and `code`", kind: "worker" },
      { name: "alpha", description: "plain", kind: "probe" },
    ],
    ".ops",
    "LF",
  );
  const body = section.slice(section.indexOf("### Available agents"));
  assert.ok(body.includes("| Agent | Kind | Purpose |"));
  assert.ok(body.includes("| --- | --- | --- |"));
  const alphaRow = body.split("\n").find((l) => l.includes('`alpha`'))!;
  assert.match(alphaRow, /\| `alpha` \| probe \| plain \|/);
  const betaRow = body.split("\n").find((l) => l.includes('`beta`'))!;
  assert.ok(betaRow.includes("escapes \\| pipe and \\`code\\`"), "pipe/backtick escaped for table safety");
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
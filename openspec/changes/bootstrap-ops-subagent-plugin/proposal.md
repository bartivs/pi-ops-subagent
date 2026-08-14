## Why

Ops teams do repetitive, risky, context-heavy work (triage, RCA, health probes, runbook verification) that today's
subagent plugins don't serve: `pi-subagents` and `@mjakl/pi-subagent` are code-review/implementation-shaped, and the
provenance implementation built for production server diagnostics (isolated `--mode json` children + digest-only
returns + live widget) is private and host-specific. There is no OSS, terminal-native, vendor-agnostic "operations
subagent fleet" for pi that
combines isolated read-only probes, parent-configurable timeouts, background/scheduled runs, named sessions, and a
live cockpit. SOTA research (ORCA-bench: 25% RCA accuracy / 10% on hard; New Relic boundaries; Datadog Bits autonomy;
Microsoft On-Call Copilot: 4 parallel schema'd specialists; ACE: playbook memory) says agents are not ready for
unsupervised on-call — the defensible OSS position is: autonomous investigation, gated action, evidence-only output.

## What Changes

- **New pi package `pi-ops-subagent`** (installable via `pi install git:...` / `npm:...`) that registers a `subagent`
  tool with single / parallel / chain modes plus an `/ops` command suite.
- **Per-call timeouts controllable by the parent agent** (LLM-set `timeout` param), with precedence
  per-call > agent manifest > project config > environment default, and a hard ceiling; kill ladder
  (grace → SIGTERM → cooldown → SIGKILL).
- **Probe protocol**: read-only by construction (per-agent `tools:` allowlists, "verify target first", evidence-only
  digests, thresholds, never-fabricate), matching the safety posture of Google SRE toil guidance and New Relic SRE
  Agent (no changes to production without approval).
- **Environment contracts**: a marked contract file (e.g. `.ops/contracts/*.md`) injected
  automatically into every child; single source of truth for target, naming conventions, runbook pointers.
- **Background jobs**: `run_async`, durable run registry (survives restart, resumable), `jobs list`, scheduled
  runs (interval/at), artifacts in a gitignored `runs/`.
- **Named sessions**: persistent child sessions keyed by agent+name+parent+cwd with locking and expiry — enabling
  interview-style multi-turn diagnosis.
- **Fleet cockpit**: live tabbed widget (per-agent phase/elapsed/activity/tool-output/digest, keyboard nav) so raw
  tool output never pollutes the parent conversation — context-hygiene as a first-class contract, extending the
  proven widget from the private production-diagnostics extension.
- **Incident artifact agents** (Microsoft On-Call Copilot pattern): `triage`, `comms` (Slack/stakeholder), `PIR`
  with strict JSON output schemas, parallel fan-in.
- **BREAKING**: none (new package, no existing behavior modified).

## Capabilities

### New Capabilities

- `subagent-runner`: core delegation runtime — modes (single/parallel/chain), isolated `--mode json` children,
  usage/cost tracking, per-call timeout with precedence ladder, output caps, abort propagation.
- `probe-protocol`: the ops safety contract — read-only enforcement, target verification, evidence-only digests,
  thresholds + never-fabricate, gated-action policy.
- `env-contracts`: environment/target context injection into children from marked contract files; naming, runbook
  pointers, connection info; gitignored by default.
- `background-jobs`: async + scheduled + resumable runs; durable registry; artifact output in `runs/`.
- `named-sessions`: persistent named child-pi sessions (derivation, locking, expiry) for multi-turn diagnosis.
- `fleet-cockpit`: live tabbed observability widget with keyboard navigation (engage `Alt+o`, `←→`/`Tab` cycle,
  `1-9` jump, `Enter`, `s`, `f`, `↑↓`, `Esc`).
- `incident-artifacts`: schema'd artifact producers (triage / comms / PIR) with confidence & missing-information
  disclosures; composed on demand from probe evidence.

### Modified Capabilities

- (none — greenfield project)

## Impact

- **Code**: new package under `openspec/…` — `src/` extension (`subagent` tool + `/ops` commands), bundled role
  manifests (`probe-*`, `triage`, `comms`, `pir`, `oracle`), widget component, runners (process, registry).
- **APIs**: `ExtensionAPI` surface — one tool (`subagent`) with `calls[]`-style schema; commands
  (`/ops:probe`, `/ops:jobs`, `/ops:session`); TUI via `ctx.ui.setWidget` + `onTerminalInput`.
- **Dependencies**: peer deps only (`@earendil-works/pi-*`, `typebox`), zero runtime deps for the core; optional
  backend connectors (`ssh`, `MCP`) later.
- **Docs**: README, proposal/specs/design/tasks in this change, quickstart for a sample stack (host/db/cache
  probes).
- **Systems**: no mutations; only reads against the environment the parent is authorized for.
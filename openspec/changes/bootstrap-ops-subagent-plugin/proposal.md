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

- **New pi package `pi-ops-subagent`** installable globally or into a repository (`pi install -l <npm|git|path>`),
  with a package manifest that loads the `subagent` tool and `/ops` command suite without symlink setup.
- **Extensible agent catalog**: bundled definitions plus user, project, and configured-folder manifests; deterministic
  precedence and provenance; validation diagnostics; and `includeBundledAgents: false` to opt out of all included roles.
- **Per-call timeouts controllable by the parent agent** (LLM-set integer `timeoutSeconds`), with precedence
  per-call > agent manifest > project config > environment default, and a hard ceiling; kill ladder
  (grace → SIGTERM → cooldown → SIGKILL).
- **Probe protocol**: read-only by construction (per-agent `tools:` allowlists, "verify target first", evidence-only
  digests, thresholds, never-fabricate), matching the safety posture of Google SRE toil guidance and New Relic SRE
  Agent (no changes to production without approval).
- **Environment contracts**: a marked contract file (e.g. `.ops/contracts/*.md`) injected
  automatically into every child; single source of truth for target, naming conventions, runbook pointers.
- **Background jobs**: `runAsync`, durable run registry (survives restart, resumable), `/ops:jobs list`, scheduled
  runs (`intervalSec`/RFC3339 `at`), artifacts in gitignored `.ops/runs/`.
- **Named sessions**: persistent child sessions keyed by agent+name+parent+cwd with locking and expiry — enabling
  interview-style multi-turn diagnosis.
- **Fleet observability with progressive disclosure**: a passive one-line summary, streaming tool-row updates,
  completion/failure notices, and an `Alt+o` focused overlay with per-run phase, queue/deadline, elapsed time,
  activity, output tail, digest, usage, cost, source provenance, and bounded history. Raw tool output never pollutes
  the parent conversation, and `/ops:status` exposes the same snapshot in headless or non-interactive workflows.
- **Incident artifact agents** (Microsoft On-Call Copilot pattern): `triage`, `comms` (Slack/stakeholder), `PIR`
  with strict JSON output schemas, parallel fan-in.
- **BREAKING**: none (new package, no existing behavior modified).

## Capabilities

### New Capabilities

- `agent-catalog`: package/project installation and extensible manifest discovery from bundled, user, project, and
  configured directories, including source precedence, provenance, validation, trust gates, and bundled-role opt-out.
- `subagent-runner`: core delegation runtime — modes (single/parallel/chain), isolated `--mode json` children,
  usage/cost tracking, per-call timeout with precedence ladder, output caps, abort propagation.
- `probe-protocol`: the ops safety contract — read-only enforcement, target verification, evidence-only digests,
  thresholds + never-fabricate, gated-action policy.
- `env-contracts`: non-secret environment/target context injection from marked contract files; naming, runbook,
  baseline, and connection-profile references with credential literals rejected before spawn.
- `background-jobs`: async + scheduled + resumable runs; durable registry; artifact output in `.ops/runs/`.
- `named-sessions`: persistent named child-pi sessions (derivation, locking, expiry) for multi-turn diagnosis.
- `fleet-cockpit`: progressive-disclosure observability across passive summary widget, streamed tool rendering,
  focused `Alt+o` overlay, notifications, `/ops:status`, and headless snapshots.
- `incident-artifacts`: schema'd artifact producers (triage / comms / PIR) with confidence & missing-information
  disclosures; composed on demand from probe evidence.

### Modified Capabilities

- (none — greenfield project)

## Impact

- **Code**: new package — `extensions/` entrypoint (`subagent` tool + `/ops` commands), agent-catalog loader,
  bundled role manifests (`probe-*`, `triage`, `comms`, `pir`, `oracle`), passive widget + focused overlay,
  and process/job/session registries.
- **APIs**: `ExtensionAPI` surface — one tool (`subagent`) with single/parallel/chain schema; commands
  (`/ops:agents`, `/ops:status`, `/ops:probe`, `/ops:jobs`, `/ops:session`); TUI via streamed `onUpdate`,
  `ctx.ui.setWidget`, `pi.registerShortcut`, and a focused `ctx.ui.custom({ overlay: true })` component.
- **Dependencies**: peer deps only (`@earendil-works/pi-*`, `typebox`), zero runtime deps for the core; optional
  backend connectors (`ssh`, `MCP`) later.
- **Docs**: README, proposal/specs/design/tasks in this change, quickstart for a sample stack (host/db/cache
  probes).
- **Systems**: no mutations; only reads against the environment the parent is authorized for.
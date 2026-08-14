# Design — bootstrap-opssub-agent-plugin

## Context

See `proposal.md` — Why. Base: a proven private production-server diagnostics extension (provenance + porting notes in
the local, gitignored `.ops/notes/`) which runs `pi --mode json -p --no-session` children with an
isolated context, streams NDJSON events into usage/turns/activity feeds, and renders a live tabbed widget via
`ctx.ui.setWidget` + `onTerminalInput`. This change generalizes that substrate into a package, adds the ops protocol
layer, and the user-mandated capabilities: parent-configurable timeouts, background/scheduled jobs, named sessions.

Constraints from the originating repo: zero runtime deps (peer deps only), reload-safety (`Symbol.for` tokens),
headless safety (`ctx.hasUI` gates), 5-minute per-child cap (now per-call configurable), concurrency cap of 2,
8 parallel max, 50 KB per-task output cap. Package layout per `packages.md` (`pi` key in package.json, conventional
`extensions/` loading, peer deps for `@earendil-works/*`, `typebox`).

## Goals / Non-Goals

**Goals**
- A distributable pi package (`pi install git:... | npm:...`) that keeps the private host-specific parts out (no
  hardcoded target handling, no host-specific agents, no report-write-on-command behavior except under explicit
  user action).
- Full three-mode runner with parent-configurable per-call timeout, kill ladder, abort propagation, caps, usage
  stats — validated against the specs (`subagent-runner`).
- Probe protocol + env contracts as first-class defaults (`probe-protocol`, `env-contracts`).
- Background jobs with durable registry, resumability, and scheduler minimal (interval / at / cron-lite)
  (`background-jobs`).
- Named sessions with deterministic keying + locking + expiry (`named-sessions`).
- Fleet cockpit widget with keyboard nav + pulse + reload-safety (`fleet-cockpit`).
- Artifact roles `triage`/`comms`/`pir` with strict JSON contracts (`incident-artifacts`).

**Non-Goals (v1)**
- Full cron daemon; restricted ingest adapters (MCP connector later); autonomous remediation execution (gated action
  only); multi-process scheduler outside pi's lifetime; fine-tuning / RAG memory loops (ACE-style playbook evolution
  is post-v1); CLI/daemon mode; UI click support (keyboard only, per pi TUI).

## Decisions

### D1. Extension layout: package `extensions/` dir with `index.ts` + modules
`packages.md` auto-discovers `extensions/`. Split like the proven extension:
`index.ts` (tool/command registration + runner), `agents.ts` (manifest discovery), `observability.ts` (registry +
widget pump), `tabs.ts` (pure renderer), `contracts.ts` (env-contract discovery/injection), `jobs.ts` (registry +
scheduler), `sessions.ts` (named-session keying/locking), `artifacts.ts` (schema validator for artifact agents).
**Rationale:** matches the proven design and keeps widget code out of headless paths.
**Alternative considered:** single-file extension — rejected for maintainability.

### D2. Runner: reuse `--mode json` subprocess pattern; add `timeout` param + watchdog
Extend the proven runner: args `--mode json -p --no-session` (+ `--model`, `--tools` from manifest), NDJSON stream
parsed for `message_end`/`tool_result_end`, per-run `AbortController`-style kill with grace→SIGTERM→cooldown→SIGKILL.
New: `timeout` is a per-call schema param; precedence per-call > manifest > `.ops/config` > env
(`PI_OPS_TIMEOUT_MS`), clamped to ceiling (`PI_OPS_TIMEOUT_CEILING_MS`). Kill ladder constant cooldown (e.g. 5s).
**Alternative:** SDK in-process `createAgentSession` — lower spawn cost but loses per-kind manifest tool whitelisting
and wall-clock isolation; subprocess is battle-tested.

### D3. Config resolution: `.ops/config.json` + env overrides
Capabilities read config from nearest `.ops/` (walk up like `findNearestProjectAgentsDir`), env overrides, then
built-in defaults. Config keys: `timeout`, `timeoutCeiling`, `concurrency`, `maxParallelTasks`, `defaultContract`,
`contractsDir`, `runsDir`, `sessionsDir`, `sessionExpiryMs`, `widgetEngageKey`.
**Rationale:** single source of truth per project without home-dir pollution; all overridable via env for CI/headless.

### D4. Manifest discovery + probe protocol
Reuse `agents.ts` pattern (frontmatter `name`, `description`, `tools`, `model`, `systemPrompt`) from
`~/.pi/agent/agents/` and `.pi/agents/`, merged project-over-user when `agentScope: both`, with confirmation gate for
project agents (auto-accept grace, env-configurable like `PI_SUBAGENT_CONFIRM_MS`). Probe manifests additionally
parse `timeout:`, `thresholds:` (freeform list), and must include the read-only/target-verify/no-fabricate preamble
as a template prepended at run time (not only in manifest) so even user-written manifests inherit the contract —
being a *template* injection, not content rewrite.

### D5. Env contracts (`.ops/contracts/*.md`)
Discovery: nearest `.ops/contracts/`; a `default.md` or config `defaultContract` picks the default; per-call
`contracts: [names]` selects explicitly. Injection mirrors `withSshContext()`: prepend the contract contents plus
"verify target first" to the child's prompt. Gitignore `.ops/contracts/` in the package docs/example.
**Alternative:** keep a single fixed target file type (e.g. connection-line-only naming) — rejected, too narrow
for vendor-agnostic v1.

### D6. Background jobs + durable registry
`run_async` returns immediately with a job id; the worker re-invokes the same runner detached, writing
`runs/<jobId>/{digest,evidence,usage}.md` (+ `meta.json` with spec/status). Registry file `runs/registry.json`
written transactionally (tmp+rename); statuses `queued|running|done|failed|interrupted`; on startup, mark `running`
as `interrupted`; `/ops:jobs` lists; `resume` re-queues from stored spec. Scheduler tick (node `setInterval`, e.g.
10s) evaluates repeat specs `{ "intervalSec" | "at", "spec": <task> }`; only while pi runs.
**Alternative:** OS cron integration — out of scope v1; keep in-pi scheduler.

### D7. Named sessions (pi child session reuse)
Sessions persist in `.ops/sessions/` with key = derivation function
`ops/v1 + parentSessionId + effectiveCwd + agentName + sessionHandle` → opaque id (sha256 truncated), display name
`ops: <agent> · <handle>`. Lock: `<key>.lock` file with mtime heartbeat+pid; stale locks reclaimed on startup (and
optional manual cleanup command). Expiry: mtime > `sessionExpiryMs` (env `. REJECT calls targeting a busy/expired
session with actionable message. Requires persisted parent — reject with guidance when `--no-session`.
Keep alty: named-session support is present upstream in `@mjakl/pi-subagent`; we adopt the same good semantics
(derivation, exclusivity) without code reuse, fit to our runner.

### D8. Fleet cockpit (widget)
Port the proven observability + tabs modules with only name changes (namespace `ops`, widget key `ops-fleet`,
engage key default `Alt+o`), plus: contract-driven auto-follow/pulse defaults; reserved 8 widget lines for
widgets to avoid stealing editor keys; reload-safety via `Symbol.for` tokens; headless guards.

### D9. Artifact agents
Ship `agents/triage.md`, `agents/comms.md`, `agents/pir.md` with JSON-only instruction contracts; validation via
`parseFrontmatter`-adjacent schema object in `artifacts.ts` (manual lightweight structural validation — no new deps);
compose by running them as parallel chain (each its own child, merged well with `subagent` parallel mode; schemas by
`{{schema}}` block in manifest body).

### D10. Package metadata
`package.json`: `name: pi-ops-subagent`, `keywords: ["pi-package"]`, `pi: { extensions: ["./extensions"] }`, peer
deps `@earendil-works/*` + `typebox`, `license: MIT`; README quickstart; versioned tags `v0.0.1`.

## Risks / Trade-offs

- [Subprocess spawn heavy on each call] → caps + concurrency governance; fine for ops cadence; document tradeoff.
- [Schema/strict JSON artifact validation without validator dep] → [custom light structural check + tests]; revisit
  if schema grows.
- [Lockfiles (sessions/jobs) race conditions across pi + headless processes] → [pid+reclaim + tmp+rename writes;
  document manual cleanup command].
- [Nearest-`.ops/` discovery across big trees] → walk-up bounded; fall back to cwd config.

## Migration Plan

Nothing exists yet; no breaking change. Steps: `apply` builds package → local install `pi install -l ./extensions`
→ manually verify with bundled demo agents in a scratch repo (contracts absent → probes run local read-only) →
release v0.0.1 tag → npm publish (if approved) / git install.

## Open Questions

- **Default model tier for artifact agents** — bias to cheaper model (e.g. flash/haiku-class) with override; decide
  in review.
- **Contract versioning** — keep simple: no version field v1; revisit if conflicts arise.
- **Whether to include `triage` composition as a text pipeline vs single chain** — v1: parallel mode; revisit after
  ORCA-style eval rig exists.
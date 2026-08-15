# Design — bootstrap-opssub-agent-plugin

## Context

See `proposal.md` — Why. Base: a proven private production-server diagnostics extension (provenance + porting notes in
the local gitignored notes) which runs `pi --mode json -p --no-session` children with an isolated context and streams
NDJSON events into usage/turns/activity feeds. Its host-specific tab widget intercepted terminal input directly; the
public pi API instead supports passive `setWidget` content, registered shortcuts, streamed tool updates, and focused
`ctx.ui.custom()` overlays. This change generalizes the substrate into a package, replaces the private input hook with
supported APIs, and adds configurable agent discovery, ops protocols, timeouts, jobs, and named sessions.

Constraints from the originating repo: zero runtime deps (peer deps only), reload-safe session lifecycle, TUI creation
only under `ctx.mode === "tui"`, 300-second timeout default with 900-second ceiling, concurrency default 2,
eight parallel tasks maximum, and 51,200-byte/2,000-line output cap. Package layout per `packages.md` (`pi` key in package.json, conventional
`extensions/` loading, peer deps for `@earendil-works/*`, `typebox`).

## Goals / Non-Goals

**Goals**
- A distributable pi package installable globally or per repository from npm, git, or a local path, with no symlink
  setup and no private host-specific behavior.
- An extensible, inspectable agent catalog combining bundled, user, trusted-project, and configured-folder manifests,
  with deterministic precedence and a complete bundled-definition opt-out.
- Full three-mode runner with parent-configurable per-call timeout, kill ladder, abort propagation, caps, usage
  stats — validated against the specs (`subagent-runner`).
- Probe protocol + env contracts as first-class defaults (`probe-protocol`, `env-contracts`).
- Background jobs with durable registry, resumability, and an exact interval/RFC3339 one-shot scheduler
  (`background-jobs`).
- Named sessions with deterministic keying + locking + expiry (`named-sessions`).
- Fleet cockpit widget with keyboard nav + pulse + reload-safety (`fleet-cockpit`).
- Artifact roles `triage`/`comms`/`pir` with strict JSON contracts (`incident-artifacts`).

**Non-Goals (v1)**
- Full cron daemon; restricted ingest adapters (MCP connector later); autonomous remediation execution (gated action
  only); multi-process scheduler outside pi's lifetime; fine-tuning / RAG memory loops (ACE-style playbook evolution
  is post-v1); CLI/daemon mode; UI click support (keyboard only, per pi TUI).

## Implementation-agent contract (DeepSeek V4)

Use `deepseek-v4-pro` with maximum reasoning effort for the apply phase. DeepSeek's official coding-agent setup uses
V4 Pro for the primary agent, V4 Flash for subagents, and maximum effort; its model card shows materially better coding
and agentic results in Max mode. This is an execution setting, not a runtime dependency of this package.

The apply agent SHALL:
1. Read all planning artifacts before editing and implement task groups in numeric order.
2. Treat capability specs as normative; design resolves implementation choices; tasks only sequence the work.
3. Work on one bounded task at a time and run the named focused tests before checking it off.
4. Use exact public field names, units, defaults, state values, and paths from the tables below; do not add aliases.
5. Validate every tool argument in extension code. DeepSeek's API explicitly warns that generated function arguments
   can be invalid or contain undeclared parameters even when a schema is supplied.
6. For JSON-producing artifact agents, include the word `JSON`, the exact schema, and one valid example in the system
   prompt; reject `length`-truncated or schema-invalid output rather than repairing it silently.
7. Leave reasoning-content transport to pi/provider integration. Never parse, log, display, or persist
   `reasoning_content`; DeepSeek V4 requires the harness to preserve it across thinking-mode tool turns.
8. Stop and amend the planning artifacts when a required behavior is unspecified or contradictory instead of choosing
   an implementation implicitly.

Reusable DeepSeek V4 apply prompt (supply one unchecked task id per run):

```text
ROLE
You are the implementation agent for pi-ops-subagent. Work only on OpenSpec change
bootstrap-ops-subagent-plugin.

TASK
Implement task <TASK_ID> exactly. Do not implement later tasks.

AUTHORITATIVE INPUTS, IN ORDER
1. openspec/changes/bootstrap-ops-subagent-plugin/specs/*/spec.md
2. openspec/changes/bootstrap-ops-subagent-plugin/design.md
3. openspec/changes/bootstrap-ops-subagent-plugin/tasks.md
4. pi documentation paths named by the design

PROCESS
1. Read all authoritative inputs, then re-read the requirement and design decision for <TASK_ID>.
2. Inspect existing files and focused tests before editing.
3. Implement the smallest complete change for <TASK_ID>; do not invent aliases, defaults, states, or fallbacks.
4. Add or update the focused test named by the task.
5. Run that focused test and npm run typecheck.
6. If behavior is unspecified or artifacts conflict, stop and report the exact conflict; do not guess.
7. Mark <TASK_ID> complete only after verification passes.

NON-NEGOTIABLE RULES
- Use exact field names, units, paths, ASCII templates, state transitions, and error behavior from the specs.
- Validate model/tool input at runtime; never trust generated arguments.
- Do not expose or persist reasoning_content, credentials, or unredacted secret-like values.
- Do not add runtime dependencies or edit outside this repository.
- Do not output hidden reasoning. Return only changed files, behavior summary, and verification results.

DONE RESPONSE
Task: <TASK_ID>
Changed: <PATHS>
Behavior: <SHORT SUMMARY>
Verification: <COMMANDS AND PASS/FAIL>
Remaining blockers: <NONE OR EXACT BLOCKER>
```

Research references (official):
- Coding-agent setup: `https://api-docs.deepseek.com/guides/coding_agents`
- Thinking mode and tool-turn reasoning transport: `https://api-docs.deepseek.com/guides/thinking_mode`
- JSON output prompting: `https://api-docs.deepseek.com/guides/json_mode`
- Tool/API schema and argument-validation warning: `https://api-docs.deepseek.com/api/create-chat-completion`
- V4 model card and effort benchmarks: `https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash`

## V1 constants and public vocabulary

| Concern | Exact v1 value |
|---|---|
| Tool timeout field | `timeoutSeconds`: integer seconds, minimum 1 |
| Default timeout | 300 seconds |
| Default hard ceiling | 900 seconds |
| Timeout/abort kill cooldown | 5,000 ms between SIGTERM and SIGKILL |
| Parallel concurrency | default 2; configurable range 1-8 |
| Tasks per parallel call | hard maximum 8 |
| Model-visible output cap | 51,200 UTF-8 bytes or 2,000 lines, whichever is reached first |
| Fleet states | `queued`, `starting`, `running`, `finalizing`, `done`, `failed`, `timed_out`, `aborted` |
| Job states | `queued`, `running`, `done`, `failed`, `interrupted`, `canceled` |
| Finished-run retention | 900,000 ms and 50 runs; evict when either limit is exceeded |
| Fleet stale interval | 30,000 ms without a progress event |
| Session expiry | 604,800,000 ms (7 days) idle |
| Session lock heartbeat/stale | heartbeat every 5,000 ms; stale after 30,000 ms plus dead-pid check |
| Scheduler tick | 10,000 ms while the owning pi session runs |
| Persistent project state | `<project>/.ops/{runs,sessions}`; contracts at `<project>/.ops/contracts` |

Use this exact lifecycle diagram in code comments and documentation:

```text
queued --> starting --> running --> finalizing --> done
  |           |           |            |
  +-----------+-----------+------------+--> failed
  +-----------+-----------+------------+--> timed_out
  +-----------+-----------+------------+--> aborted
```

Terminal states have no outgoing transition.

## Decisions

### D1. Extension layout: package `extensions/` dir with `index.ts` + modules
`packages.md` loads `extensions/index.ts`. Exact modules are: `types.ts`/`constants.ts` (shared public vocabulary),
`config.ts`, `catalog.ts`, `tool-schema.ts`, `runner.ts`, `probe.ts`, `probe-profiles.ts`, `contracts.ts`, `jobs.ts`,
`sessions.ts`, `observability.ts`, `tool-renderer.ts`, `fleet-widget.ts`, `fleet-overlay.ts`, and `artifacts.ts`.
`index.ts` only wires registrations/lifecycle. Packaged definitions live under top-level `agents/` and are read by
`catalog.ts`, not declared as independent pi resources. Tests mirror modules under `tests/` and use `tests/fixtures/`.
Use this exact ASCII tree as the scaffold reference (add files; do not rename listed paths):

```text
pi-ops-subagent/
|-- agents/
|   |-- probe-host.md
|   |-- probe-db.md
|   |-- probe-cache.md
|   |-- probe-net.md
|   |-- probe-security.md
|   |-- probe-mail.md
|   |-- probe-kernel.md
|   |-- triage.md
|   |-- comms.md
|   `-- pir.md
|-- extensions/
|   |-- index.ts
|   |-- types.ts
|   |-- constants.ts
|   |-- config.ts
|   |-- catalog.ts
|   |-- tool-schema.ts
|   |-- runner.ts
|   |-- probe.ts
|   |-- probe-profiles.ts
|   |-- contracts.ts
|   |-- jobs.ts
|   |-- sessions.ts
|   |-- observability.ts
|   |-- tool-renderer.ts
|   |-- fleet-widget.ts
|   |-- fleet-overlay.ts
|   `-- artifacts.ts
|-- tests/
|   `-- fixtures/
|-- package.json
|-- tsconfig.json
|-- README.md
`-- LICENSE
```

**Rationale:** keeps discovery testable, prevents TUI imports on headless paths, and allows packaged roles to be
independently disabled while the extension remains active.
**Alternative considered:** single-file extension — rejected for maintainability.

### D2. Runner: reuse `--mode json` subprocess pattern; add `timeoutSeconds` + watchdog
Use ephemeral args `--mode json -p --no-session` plus manifest `--model`/`--tools`. Parse complete NDJSON lines for
`message_end` and `tool_result_end`; ignore unknown event types and retain one bounded diagnostic for malformed lines.
Named-session calls replace `--no-session`: first use creates a child under `--session-dir` and captures its exact
session path; later calls pass `--session <path>`.

Resolve timeout seconds as call `timeoutSeconds` > manifest `timeoutSeconds` > project config `timeoutSeconds` >
`PI_OPS_TIMEOUT_MS / 1000` > 300. Resolve ceiling as project `timeoutCeilingSeconds` >
`PI_OPS_TIMEOUT_CEILING_MS / 1000` > 900, then clamp the timeout. At the deadline send SIGTERM once; after exactly
5,000 ms, if the process has not closed, send SIGKILL once. Parent abort uses the same ladder and ends as `aborted`.

Error contract: malformed tool input, unknown agent, invalid mode combinations, and more than eight parallel tasks
throw before spawning. Once any child has started, the tool returns structured per-run outcomes; a failed child does
not discard successful siblings or collected details. Never return a top-level `isError` field because pi marks tool
errors only when `execute` throws.
**Alternative:** SDK in-process `createAgentSession` — lower spawn cost but loses per-kind manifest tool whitelisting
and wall-clock isolation; subprocess is battle-tested.

### D3. Config resolution: exact `.ops/config.json` schema
Find the nearest `.ops/config.json` while walking from `ctx.cwd` to the filesystem root. If absent, use
`<ctx.cwd>/.ops` as the state root without creating it until a write is required. Reject unknown keys and wrong types
with file/key diagnostics. All directory fields and `agentDirs` entries resolve against the directory containing the
config file; absolute paths remain absolute.

| Key | Type | Default | Validation |
|---|---|---:|---|
| `timeoutSeconds` | integer | 300 | 1..`timeoutCeilingSeconds` before clamp |
| `timeoutCeilingSeconds` | integer | 900 | >= 1 |
| `concurrency` | integer | 2 | 1..8 |
| `includeBundledAgents` | boolean | true | exact boolean |
| `agentDirs` | string[] | `[]` | non-empty unique paths |
| `defaultContract` | string or null | null | manifest-name pattern |
| `contractsDir` | string | `contracts` | path relative to `.ops/config.json` |
| `runsDir` | string | `runs` | path relative to `.ops/config.json` |
| `sessionsDir` | string | `sessions` | path relative to `.ops/config.json` |
| `sessionExpiryMs` | integer | 604800000 | >= 60000 |
| `fleetShortcut` | string | `alt+o` | pi key format |
| `fleetWidgetLines` | integer | 3 | 1..8 |
| `fleetRetentionMs` | integer | 900000 | >= 0; 0 disables age retention after completion |
| `fleetRetentionCount` | integer | 50 | 0..500; 0 removes completed runs immediately |
| `fleetStaleAfterMs` | integer | 30000 | >= 5000 |

Project-local configuration and directories are honored only when `ctx.isProjectTrusted()` is true. Code uses
`CONFIG_DIR_NAME` for the conventional project agent folder. Project-agent approvals live at
`<getAgentDir()>/pi-ops-subagent/trust.json`, keyed by project root/path/SHA-256; `PI_OPS_ALLOW_PROJECT_AGENTS=1` is
the only headless override. Repo-controlled configuration cannot approve itself.
**Rationale:** an exact, inspectable policy prevents typo-driven silent fallbacks and removes per-call source choices.

### D4. Agent catalog, precedence, and probe protocol
Build on the pi subagent example's frontmatter parser, but discover fresh from four source classes: packaged
`agents/*.md`, `~/.pi/agent/agents/*.md`, nearest trusted `${CONFIG_DIR_NAME}/agents/*.md`, and each trusted
`agentDirs` entry. Configured directories are ordered and later entries win; source precedence is configured > project
> user > bundled. Retain winning and shadowed provenance in catalog diagnostics. `includeBundledAgents: false` skips
package definitions before merging, so custom-only operation does not require removing package files.

Scan only direct `*.md` children (non-recursive), sorted by canonical path. Required frontmatter is `name` (pattern
`^[a-z][a-z0-9-]{0,63}$`) and `description` (non-empty string). Optional fields are `kind` (`general|probe|artifact`,
default `general`), `tools` (comma-separated string or string array), `model` (string), `timeoutSeconds` (positive
integer), `thresholds` (array of threshold objects defined by `probe-protocol`), and `contract` (manifest-name string).
Reject unknown keys, duplicate names within one directory, empty prompts, and invalid field types; isolate malformed
files and surface diagnostics through `/ops:agents`. Refresh at startup, reload, and invocation. Remember approval by
project root + canonical path + content hash in user state, so changed project-controlled content invalidates approval;
headless mode fails closed unless a user-controlled trust policy or CI environment override explicitly allows it.
Probe roles receive the read-only/target-verify/no-fabricate preamble at runtime so custom probe definitions inherit
the protocol without rewriting their files. Probe children do not receive built-in `bash`, `write`, or `edit`; custom
`probe_exec` accepts only registered profile name + argument array + target id, maps the profile to a fixed executable,
rejects unknown/shell/mutation arguments, and spawns with `shell: false`. Target credentials must independently be least-privilege because client-side
classification is defense in depth, not a production authorization boundary.
**Alternative:** expose the example's per-call `agentScope` as the primary control. Rejected because it is repetitive,
hides effective source policy from users, and does not support packaged definitions or arbitrary local folders.

### D5. Env contracts (`.ops/contracts/*.md`)
Discover direct files from configured `contractsDir`. Resolve selection as explicit call `contracts` > manifest
`contract` > config `defaultContract` > none, exactly as the spec; there is no filename-based implicit default.
Validate version-1 contracts as non-secret context, reject credential-like literals,
and prepend only target identity, profile/handle references, naming, baselines, and "verify target first" to the child
prompt. Connector code resolves credentials from environment/user stores outside model context and redacts them from
observability/artifacts. Gitignore `.ops/contracts/` because topology can still be sensitive, not because plaintext
credentials are allowed.
**Alternative:** inject connection strings or credentials from markdown as in the private extension. Rejected because
model prompts, session files, logs, and run artifacts are not secret stores.

### D6. Background jobs + durable registry
`runAsync: true` returns a job id immediately and runs under the owning pi process. Write
`<runsDir>/<jobId>/{digest.md,evidence.jsonl,usage.json,meta.json}` and transactionally replace
`<runsDir>/registry.json` via same-directory temp file + rename. States are
`queued|running|done|failed|interrupted|canceled`; startup changes stale `running` records to `interrupted` because v1
does not adopt an unknown process. Resume creates a new job id with `resumedFromJobId`; it never overwrites artifacts.
Cancel sends the runner kill ladder and ends as `canceled`.

Schedules accept exactly one of `{ "intervalSec": integer >= 60 }` or `{ "at": RFC3339 timestamp }`. A 10,000 ms
tick runs only while pi is alive. Persist `nextRunAt`; on startup, fire an overdue interval once and advance from the
current time, while an overdue one-shot fires once. Cron syntax is not supported in v1.
**Alternative:** OS cron integration — out of scope v1; keep in-pi scheduler.

### D7. Named sessions (pi child session reuse)
Sessions persist under effective `sessionsDir` (default `<project>/.ops/sessions`) with key = derivation function
`ops/v1 + parentSessionId + effectiveCwd + agentName + sessionHandle` → opaque id (sha256 truncated), display name
`ops: <agent> · <handle>`. On first use spawn with the dedicated `--session-dir` and `--name`, capture the created child
session path in metadata, and on continuation pass that exact path via `--session`. Lock with `<key>.lock` containing
pid plus an mtime heartbeat; reclaim stale locks on startup and via cleanup command. If idle mtime exceeds
`sessionExpiryMs`, mark the old child session expired and create a fresh one on the next call. Reject busy sessions
with an actionable message. A named child requires a persisted parent; reject with ephemeral-call guidance when the
parent uses `--no-session`.
**Alternative:** reuse upstream `@mjakl/pi-subagent` named-session behavior. Rejected as a dependency, but its
well-defined derivation and exclusivity semantics are retained.

### D8. Fleet observability: passive widget + focused overlay
Normalize child events into immutable snapshots keyed by run id. The registry tracks queued/starting/running/
finalizing/done/failed/timed_out/aborted, source provenance, task label, timing/deadline, queue reason, last progress,
bounded redacted activity/output tails, digest, usage, and cost. Feed the same snapshots to four surfaces:

1. `onUpdate`-driven custom tool rendering for progress in the transcript.
2. A small passive `ctx.ui.setWidget("ops-fleet", ...)` summary that never captures keys.
3. A focused `ctx.ui.custom(..., { overlay: true })` fleet view opened by `pi.registerShortcut` (default `Alt+o`).
4. `/ops:status` and structured details for headless/RPC consumers.

Renderers copy the normative ASCII-only templates from `specs/fleet-cockpit/spec.md`; they substitute/truncate
placeholders and apply theme colors but do not redesign separators, labels, status tags, or responsive breakpoints.
Only the overlay handles Tab/arrows/digits/scroll keys, using `matchesKey`; closing restores editor focus. Use
`ctx.mode === "tui"` for the overlay/component factory and `ctx.hasUI` only for notifications/widget methods that also
exist in RPC. Use defaults of 3 widget lines, 30 seconds to stale, 15 minutes/50 completed runs retained, and `Alt+o`.
Apply lifecycle transitions only as follows: `queued→starting→running→finalizing→done`; any non-terminal state may move
to `failed`, `timed_out`, or `aborted`; terminal states never transition. Dismissal/retention removes display entries
but does not mutate durable job records. Issue notifications only for `failed`, `timed_out`, and `aborted` background
or non-focused runs.
Session-scoped timers start on `session_start` and stop on `session_shutdown`; do not use the private
`onTerminalInput` hook or passive Ctrl+Tab interception.
**Alternative:** make the persistent widget itself interactive. Rejected because `setWidget` is not a focused input
surface and global terminal interception steals editor/application keys.

### D9. Artifact agents
Ship `agents/triage.md`, `agents/comms.md`, and `agents/pir.md` with `kind: artifact`. Each prompt explicitly requests
`JSON`, embeds its complete v1 schema and one valid example, forbids markdown fences/prose, and maps unknown scalar
values to the string `UNKNOWN`. `artifacts.ts` parses once with `JSON.parse`, validates every required key/type/enum and
`additionalProperties: false`, and fails without heuristic repair. A `length` stop reason is always failure. Compose
requested artifacts concurrently and return an object keyed by `triage`, `comms`, and/or `pir`; one invalid artifact
does not discard valid siblings.

### D10. Package metadata and installation
`package.json`: `name: pi-ops-subagent`, `keywords: ["pi-package"]`, `pi: { extensions: ["./extensions"] }`, peer
deps `@earendil-works/*` + `typebox`, dev deps `typescript`, `tsx`, and `@types/node`, `license: MIT`; scripts
`test: "tsx --test tests/*.test.ts"` and `typecheck: "tsc --noEmit"`; README quickstart; versioned tag `v0.0.1`.
Document and test
all supported package forms: user install (`pi install <source>`), repository install (`pi install -l <source>`),
and project-local development from the package root (`pi install -l .`). Local paths point at the checkout and are
not copied, so `/reload` is sufficient after source edits. Do not instruct users to install `./extensions` or create
symlinks, because that bypasses package metadata and bundled definitions.

## Risks / Trade-offs

- [Subprocess spawn heavy on each call] → caps + concurrency governance; fine for ops cadence; document tradeoff.
- [Schema/strict JSON artifact validation without validator dep] → [custom light structural check + tests]; revisit
  if schema grows.
- [Lockfiles (sessions/jobs) race conditions across pi + headless processes] → [pid+reclaim + tmp+rename writes;
  document manual cleanup command].
- [Nearest-`.ops/` discovery across big trees] → walk-up bounded; fall back to cwd config.
- [Custom agent collisions or stale approvals hide which prompt ran] → retain canonical provenance, expose shadowed
  definitions in `/ops:agents`, and invalidate approval when project-controlled content changes.
- [Observability leaks secrets or overwhelms the terminal] → redact credential-like fields, bound logs/tails/history,
  keep the passive widget compact, and move details into a focused overlay.

## Migration Plan

Nothing exists yet; no breaking change. Steps: `apply` builds package → from a scratch trusted repository run
`pi install -l /absolute/path/to/pi-ops-subagent` (or `pi install -l .` when testing in this repository) → verify
bundled defaults → add a project and configured-folder agent → verify precedence and trust → set
`includeBundledAgents: false` and verify custom-only operation → exercise passive/tool/overlay/headless observability →
release v0.0.1 tag → npm publish (if approved) / git install. Rollback is `pi remove -l <source>` or removing the
project package entry.

## Open Questions

None for v1. Artifact manifests omit `model` and inherit the dispatching model unless a user override supplies one;
contracts require `version: 1`; multi-artifact composition uses parallel independent children with partial success.
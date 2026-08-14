# Tasks

<!-- Implementation checklist for bootstrap-ops-subagent-plugin (pi-ops-subagent) -->

## 1. Package scaffolding

- [ ] 1.1 `package.json` with name `pi-ops-subagent`, `keywords: ["pi-package"]`, `pi: { extensions: ["./extensions"] }`, peer deps (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`), MIT license
- [ ] 1.2 `.gitignore` for `.ops/contracts/`, `.ops/sessions/`, `runs/`, `node_modules/`, local state
- [ ] 1.3 README quickstart (install, `.ops/` layout, sample probe run, contract example, jobs + sessions examples, security model)
- [ ] 1.4 `tsconfig.json` aligned with pi extension conventions; `npm run typecheck` wired

## 2. Agent manifest discovery (agents.ts)

- [ ] 2.1 Port `agents.ts` from the inspection extension (frontmatter parse, user/project scopes, project-over-user with `both`, nearest-`.pi/agents` walk-up)
- [ ] 2.2 Extend manifest parsing with `timeout:`, `thresholds:`, `contract:` defaults
- [ ] 2.3 Confirm-gate for project agents (auto-accept grace, env override) — reuse proven dialog pattern

## 3. Runner core (index.ts + spawn)

- [ ] 3.1 Port `runSingleAgent` runner (spawn `pi --mode json -p --no-session`, NDJSON event parsing, messages/usage/turns/stopReason accumulation, `PI_*` env passthrough, GetPiInvocation fallback)
- [ ] 3.2 Single mode: `{ agent, task, timeout?, contract?, cwd? }`
- [ ] 3.3 Parallel mode: `tasks[]` with concurrency governor (default 2), max 8 tasks, per-task output cap 50 KB with truncation marker
- [ ] 3.4 Chain mode: sequential, `{previous}` substitution, stop-at-first-failure with step reporting
- [ ] 3.5 Timeout ladder: precedence per-call > manifest > config > env (`PI_OPS_TIMEOUT_MS`), ceiling clamp (`PI_OPS_TIMEOUT_CEILING_MS`), grace → SIGTERM → cooldown → SIGKILL
- [ ] 3.6 Abort propagation wired to the tool's `signal`; SIGKILL after grace
- [ ] 3.7 Usage/cost/details payload on result (turns, tokens, cache, cost, model, stopReason, errorMessage)
- [ ] 3.8 Error taxonomy: unknown agent, invalid mode combos, too-many-parallel, timeout, aborted — returned as `isError` with details

## 4. Probe protocol (template + role manifests)

- [ ] 4.1 Probe preamble template (read-only rules, target-verify-first, evidence-only, no-fabricate, thresholds flagged) injected at run time
- [ ] 4.2 Bundled role manifests: `probe-host`, `probe-db`, `probe-cache`, `probe-net`, `probe-security`, `probe-mail`, `probe-kernel` (read-only toolsets, thresholds, evidence-only output)
- [ ] 4.3 Gated-action helper (mutation proposals surfaced for explicit approval; never executed)

## 5. Env contracts (contracts.ts)

- [ ] 5.1 Discovery of nearest `.ops/contracts/*.md`; `default.md`/`defaultContract` selection; per-call `contracts: []`
- [ ] 5.2 Injection into child prompt (prepend + "verify target first" instruction) before task
- [ ] 5.3 Graceful absence (no contract → task unchanged, no error); multi-contract selection validation
- [ ] 5.4 Docs for writing contracts (naming conventions, runbook pointers, baselines)

## 6. Background jobs (jobs.ts)

- [ ] 6.1 `run_async` param (single/parallel/chain) → returns job id; worker re-invokes runner detached; writes `runs/<jobId>/{digest,evidence,usage,meta.json}`
- [ ] 6.2 Durable registry `runs/registry.json` (tmp+rename writes; statuses queued/running/done/failed/interrupted; startup reconciliation)
- [ ] 6.3 `/ops:jobs` command (list, inspect, resume, cancel); `resume` re-queues from stored spec
- [ ] 6.4 Scheduler: repeat specs `intervalSec` / `at` evaluated on pi tick (10s) — opt-in, no schedule = no re-queue; persistence of schedule records

## 7. Named sessions (sessions.ts)

- [ ] 7.1 Derivation: `ops/v1 + parentSessionId + cwd + agent + handle` → opaque id (sha256 trunc); display `ops: agent · handle`
- [ ] 7.2 Persistence dir `.ops/sessions/`; session `created` metadata on first use
- [ ] 7.3 Lock file (pid/mtime heartbeat) + exclusive use; stale lock reclaim on startup
- [ ] 7.4 Expiry (mtime > `sessionExpiryMs`, env override); `--no-session` parent → actionable rejection with ephemeral guidance
- [ ] 7.5 `/ops:session` command: list, info, end/cleanup

## 8. Fleet cockpit (observability.ts + tabs.ts)

- [ ] 8.1 Port registry + widget pump with `Symbol.for` reload tokens; widget key `ops-fleet`; engage key `Alt+o` (configurable) + passive Ctrl+Tab/Shift+Tab cycling
- [ ] 8.2 Port tabs renderer (strip, summary, per-agent body: phase/elapsed/toolCalls/lastActivity/activityLog/outputLog/digest; scroll when expanded)
- [ ] 8.3 Keyboard map: `←→`/`Tab`, `1-9`, `Enter`, `Esc`, `s`, `f`, `↑↓`/`PgUp`/`PgDn`, `q`/`Alt+o`
- [ ] 8.4 Auto-follow newest active + pulse non-focused on activity; `ctx.hasUI`/headless guards; detach on `session_shutdown`
- [ ] 8.5 `snapshot()` API for tests/details

## 9. Artifact agents (artifacts.ts + manifests)

- [ ] 9.1 Bundled manifests `triage` (hypotheses+evidence+confidence+actions+runbook), `comms` (Slack+stakeholder), `pir` (timeline, impact, prevention) with JSON-only contracts + guardrails (no-secrets, `UNKNOWN`, missing-information)
- [ ] 9.2 Lightweight structural schema validation (no new deps); required-keys + type checks; malformed → failed result with validation error
- [ ] 9.3 Parallel composition (triage+comms+pir concurrently, merged result)

## 10. Verification + hardening

- [ ] 10.1 Headless/`--mode json` full-path smoke test (single/parallel/chain, timeout clamp, abort, timeout kill)
- [ ] 10.2 Widget test: start/stop/pulse/expand/scroll; reload-safety (double `/reload` no dupes); detach on shutdown/empty
- [ ] 10.3 Sessions: create/continue/expire/reject-concurrent; lock reclaim after crash
- [ ] 10.4 Jobs: async run, restart reconciliation, resume, schedule fires/doesn't re-queue once; artifact files + registry valid
- [ ] 10.5 Contracts: default picked, injection prepends, absent works; naming-convention guidance visible in child
- [ ] 10.6 Typecheck + lint clean; README updated with real usage; docs images optional
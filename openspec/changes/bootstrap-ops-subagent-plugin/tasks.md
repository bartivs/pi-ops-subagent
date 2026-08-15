# Tasks

<!-- Execute in numeric order. Do not check a task until its stated focused test passes. -->

## 1. Package and test scaffolding

- [x] 1.1 Create `package.json` with the exact D10 package metadata, peer/dev dependencies, `pi.extensions`, `test`, and `typecheck` scripts; verify `npm install` succeeds
- [x] 1.2 Create `tsconfig.json`, `extensions/index.ts`, module placeholders from D1, and `tests/`; verify `npm run typecheck` succeeds on the scaffold
- [x] 1.3 Create `.gitignore` entries for `node_modules/`, `.ops/contracts/`, `.ops/runs/`, `.ops/sessions/`, temporary files, and coverage; verify fixture files under `tests/fixtures/` remain trackable
- [x] 1.4 Add shared exact types/constants in `extensions/types.ts` and `extensions/constants.ts` for v1 states, defaults, caps, and public field names; add `tests/constants.test.ts`

## 2. Configuration and agent catalog

- [x] 2.1 Implement nearest `.ops/config.json` discovery, strict-key/type/range validation, path resolution, environment parsing, and defaults in `extensions/config.ts`; pass `tests/config.test.ts`
- [x] 2.2 Implement direct/non-recursive deterministic source scanning and exact manifest normalization in `extensions/catalog.ts`; pass valid, nested-file, unknown-key, duplicate-name, and malformed-file cases in `tests/catalog.test.ts`
- [x] 2.3 Implement source precedence, winning/shadowed provenance, `includeBundledAgents`, and immutable invocation snapshots in `extensions/catalog.ts`; pass collision/order/edit-between-calls tests
- [x] 2.4 Implement project trust exclusion plus SHA-256 approval persistence at user-controlled `trust.json`, changed-content reapproval, and `PI_OPS_ALLOW_PROJECT_AGENTS`; pass `tests/catalog-trust.test.ts`
- [x] 2.5 Register `/ops:agents` in `extensions/index.ts` with all required catalog/config/diagnostic fields and actionable unknown/empty-agent errors; snapshot-test output in `tests/catalog-command.test.ts`

## 3. Runner and `subagent` tool

- [x] 3.1 Define strict TypeBox schemas in `extensions/tool-schema.ts` for the exact three mode shapes/common fields, `additionalProperties: false`, and explicit mode/unit/default/bound/dependency descriptions; test schema text plus invalid/mixed/empty/>8 inputs in `tests/tool-schema.test.ts`
- [x] 3.2 Implement invocation lookup, temporary system-prompt files with mode `0600`, ephemeral child args, direct `spawn`, complete-line NDJSON parsing, and cleanup in `extensions/runner.ts`; pass single-run fixtures in `tests/runner.test.ts`
- [x] 3.3 Implement timeout/ceiling precedence, requested/effective/clamped details, and the exact 5,000 ms TERM→KILL ladder for timeout/abort in `extensions/runner.ts`; pass fake-timer/process tests in `tests/runner-timeout.test.ts`
- [x] 3.4 Implement `run-<UUID v4>` snapshots, exact lifecycle transitions, provenance/timing/activity fields, malformed/unknown event diagnostics, and immutable terminal state in `extensions/observability.ts` + `runner.ts`; pass `tests/run-state.test.ts`
- [x] 3.5 Implement usage parsing/aggregation and 51,200-byte/2,000-line UTF-8-safe digest truncation with exact omission marker/path in `extensions/runner.ts`; pass `tests/runner-output.test.ts`
- [x] 3.6 Implement deterministic concurrency queue and parallel result ordering in `extensions/runner.ts`; pass five-tasks/concurrency-two, queued-abort, and mixed-success tests in `tests/runner-parallel.test.ts`
- [x] 3.7 Implement chain `{previous}` substitution, bounded digest handoff, and stop-after-first-non-done behavior in `extensions/runner.ts`; pass `tests/runner-chain.test.ts`
- [x] 3.8 Register the `subagent` tool in `extensions/index.ts`, stream complete snapshots through `onUpdate`, throw only preflight errors, and preserve structured sibling failures; pass `tests/subagent-tool.test.ts`

## 4. Probe protocol and diagnostic executor

- [x] 4.1 Add `kind: probe` runtime preamble and effective-tool narrowing in `extensions/probe.ts`; test that probe children exclude `bash`, `write`, and `edit` while general agents are unchanged
- [x] 4.2 Define registered read-only diagnostic profiles and fixed executable/argument validators in `extensions/probe-profiles.ts`; document each accepted argument/subcommand in code and tests
- [x] 4.3 Implement strict `{profile,args,target}` `probe_exec` with no arbitrary executable, `shell: false`, policy denial evidence, abort, timeout, and output bounds in `extensions/probe.ts`; pass `tests/probe-exec.test.ts`, including shell/redirection/restart/install/delete bypass attempts
- [x] 4.4 Implement verify-profile-first state and exact expected/observed identity matching with no local fallback in `extensions/probe.ts`; pass correct, mismatch, diagnostic-before-verify, and no-contract cases
- [x] 4.5 Implement threshold object validation, unit normalization, exact operators, `not_evaluated`, and evidence-linked digest sections in `extensions/probe.ts`; pass `tests/probe-thresholds.test.ts`
- [x] 4.6 Add bundled `agents/probe-{host,db,cache,net,security,mail,kernel}.md` using exact manifest schema/tool policy and proposal-only actions; validate all through `tests/bundled-agents.test.ts`

## 5. Environment contracts

- [x] 5.1 Implement direct-file discovery and exact version-1 frontmatter validation in `extensions/contracts.ts`; pass path/version/unknown-key/duplicate/nested-file tests in `tests/contracts.test.ts`
- [x] 5.2 Implement contract selection precedence, unique 0-4 list, existence checks, and multi-contract target/profile compatibility in `extensions/contracts.ts`; pass explicit/manifest/config/none/conflict tests
- [x] 5.3 Implement literal-secret scanning with allowed placeholders and redacted file/line/category diagnostics before spawn; pass private-key/auth/password/token/URI/false-positive fixtures in `tests/contracts-secrets.test.ts`
- [x] 5.4 Implement ordered `<ops_contract>` and unchanged `<delegated_task>` prompt assembly plus selected path/hash details in `extensions/contracts.ts`; exact-string test `tests/contracts-injection.test.ts`

## 6. Background jobs and scheduler

- [x] 6.1 Implement effective `runsDir`, version-1 registry types, strict parser, mode-`0600` artifacts, and temp+fsync+rename writes in `extensions/jobs.ts`; pass create/update/custom-path/corrupt-registry tests in `tests/jobs-registry.test.ts`
- [x] 6.2 Implement `runAsync` durable-before-return queueing, owner pid, state transitions, startup `running→interrupted` reconciliation, and partial artifacts in `extensions/jobs.ts`; pass `tests/jobs-runner.test.ts`
- [x] 6.3 Implement `/ops:jobs list|inspect|resume|cancel`, unique resume ids/`resumedFromJobId`, preserved prior artifacts, and cancel kill ladder in `extensions/index.ts` + `jobs.ts`; pass `tests/jobs-command.test.ts`
- [x] 6.4 Implement exact `intervalSec`/RFC3339 `at` validation, persisted `nextRunAt`, 10,000 ms tick, overdue-once behavior, and no cron support in `extensions/jobs.ts`; pass fake-clock tests in `tests/jobs-scheduler.test.ts`

## 7. Named child sessions

- [x] 7.1 Implement handle validation and NUL-joined SHA-256 derivation in `extensions/sessions.ts`; pass deterministic/distinct/invalid-handle vectors in `tests/sessions-key.test.ts`
- [x] 7.2 Implement effective `sessionsDir`, versioned `<sessionsDir>/<key>/meta.json`, first-use `--session-dir`/`--name`, child-path capture, and continuation `--session <path>` in `extensions/sessions.ts` + `runner.ts`; pass create/continue/custom-path/missing-child tests
- [x] 7.3 Implement atomic `lock.json`, 5,000 ms heartbeat, 30,000 ms + dead-pid reclaim rule, live-owner refusal, and `finally` cleanup in `extensions/sessions.ts`; pass fake-clock/pid tests in `tests/sessions-lock.test.ts`
- [x] 7.4 Implement 7-day default expiry, explicit `restartExpired`, ended/expired metadata retention, and persisted-parent preflight in `extensions/sessions.ts`; pass `tests/sessions-lifecycle.test.ts`
- [x] 7.5 Implement `/ops:session list|info|end|cleanup` with live-lock refusal and required fields in `extensions/index.ts`; snapshot-test `tests/sessions-command.test.ts`

## 8. Fleet observability and TUI

- [x] 8.1 Complete bounded/redacted activity (200 events) and output-tail (100 lines × 2,000 bytes) storage, stale flagging, retention/dismissal, and snapshot API in `extensions/observability.ts`; pass `tests/observability.test.ts`
- [x] 8.2 Implement compact/expanded `renderCall`/`renderResult` in `extensions/tool-renderer.ts` by copying the normative ASCII tool-row template and substituting/truncating placeholders only; snapshot-test exact output in `tests/tool-renderer.test.ts`
- [x] 8.3 Implement passive `ops-fleet` widget in `extensions/fleet-widget.ts` by copying the normative 3-line/very-narrow ASCII templates, exact status tags, width-safe placeholders, no input handler, and active/retained aggregates; pass exact snapshots in `tests/fleet-widget.test.ts`
- [x] 8.4 Implement configurable `Alt+o` focused overlay in `extensions/fleet-overlay.ts` by copying the normative wide/narrow/very-narrow ASCII templates and 100/40 breakpoints, with scoped keys, live refresh, dismissal, and focus restoration; pass exact snapshots in `tests/fleet-overlay.test.ts`
- [x] 8.5 Implement failure/timeout/abort notifications, `/ops:status`, JSON/print/RPC snapshots, `ctx.mode === "tui"` gates, and session shutdown/reload cleanup in `extensions/index.ts`; pass `tests/observability-lifecycle.test.ts`

## 9. Incident artifact agents

- [x] 9.1 Define exact shared/triage/comms/PIR validators with required keys, enums, ranges, evidence-id checks, and additional-property rejection in `extensions/artifacts.ts`; pass `tests/artifact-schema.test.ts`
- [x] 9.2 Add `agents/{triage,comms,pir}.md` with `kind: artifact`, explicit JSON instruction, full matching schema, one valid example, no-fence/no-prose rule, and `UNKNOWN` behavior; validate prompt/schema synchronization in `tests/artifact-prompts.test.ts`
- [x] 9.3 Implement one-pass JSON parse, `length` failure, no heuristic repair, pre-persistence redaction/counting, and clear validation diagnostics in `extensions/artifacts.ts`; pass malformed/truncated/secret fixtures
- [x] 9.4 Implement parallel composition with `{status,artifact|error}` per requested type and partial-success preservation in `extensions/artifacts.ts`; pass `tests/artifact-composition.test.ts`

## 10. Integration, installation, and documentation

- [x] 10.1 Add integration tests for foreground single/parallel/chain with catalog, contracts, probe policy, timeout, abort, output cap, usage, and observability; pass `tests/integration-foreground.test.ts`
- [x] 10.2 Add integration tests for async registry restart/resume/cancel/schedule and named session create/continue/expire/lock reclaim; pass `tests/integration-persistence.test.ts`
- [x] 10.3 Add TUI/headless integration tests: widget never captures editor keys, overlay lifecycle/width, double `/reload` no duplicates, shutdown cleanup, and no TUI calls in JSON/print; pass `tests/integration-ui.test.ts`
- [x] 10.4 Write README exact install commands for npm/git/local paths at user/project scope, `.ops/config.json` table/example, strict custom-agent and contract examples, bundled opt-out, trust/secret/read-only limitations, and `/ops:*` usage
- [x] 10.5 Smoke-test `pi install <absolute-local-path>` and `pi install -l <absolute-local-path>` in scratch projects; verify package metadata loads extension/bundled agents without symlinks or copies
- [x] 10.6 Run `npm test`, `npm run typecheck`, and `openspec validate bootstrap-ops-subagent-plugin --strict`; do not complete while any command fails

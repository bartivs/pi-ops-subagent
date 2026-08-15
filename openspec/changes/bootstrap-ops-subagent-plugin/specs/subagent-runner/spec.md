## Purpose

Core delegation runtime for pi-ops-subagent: spawn isolated `--mode json` pi children in exactly one of single,
parallel, or chain mode, with deterministic validation, timeouts, lifecycle details, usage accounting, output bounds,
and abort propagation.

## ADDED Requirements

### Requirement: Exact subagent invocation modes
The `subagent` tool SHALL accept exactly one mode shape. Single mode requires non-empty `agent` and `task` strings and
allows top-level `cwd`. Parallel mode requires `tasks` containing 1-8 `{agent, task, cwd?}` objects. Chain mode requires
`chain` containing 1-8 `{agent, task, cwd?}` objects. Common optional fields are `timeoutSeconds`, `contracts`,
`session`, `restartExpired`, `runAsync`, and `schedule`. `schedule` requires `runAsync: true`; `restartExpired` requires
`session`. Unknown fields, empty arrays, invalid dependent fields, and mixed mode fields SHALL be rejected before spawn. Tool and
property descriptions SHALL name the mode, units, default/limits, and dependency rules so a tool-calling model need not
infer them.

#### Scenario: Self-describing schema
- **WHEN** pi exposes the `subagent` tool definition to a model
- **THEN** its description states exactly-one-mode and each numeric/conditional field states units, bounds, and dependencies

#### Scenario: Single delegation
- **WHEN** the tool receives `{agent, task}` and no `tasks` or `chain`
- **THEN** exactly one child runs and the result contains that child's bounded final digest and structured details

#### Scenario: Parallel delegation
- **WHEN** the tool receives 1-8 parallel tasks
- **THEN** tasks run in input order subject to the concurrency governor and results are returned in input order regardless of completion order

#### Scenario: Chained delegation
- **WHEN** the tool receives 1-8 chain steps
- **THEN** steps run sequentially, every `{previous}` occurrence is replaced with the prior bounded digest, and execution stops after the first non-`done` step

#### Scenario: Invalid mode shape
- **WHEN** no mode, multiple modes, an empty mode array, an unknown field, or more than eight items is supplied
- **THEN** tool execution throws a validation error before any child or job is created

### Requirement: Isolated child process and context
Each task SHALL run in a separate pi subprocess and isolated context. Ephemeral calls SHALL use
`--mode json -p --no-session`; named calls SHALL use the named-session behavior. Child tool events and reasoning
content SHALL NOT enter parent model context. Only bounded digest text is model-visible; structured details are
extension/session metadata.

#### Scenario: Context isolation
- **WHEN** a child performs multiple model and tool turns
- **THEN** intermediate assistant text, reasoning content, tool calls, and tool results remain outside parent model-visible content

#### Scenario: Sibling isolation
- **WHEN** parallel tasks run
- **THEN** no task receives another task's prompt, events, tool results, or digest

### Requirement: Timeout resolution in seconds
The public tool and manifest field SHALL be `timeoutSeconds`, an integer >= 1. Effective timeout precedence SHALL be
call `timeoutSeconds` > manifest `timeoutSeconds` > project config `timeoutSeconds` >
`PI_OPS_TIMEOUT_MS / 1000` > 300 seconds. Effective ceiling precedence SHALL be project
`timeoutCeilingSeconds` > `PI_OPS_TIMEOUT_CEILING_MS / 1000` > 900 seconds. Environment millisecond values SHALL be
positive integers divisible by 1000. The effective timeout SHALL be clamped to the effective ceiling.

#### Scenario: Per-call override
- **WHEN** a call supplies `timeoutSeconds: 90`
- **THEN** every child in that call uses a 90-second deadline

#### Scenario: Manifest fallback
- **WHEN** the call omits `timeoutSeconds` and the selected manifest declares `timeoutSeconds: 300`
- **THEN** the effective timeout is 300 seconds

#### Scenario: Ceiling clamp
- **WHEN** the requested timeout is 1200 seconds and the ceiling is 900 seconds
- **THEN** details report requested 1200, effective 900, and `timeoutClamped: true`

#### Scenario: Invalid environment timeout
- **WHEN** an environment timeout is non-numeric, non-positive, or not divisible by 1000
- **THEN** configuration loading reports the variable and uses the next fallback without spawning from an invalid explicit call

### Requirement: Deterministic termination ladder
At timeout or parent abort, the runner SHALL send SIGTERM to each live child exactly once, wait 5,000 ms, and send
SIGKILL exactly once to any child that has not emitted `close`. It SHALL remove signal listeners and timers after
`close`. Timeout ends as `timed_out`; parent abort ends as `aborted`; partial digest and termination events remain in
details.

#### Scenario: Timeout exits after TERM
- **WHEN** a child reaches its deadline and closes within 5,000 ms of SIGTERM
- **THEN** no SIGKILL is sent and its terminal state is `timed_out`

#### Scenario: Timeout requires KILL
- **WHEN** a timed-out child remains open 5,000 ms after SIGTERM
- **THEN** SIGKILL is sent once and details record both escalation timestamps

#### Scenario: Parent abort affects all live children
- **WHEN** the parent signal aborts a parallel call
- **THEN** every running child enters the same termination ladder, queued tasks never spawn, and no child remains alive

### Requirement: Structured run details
Every task SHALL receive `runId` formatted `run-<UUID v4>`. Partial and final details SHALL contain: `runId`, mode,
input index/chain step, agent name, agent source kind, canonical manifest path, task label, effective cwd, lifecycle
state, queue reason, requested/effective timeout seconds, clamp flag, model, ISO-8601 start/finish/last-activity
timestamps, elapsed milliseconds, stop reason, redacted error message, usage, and optional result-artifact path.

#### Scenario: Progress update
- **WHEN** a run queues, starts, emits a child tool event, begins finalization, or terminates
- **THEN** `onUpdate` publishes the complete latest snapshot for that run id

#### Scenario: Definition provenance
- **WHEN** a project or configured-directory agent runs
- **THEN** final details identify the source kind and canonical selected manifest path

#### Scenario: Unknown child event
- **WHEN** the NDJSON stream contains an unknown event type
- **THEN** execution continues and a bounded diagnostic is recorded without treating the event as model-visible output

### Requirement: Exact lifecycle transitions
A run SHALL transition only `queued → starting → running → finalizing → done`. Any non-terminal state MAY transition
to `failed`, `timed_out`, or `aborted`. Terminal states SHALL never transition. A chain SHALL not spawn a later step
unless the previous step reached `done`.

#### Scenario: Successful lifecycle
- **WHEN** a child starts, returns a digest, and closes successfully
- **THEN** its observed states follow `queued`, `starting`, `running`, `finalizing`, `done` without omissions or reversal

#### Scenario: Spawn failure
- **WHEN** process spawn fails
- **THEN** the run transitions from `starting` to `failed` with a redacted spawn error

### Requirement: Exact usage accounting
For every assistant `message_end`, the runner SHALL increment turns and add input, output, cache-read, cache-write,
total, reasoning, and cost values when present. It SHALL report per-run usage and aggregate usage for parallel/chain
calls. Missing numeric values count as zero; malformed negative or non-numeric values produce a diagnostic and are not
added.

#### Scenario: Usage reported
- **WHEN** a child completes after multiple assistant turns
- **THEN** final details contain summed per-run usage, model, and stop reason and the parent tool result reports the aggregate

### Requirement: Deterministic output limits
Model-visible output for each task SHALL be limited to 51,200 UTF-8 bytes or 2,000 lines, whichever is reached first.
Truncation SHALL preserve valid UTF-8, keep the beginning of a digest, and append
`[Output truncated: <bytes> bytes and <lines> lines omitted. Full output: <path-or-details>.]`. The untruncated digest
SHALL remain in structured details or an artifact path and SHALL never be silently discarded.

#### Scenario: Byte limit exceeded
- **WHEN** a digest exceeds 51,200 bytes before reaching 2,000 lines
- **THEN** model-visible text ends at a UTF-8 boundary and includes exact omitted byte and line counts

#### Scenario: Line limit exceeded
- **WHEN** a digest exceeds 2,000 lines before reaching 51,200 bytes
- **THEN** model-visible text contains at most 2,000 content lines plus the truncation marker

### Requirement: Concurrency governance
Concurrency SHALL resolve as project config `concurrency` > positive integer `PI_OPS_CONCURRENCY` > 2 and SHALL be
validated in the range 1-8. Parallel tasks SHALL start in input order and never exceed the effective live-child count.
The eight-task limit is hard and not configurable.

#### Scenario: Concurrency waves
- **WHEN** five tasks run with concurrency two
- **THEN** at most two children are live and queued tasks start in original order as slots become free

#### Scenario: Invalid concurrency
- **WHEN** explicit project concurrency is outside 1-8
- **THEN** config validation fails with the key and accepted range rather than silently clamping it

### Requirement: Error contract
Preflight errors SHALL throw before work starts. After one or more runs exist, the tool SHALL return all structured
outcomes and mark failed tasks in content/custom rendering; successful sibling details SHALL be preserved. The
implementation SHALL NOT rely on returning `isError`, because pi only marks thrown tool errors as errors.

#### Scenario: Mixed parallel outcome
- **WHEN** one parallel child fails and another succeeds
- **THEN** both results are returned in input order with terminal states `failed` and `done`, and the successful digest remains available

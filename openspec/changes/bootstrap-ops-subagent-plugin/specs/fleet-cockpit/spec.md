## Purpose

Fleet observability uses progressive disclosure: a passive summary for at-a-glance state, streamed tool-row progress,
a focused fleet overlay for investigation, and textual snapshots for commands/headless use. Users can understand what
each subagent is doing, why it is waiting, and how it ended without injecting raw child output into parent context.

## ADDED Requirements

### Requirement: Stable run identity and lifecycle
Every delegated task SHALL receive a stable run id and SHALL publish a normalized lifecycle state from
`queued | starting | running | finalizing | done | failed | timed_out | aborted`. A run snapshot SHALL include its
agent name and source, mode/step, task label, effective cwd, model, start time, elapsed time, effective timeout,
queue reason, `parentJobId`, and `sessionKey`; unavailable values SHALL be explicit nulls.

#### Scenario: Parallel tasks are distinguishable
- **WHEN** the same agent runs multiple tasks in parallel
- **THEN** each task has a distinct run id and task label in every observability surface

#### Scenario: Queued work is explained
- **WHEN** a task waits for the concurrency governor or a named-session lock
- **THEN** its state is `queued` and its snapshot identifies the reason it has not started

#### Scenario: Terminal reason is explicit
- **WHEN** a run times out or is aborted
- **THEN** the final state is `timed_out` or `aborted` rather than a generic failure

### Requirement: Passive glanceable summary
In TUI mode the system SHALL show a passive widget while runs are active or retained. `fleetWidgetLines` SHALL default
to 3 and accept 1-8. Within that budget the widget SHALL show aggregate state counts, current run agent/task label,
phase, elapsed/effective deadline, last activity, and aggregate usage/cost. It SHALL truncate each rendered line to
terminal width and SHALL NOT implement input handling.

#### Scenario: First run appears
- **WHEN** the first subagent starts
- **THEN** the passive widget appears with running count, agent/task label, phase, and elapsed time

#### Scenario: Parallel fleet remains compact
- **WHEN** more runs exist than fit in the line budget
- **THEN** the widget shows aggregate state and an overflow count instead of growing without bound

#### Scenario: Editor input is preserved
- **WHEN** the user types while the passive widget is visible
- **THEN** all keystrokes continue to target the editor unless the user explicitly opens the fleet overlay

### Requirement: Streamed tool-row progress
The `subagent` tool SHALL use partial updates to render the same normalized progress while it executes. The collapsed
result SHALL summarize outcome, duration, turns, tokens, cost, and failures; the normal pi tool-expansion control
SHALL reveal per-task details after completion.

#### Scenario: Progress before completion
- **WHEN** a child emits phase, assistant, or tool events
- **THEN** the in-flight subagent tool row updates without waiting for the final digest

#### Scenario: Useful collapsed completion
- **WHEN** a parallel or chained call finishes
- **THEN** the collapsed tool result shows succeeded/failed counts, total duration, usage, and cost

### Requirement: Focused fleet overlay
The extension SHALL register a configurable shortcut (default `Alt+o`) that opens a focused overlay backed by the
observability registry. The overlay SHALL provide a tab/list of retained runs and a detail view containing lifecycle,
elapsed/deadline, provenance, model, usage/cost, activity feed, output tail, error/stop reason, and final digest.

#### Scenario: Open overlay
- **WHEN** the user presses the fleet shortcut in TUI mode
- **THEN** a focused overlay opens without replacing or modifying editor contents

#### Scenario: Live overlay
- **WHEN** registry state changes while the overlay is open
- **THEN** the overlay refreshes to show the new state without closing

#### Scenario: Narrow terminal
- **WHEN** terminal dimensions cannot support the full layout
- **THEN** the overlay switches to a compact single-pane layout with truncated lines that do not exceed terminal width

### Requirement: Scoped keyboard navigation
Only while the overlay is focused, it SHALL support next/previous (`Tab`/`Shift+Tab` or arrows), direct jump
(`1`-`9`), detail toggle (`Enter`), summary (`s`), follow toggle (`f`), scrolling (`Up`/`Down`/`PageUp`/`PageDown`),
dismiss selected finished run (`d`), and close (`Escape`/`q`/`Alt+o`). Key hints SHALL be visible in the overlay.

#### Scenario: Navigation is focus-gated
- **WHEN** the overlay is closed
- **THEN** unmodified arrows, Tab, digits, and page keys retain their normal pi behavior

#### Scenario: Close returns focus
- **WHEN** the user closes the overlay
- **THEN** focus returns to the editor with its text and cursor state preserved

### Requirement: Actionable activity and failure telemetry
For each run, the registry SHALL retain the newest 200 activity events and newest 100 output-tail lines, each line
limited to 2,000 UTF-8 bytes. Events SHALL include phase transitions, child tool name and redacted argument summary,
last-progress timestamp, retry/queue events, timeout escalation, and final stop/error reason. A non-terminal run with
no progress for `fleetStaleAfterMs` (default 30,000 ms; minimum 5,000) SHALL display a stale warning without changing
its lifecycle state.

#### Scenario: Stalled run warning
- **WHEN** an active run emits no progress for the configured stale interval
- **THEN** all observability surfaces mark it stale while preserving its running state

#### Scenario: Timeout escalation visible
- **WHEN** the timeout kill ladder advances from TERM to KILL
- **THEN** the activity feed records SIGTERM and, if needed, SIGKILL with timestamps 5,000 ms apart

#### Scenario: Failure notification
- **WHEN** a background or non-focused run fails, times out, or is aborted
- **THEN** TUI mode emits a concise notification containing run id, agent, reason, and how to open its details

### Requirement: Bounded retention and dismissal
Finished runs SHALL remain inspectable for `fleetRetentionMs` (default 900,000 ms) and up to
`fleetRetentionCount` entries (default 50). Eviction SHALL occur when either limit is exceeded, oldest `finishedAt`
first, and SHALL never evict active runs. A user dismissal removes only the display entry, not durable job artifacts.
Zero duration or count SHALL remove completed display entries immediately.

#### Scenario: Completed run remains inspectable
- **WHEN** a run completes
- **THEN** it remains in the passive summary and overlay until dismissed or expired

#### Scenario: Retention cap
- **WHEN** finished history exceeds the configured count limit
- **THEN** the oldest finished entries are removed and all active entries remain

### Requirement: Context hygiene and sensitive-output handling
Raw child events, activity logs, and output tails SHALL remain extension-local and SHALL NOT be inserted into the
parent conversation. Displayed arguments and output tails SHALL be bounded and redacted for credential-like values;
full evidence SHALL only be persisted in the run artifact location when artifact persistence is enabled.

#### Scenario: No context pollution
- **WHEN** the widget or overlay renders child tool output
- **THEN** the parent model receives only the final bounded digest and structured tool details intended by the runner

#### Scenario: Secret-like argument
- **WHEN** a child event contains a credential-like argument or environment value
- **THEN** observability surfaces replace the sensitive value with `[REDACTED]`

### Requirement: Textual status and machine-readable snapshots
The extension SHALL provide `/ops:status` for a textual fleet summary and a snapshot API/tool-details representation
using the same lifecycle model. The snapshot SHALL remain available in print, JSON, and RPC modes even when no TUI is
rendered.

#### Scenario: Headless progress details
- **WHEN** a subagent runs under JSON or print mode
- **THEN** no TUI API is called and partial/final tool details expose run ids, states, timestamps, usage, and terminal reasons

#### Scenario: Status command
- **WHEN** the user invokes `/ops:status`
- **THEN** the command reports active and retained runs with ids, agents, states, elapsed time, last activity, and result paths

### Requirement: Reusable ASCII rendering templates
Fleet renderers SHALL reuse the following ASCII-only templates. Dynamic values replace `<PLACEHOLDERS>`; theme colors
MAY be applied without changing characters, labels, line order, or separators. Renderers SHALL NOT use Unicode box
drawing, emoji, or invented status glyphs. Status tags SHALL be exactly `[WAIT]`, `[START]`, `[RUN]`, `[FINAL]`,
`[OK]`, `[ERR]`, `[TIME]`, and `[ABRT]`. Mapping SHALL be `queued=[WAIT]`, `starting=[START]`, `running=[RUN]`,
`finalizing=[FINAL]`, `done=[OK]`, `failed=[ERR]`, `timed_out=[TIME]`, and `aborted=[ABRT]`.

Passive widget, default 3 lines:

```text
OPS  run=<RUNNING> wait=<QUEUED> err=<FAILED> kept=<RETAINED> cost=$<COST>
> <STATUS> <RUN_ID_SHORT> <AGENT>  <ELAPSED>/<TIMEOUT>  <LAST_ACTIVITY>
Alt+O fleet | stale=<STALE_COUNT> | tools=<TOOL_CALLS> | turns=<TURNS>
```

Wide overlay (`width >= 100`) SHALL use this exact 100-column frame (extra terminal columns remain unused), with
repeated run rows and activity rows; each placeholder is truncated/padded to its shown column:

```text
+ OPS FLEET ---------------------------------------------------------------------------------------+
| #  | RUN          | AGENT            | STATE   | ELAPSED/TIMEOUT   | LAST                        |
| >1 | <RUN_ID>     | <AGENT>          | <TAG>   | <ELAPSED>/<TO>    | <LAST_ACTIVITY>             |
| 2  | <RUN_ID>     | <AGENT>          | <TAG>   | <ELAPSED>/<TO>    | <LAST_ACTIVITY>             |
+ RUN DETAIL --------------------------------------------------------------------------------------+
| id: <RUN_ID>  mode: <MODE>  source: <SOURCE>                                                     |
| task: <TASK_LABEL>  model: <MODEL>  cwd: <CWD>                                                   |
| time: <STARTED> -> <FINISHED_OR_NOW>  cost: $<COST>                                              |
+ ACTIVITY ----------------------------------------------------------------------------------------+
| <TIME>  <EVENT>                                                                                  |
| <TIME>  <EVENT>                                                                                  |
+ DIGEST ------------------------------------------------------------------------------------------+
| <DIGEST_LINE>                                                                                    |
+ [Tab/Shift+Tab] select  [Enter] detail  [f] follow  [d] dismiss  [q] close ----------------------+
```

Narrow overlay (`40 <= width < 100`):

```text
OPS FLEET  run=<RUNNING> wait=<QUEUED> err=<FAILED>
> 1 <TAG> <AGENT> <ELAPSED>/<TO>
  2 <TAG> <AGENT> <ELAPSED>/<TO>
-- DETAIL <RUN_ID> --
agent: <AGENT>  mode: <MODE>
last: <LAST_ACTIVITY>
cost: $<COST>  turns: <TURNS>
-- ACTIVITY --
<TIME> <EVENT>
-- DIGEST --
<DIGEST_LINE>
[Tab] next [Enter] detail [q] close
```

Very narrow fallback (`width < 40`):

```text
OPS <RUNNING> run <FAILED> err
<TAG> <AGENT>
<ELAPSED>/<TO>
Alt+O
```

Collapsed completed tool row:

```text
subagent <MODE>: ok=<DONE> err=<FAILED> time=<DURATION> turns=<TURNS> cost=$<COST>
  [OK] <AGENT> <RUN_ID_SHORT> <DURATION> <DIGEST_PREVIEW>
  [ERR] <AGENT> <RUN_ID_SHORT> <REASON>
```

#### Scenario: Exact passive rendering
- **WHEN** the default widget renders with enough width
- **THEN** it uses the three passive-template lines and exact labels/status tags

#### Scenario: Responsive template selection
- **WHEN** overlay width crosses 100 or 40 columns
- **THEN** it selects the corresponding template and truncates placeholder values so no line exceeds width

#### Scenario: Snapshot stability
- **WHEN** renderer snapshot tests run
- **THEN** expected fixtures use these templates verbatim so visual changes require a spec update

### Requirement: Reload and shutdown safety
Timers, shortcuts, overlays, and registry pumps SHALL be session-scoped, idempotent across `/reload`, and cleaned up on
`session_shutdown`. TUI-specific components SHALL only be created when `ctx.mode === "tui"`; RPC SHALL expose
snapshots but SHALL NOT create widget/overlay components. Lifecycle transitions SHALL follow the subagent-runner state machine
and terminal snapshots SHALL be immutable.

#### Scenario: Reload without duplicates
- **WHEN** extensions reload while runs are present
- **THEN** exactly one passive widget pump and one fleet shortcut remain registered, and durable run state is reconciled

#### Scenario: Session shutdown
- **WHEN** the session shuts down
- **THEN** the widget is cleared, any open overlay closes, timers stop, and no input listener or renderer remains attached

## Purpose

Core delegation runtime for pi-ops-subagent: spawns isolated `--mode json` pi children in single, parallel, or
chained modes with per-call timeouts, usage tracking, output caps, and clean abort propagation.

## ADDED Requirements

### Requirement: Subagent tool with three modes
The system SHALL expose a `subagent` tool supporting single, parallel, and chain invocation modes.

#### Scenario: Single delegation
- **WHEN** the parent agent calls the tool with an `agent` and `task`
- **THEN** exactly one child pi process runs the task and the tool returns the child's final digest

#### Scenario: Parallel delegation
- **WHEN** the parent agent calls the tool with a `tasks` array
- **THEN** the system runs the tasks concurrently up to the configured concurrency limit and returns one digest per task

#### Scenario: Chained delegation
- **WHEN** the parent agent calls the tool with a `chain` array whose tasks reference `{previous}`
- **THEN** each step runs sequentially, the `{previous}` placeholder is replaced with the prior step's digest, and the chain stops at the first failed step, reporting which step failed

#### Scenario: Invalid mode combination
- **WHEN** the parent agent provides more than one of agent/tasks/chain
- **THEN** the tool rejects the call without spawning any child

### Requirement: Isolated child sessions
Each child SHALL run in its own pi subprocess with an isolated context window; raw tool output SHALL NOT enter the
parent conversation, only the final digest.

#### Scenario: Context isolation
- **WHEN** a child agent runs multiple bash/read/grep calls
- **THEN** none of the intermediate outputs are added to the parent session and only the child's final text digest is returned

### Requirement: Parent-configurable per-call timeout
The parent agent SHALL be able to set a `timeout` parameter on any single/parallel/chain call; the effective timeout
SHALL follow precedence per-call > agent manifest `timeout:` > project config > environment default, and SHALL NOT
exceed a configurable hard ceiling.

#### Scenario: Per-call override
- **WHEN** the parent agent passes `timeout: 90`
- **THEN** the child process is killed if it exceeds 90 seconds regardless of manifest or global defaults

#### Scenario: Manifest default
- **WHEN** no per-call timeout is given but the agent manifest declares `timeout: 300`
- **THEN** the effective timeout is 300 seconds

#### Scenario: Hard ceiling enforcement
- **WHEN** the parent agent passes a timeout above the configured ceiling
- **THEN** the effective timeout is clamped to the ceiling

### Requirement: Kill ladder on timeout
The system SHALL terminate an over-time child via grace → SIGTERM → cooldown → SIGKILL, and report the timeout as a
failure with the partial digest preserved.

#### Scenario: Timeout termination
- **WHEN** a child exceeds its effective timeout
- **THEN** the child is signaled SIGTERM, and if still alive after the cooldown window, SIGKILL; the tool result is marked failed with the timeout reason and any partial output

### Requirement: Usage and cost tracking
The system SHALL accumulate per-child turns, input/output/cache tokens, cost, context tokens, model, and stop reason
from the `--mode json` event stream and expose them in tool details.

#### Scenario: Usage reported
- **WHEN** a child completes
- **THEN** the tool result details include per-child usage stats and the model used

### Requirement: Output caps
The system SHALL cap per-task model-visible output (default 50 KB) and truncate with an explicit marker.

#### Scenario: Oversized output truncated
- **WHEN** a child's final digest exceeds the cap
- **THEN** the model-visible text is truncated to the cap with a `[Output truncated: N bytes omitted.]` marker and full output remains in details

### Requirement: Abort propagation
Aborting the parent tool call SHALL propagate to all live children (SIGTERM, then SIGKILL after a grace window),
leaving no orphan processes.

#### Scenario: Parent abort
- **WHEN** the parent agent run is aborted while children are running
- **THEN** all children are terminated and the tool returns an aborted failure

### Requirement: Concurrency governance
Parallel concurrency SHALL be configurable (project config / env override), defaulting to a small value (2) suitable
for read-only probes against live systems, with a hard max parallel task count (8).

#### Scenario: Concurrency limit respected
- **WHEN** more tasks than the concurrency limit are requested in parallel mode
- **THEN** tasks run in waves and never more than the limit are alive at once

#### Scenario: Parallel task cap
- **WHEN** more than 8 tasks are requested in one call
- **THEN** the call is rejected before spawning children

## Purpose

Named sessions give subagents durable, interview-style continuity: a probe or diagnostic agent can be continued
across turns and restarts, accumulating evidence in its own isolated context while only digests reach the parent.

## ADDED Requirements

### Requirement: Named persistent sessions
The system SHALL support `session` names on subagent calls; sessions persist on disk and continue the same child pi
conversation across calls.

#### Scenario: Continue a session
- **WHEN** a subagent call specifies `session` and a session with that name exists
- **THEN** the child continues its existing conversation instead of starting fresh

### Requirement: Session key derivation
A session SHALL be derived deterministically from agent name + session handle + parent session + effective cwd so
collisions don't occur across projects or agents.

#### Scenario: Distinct keys
- **WHEN** two sessions share a handle but differ in agent or cwd
- **THEN** they resolve to different child sessions

### Requirement: Fresh session creation
A call with a `session` name that does not exist SHALL create a new session and report creation in metadata.

#### Scenario: First call creates
- **WHEN** a session name is used for the first time
- **THEN** a new child session is created and the result metadata reports "created"

### Requirement: Session locking
A named session SHALL be usable by only one running call at a time; concurrent use is rejected with a clear error.

#### Scenario: Concurrent reject
- **WHEN** two calls target the same session concurrently
- **THEN** one is rejected before any child starts, citing the lock

### Requirement: Session expiry and cleanup
Sessions SHALL expire after a configurable idle period and be cleaned up automatically; ending a session is explicit.

#### Scenario: Idle expiry
- **WHEN** a session idle for its expiry period is next touched
- **THEN** it is treated as expired and a fresh session may be started under the same name

### Requirement: Availability without persistence
Named sessions SHALL require a persisted parent; when the parent runs without a session, session params are rejected
with guidance to use ephemeral calls.

#### Scenario: No persisted parent
- **WHEN** the parent is running with `--no-session` and a call requests `session`
- **THEN** the call fails with an actionable message instead of silently ignoring the parameter
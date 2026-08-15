## Purpose

Named sessions give a subagent isolated multi-turn continuity across parent turns and restarts, with deterministic
identity, exact child-session persistence, exclusive locking, and bounded idle lifetime.

## ADDED Requirements

### Requirement: Exact named-session input
The common optional `session` field SHALL be a non-empty handle matching `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`.
Supplying it SHALL continue one child pi session for the selected agent; omitting it SHALL use an ephemeral child.
Parallel calls SHALL reject duplicate derived session keys before spawning.

#### Scenario: First named call
- **WHEN** a valid handle has no metadata/session file
- **THEN** a child session is created and result details set `sessionStatus: created`

#### Scenario: Continuation
- **WHEN** the same derived key has a live unexpired session
- **THEN** the child uses the exact stored `--session <path>` and details set `sessionStatus: continued`

#### Scenario: Invalid handle
- **WHEN** a handle is empty, over 64 characters, or outside the accepted pattern
- **THEN** the tool throws before lock or child creation

### Requirement: Deterministic session key
The full derivation input SHALL be UTF-8 strings joined with NUL in this order:
`ops/v1`, parent session id, canonical effective cwd, agent name, session handle. The storage key SHALL be the first
32 lowercase hex characters of SHA-256 over that input. Display name SHALL be `ops: <agent> · <handle>`.

#### Scenario: Distinct dimensions
- **WHEN** any of parent id, cwd, agent, or handle differs
- **THEN** derivation input differs and resolves independently even if a hash collision is theoretically possible

### Requirement: Exact child-session persistence
Session metadata SHALL live at `<sessionsDir>/<key>/meta.json` (default `<project>/.ops/sessions`) and contain version,
derivation fields, child session path, created/last-used timestamps, and state `active | expired | ended`. First use
SHALL spawn with `--session-dir <sessionsDir>/<key>/pi --name <display-name>` and capture the resulting session file; continuation SHALL
pass that exact path with `--session`.

#### Scenario: Missing stored child file
- **WHEN** metadata points to a missing or unreadable child session
- **THEN** continuation fails with path diagnostics and does not silently create a replacement

### Requirement: Exclusive lock and heartbeat
A call SHALL acquire `<sessionsDir>/<key>/lock.json` atomically before child spawn. Archive suffix timestamps SHALL
use UTC `YYYYMMDDTHHMMSSmmmZ`. Lock content SHALL include owner pid, run id, acquired timestamp, and heartbeat timestamp. Heartbeat SHALL update every 5,000 ms. A lock is reclaimable
only when heartbeat age exceeds 30,000 ms and the recorded pid is not alive. Lock removal SHALL occur in `finally`.

#### Scenario: Concurrent call
- **WHEN** a live lock already exists for the derived key
- **THEN** the second call remains unspawned and returns the owner run id plus lock age

#### Scenario: Dead stale owner
- **WHEN** heartbeat is older than 30,000 ms and the owner pid is absent
- **THEN** the lock is atomically renamed to `lock.stale.<YYYYMMDDTHHMMSSmmmZ>.json` and the new caller acquires a fresh `lock.json`

#### Scenario: Old but live owner
- **WHEN** heartbeat is older than 30,000 ms but the owner pid is alive
- **THEN** automatic reclaim is refused and cleanup requires explicit user action

### Requirement: Idle expiry and explicit end
`sessionExpiryMs` SHALL default to 604,800,000 and accept integers >= 60,000. Idle age SHALL be measured from
`lastUsedAt`. On next touch after expiry, old metadata SHALL become `expired` and a new child session MAY be created
only after the user/caller explicitly supplies `restartExpired: true`. `/ops:session end <key-or-handle>` SHALL mark
metadata `ended`, remove a non-live lock, and retain files unless cleanup is explicitly requested.

#### Scenario: Expired without restart flag
- **WHEN** an expired handle is invoked without `restartExpired: true`
- **THEN** no child spawns and the result explains expiry and the restart field

#### Scenario: Explicit restart
- **WHEN** the same invocation includes `restartExpired: true`
- **THEN** a fresh child session/path is created and prior metadata is copied to `meta.expired.<YYYYMMDDTHHMMSSmmmZ>.json`

### Requirement: Persisted parent required
Named child sessions SHALL require `ctx.sessionManager.isPersisted()` and a parent session id. Ephemeral parents SHALL
be rejected with guidance to omit `session` or run parent pi with persistence.

#### Scenario: Ephemeral parent
- **WHEN** the parent uses `--no-session` and a call supplies `session`
- **THEN** the call throws before key directory or lock creation

### Requirement: Session inspection
`/ops:session` SHALL support `list`, `info`, `end`, and `cleanup`. Output SHALL include display handle, agent,
canonical cwd, state, child path, last use, expiry time, and lock owner/age. Cleanup SHALL require explicit selection
and SHALL refuse live locks.

#### Scenario: List sessions
- **WHEN** `/ops:session list` runs
- **THEN** active, expired, and ended entries are shown with deterministic key and status

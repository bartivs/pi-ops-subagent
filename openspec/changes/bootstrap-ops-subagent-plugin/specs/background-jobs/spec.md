## Purpose

Background and scheduled runs execute asynchronously while pi is alive and persist specifications, lifecycle, and
artifacts under effective `runsDir` (default `<project>/.ops/runs`) so interrupted work remains inspectable and can be resumed explicitly.

## ADDED Requirements

### Requirement: Asynchronous execution ownership
`runAsync: true` SHALL be valid for single, parallel, and chain calls. It SHALL create a durable job record before
returning `jobId`, then queue work under the owning pi process. V1 SHALL NOT claim that a worker continues after that
pi process exits.

#### Scenario: Background probe
- **WHEN** a valid call sets `runAsync: true`
- **THEN** the tool returns after the job record is durable and the owning process executes the queued work without blocking the parent turn

#### Scenario: Owner exits
- **WHEN** pi exits while its job is running
- **THEN** startup reconciliation later marks the stale record `interrupted`; it does not report false continuation

### Requirement: Exact durable registry
The registry SHALL be `<runsDir>/registry.json`, containing version `1` and job records with `jobId`, lifecycle state,
immutable run spec, agent names, created/started/finished timestamps, owner pid, schedule, `nextRunAt`,
`resumedFromJobId`, and artifact directory. Writes SHALL use a same-directory temp file, fsync where supported, and
atomic rename. Job states SHALL be `queued | running | done | failed | interrupted | canceled`.

#### Scenario: Restart reconciliation
- **WHEN** startup reads a `running` job whose owner pid is absent
- **THEN** it transactionally changes that job to `interrupted` and preserves its partial artifacts

#### Scenario: Corrupt registry
- **WHEN** registry JSON or version is invalid
- **THEN** scheduling/execution fails closed, the corrupt file is preserved, and `/ops:jobs` reports its path and parse error

### Requirement: Per-job artifacts
Each job SHALL write `<runsDir>/<jobId>/meta.json`, `digest.md`, `evidence.jsonl`, and `usage.json`. `meta.json` SHALL
contain the immutable spec and final state; evidence SHALL be chronological redacted JSON lines; usage SHALL contain
per-run and aggregate numeric fields. Files SHALL be mode `0600` where supported.

#### Scenario: Successful artifacts
- **WHEN** a job reaches `done`
- **THEN** all four files exist and registry artifact path points to that directory

#### Scenario: Partial failure artifacts
- **WHEN** a job fails, times out, is canceled, or is interrupted after producing events
- **THEN** available evidence/usage is retained and `meta.json` identifies the terminal reason

### Requirement: Job commands
`/ops:jobs` SHALL support `list`, `inspect <jobId>`, `resume <jobId>`, and `cancel <jobId>`. List SHALL show id,
agents, state, created/started/finished times, schedule/next run, and artifact path. Unknown ids and invalid state
actions SHALL return actionable errors without registry mutation.

#### Scenario: Resume interrupted job
- **WHEN** `resume` targets `interrupted` or `failed`
- **THEN** a new queued job with a new id and `resumedFromJobId` is created from the immutable stored spec

#### Scenario: Resume does not overwrite
- **WHEN** a job is resumed repeatedly
- **THEN** each attempt has a unique id/directory and prior records/artifacts remain unchanged

#### Scenario: Cancel running job
- **WHEN** `cancel` targets `queued` or `running`
- **THEN** queued work does not spawn or live work receives the termination ladder, then the job becomes `canceled`

### Requirement: Exact schedule schema
A schedule SHALL contain exactly one of `intervalSec` (integer >= 60) or `at` (RFC3339 timestamp with timezone). Cron
expressions and multiple schedule keys SHALL be rejected in v1. Schedule records SHALL persist `nextRunAt`; triggers
SHALL be checked every 10,000 ms only while pi is running.

#### Scenario: Interval schedule
- **WHEN** a job has `intervalSec: 21600`
- **THEN** completion schedules the next run for 21,600 seconds after the trigger time

#### Scenario: One-shot timestamp
- **WHEN** a job has a future `at` timestamp
- **THEN** one job is queued at or after that instant and the schedule is then complete

#### Scenario: Overdue startup trigger
- **WHEN** startup finds an overdue interval or one-shot
- **THEN** it queues exactly one run; intervals advance from current time and one-shots become complete

### Requirement: Scheduler opt-in
A background call without `schedule` SHALL run once and SHALL NOT create a future trigger.

#### Scenario: Unscheduled background job
- **WHEN** `runAsync: true` is supplied without `schedule`
- **THEN** the job executes once and `nextRunAt` is null

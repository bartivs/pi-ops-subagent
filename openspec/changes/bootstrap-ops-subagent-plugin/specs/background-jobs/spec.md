## Purpose

Background and scheduled runs let probes and diagnostic chains execute asynchronously and on a calendar, with a
durable registry so work survives restarts and can be resumed. Results land as artifacts in a gitignored `runs/`.

## ADDED Requirements

### Requirement: Async execution
The system SHALL support `run_async` for single, parallel, and chain modes; the tool returns immediately with a job
id while the work continues in the background.

#### Scenario: Background probe
- **WHEN** the parent requests a background run
- **THEN** the call returns a job id and the probe continues without blocking the parent

### Requirement: Durable run registry
The system SHALL persist job records (id, status, agent(s), task, timestamps, result path) in a state directory so
jobs survive parent restarts.

#### Scenario: Restart survival
- **WHEN** a background job is running and pi restarts
- **THEN** the job record is still listed and its state reconciles (running jobs may be marked interrupted)

### Requirement: Job status queries
The system SHALL provide a way to list and inspect jobs with statuses `queued | running | done | failed |
interrupted`, including per-job result artifacts.

#### Scenario: Jobs list
- **WHEN** the user or parent queries jobs
- **THEN** each job shows id, agent(s), status, started/finished times, and result path

### Requirement: Resumability
The system SHALL allow re-running a job from its stored spec; interrupted jobs can be re-queued.

#### Scenario: Resume a job
- **WHEN** a job is re-run from the registry
- **THEN** it re-executes the same task spec and writes a fresh result artifact

### Requirement: Scheduled runs
The system SHALL support repeat specs (`interval`, `at`, cron-lite) persisted with the registry; triggers are
evaluated at pi startup and on an internal tick.

#### Scenario: Interval schedule
- **WHEN** a job declares `interval: 6h`
- **THEN** the registry re-queues the job every 6 hours while pi runs

#### Scenario: One-shot at
- **WHEN** a job declares `at: <future timestamp>`
- **THEN** the job is queued once when that time is reached

### Requirement: Artifact output location
Background results SHALL write digest + evidence + usage to `runs/<job-id>/` which is gitignored.

#### Scenario: Artifacts written
- **WHEN** a background job completes
- **THEN** a directory under `runs/` contains the final digest, raw evidence, and usage summary

### Requirement: Scheduler opt-in
Scheduled execution SHALL be opt-in per job; no job runs on a schedule unless explicitly defined with a schedule.

#### Scenario: Default no-schedule
- **WHEN** a background job is created without a repeat spec
- **THEN** it runs once and never re-queues
## Purpose

Environment contracts give subagents their operational context — targets, connection details, naming conventions,
and runbook pointers — from marked contract files that are injected automatically into every child.

## ADDED Requirements

### Requirement: Contract file location and marking
Environment contracts SHALL live in a conventional location (e.g. `.ops/contracts/<name>.md`) and SHALL be
discoverable by the extension; the directory SHALL be gitignored by default because contracts may contain
credentials.

#### Scenario: Contract discovered
- **WHEN** a project contains a contracts directory with marked files
- **THEN** the extension enumerates them as candidate contracts

### Requirement: Automatic injection
When a contract applies to a subagent run, the system SHALL prepend the contract contents to the child's task with a
clear "verify target" instruction, before the delegated task.

#### Scenario: Injection into task
- **WHEN** a subagent is invoked and a matching contract exists
- **THEN** the child's prompt contains the contract content plus "verify the target first; never probe the local
machine" guidance

### Requirement: Single source of truth
Contracts SHALL be the single source of truth for the environment; changing the contract file SHALL change behavior of
all future runs without code changes.

#### Scenario: Contract edit propagates
- **WHEN** a contract file is edited
- **THEN** the next run picks up the new contents automatically

### Requirement: Absence is graceful
When no contract is configured for a run, the system SHALL proceed with the task unchanged and SHALL NOT error.

#### Scenario: No contract present
- **WHEN** a subagent is invoked with no matching contract
- **THEN** the child runs with just the delegated task

### Requirement: Multi-contract selection
When multiple contracts exist, the parent agent SHALL be able to select one per call (`contract:` param), defaulting
to a project-designated default contract.

#### Scenario: Explicit contract choice
- **WHEN** the parent passes `contracts: ["prod"]`
- **THEN** only that contract is injected into the child

### Requirement: Usage context in behavior
Contract SHALL include pointers like naming conventions, runbook paths, and expected baselines that inform probe
behavior.

#### Scenario: Naming conventions plumbed
- **WHEN** a contract defines naming conventions
- **THEN** probe agents reference them when forming queries (e.g. metric names, host patterns)
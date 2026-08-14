## Purpose

Incident artifact agents generate structured operational outputs — triage, communications, and post-incident reports
— from probe evidence, with strict JSON schemas and honesty guardrails (confidence, missing-information, redaction)
in the pattern of Microsoft's On-Call Copilot.

## ADDED Requirements

### Requirement: Artifact agent roles
The system SHALL ship at least three artifact roles: `triage` (hypotheses + evidence + confidence + immediate
actions + runbook alignment), `comms` (Slack update + stakeholder brief), and `pir` (post-incident report: timeline,
customer impact, prevention actions).

#### Scenario: Triage output
- **WHEN** a `triage` artifact run completes
- **THEN** its output follows the triage schema with hypotheses, evidence, confidence, immediate actions, and
runbook alignment

#### Scenario: Comms output
- **WHEN** a `comms` run completes
- **THEN** it produces both a Slack-format update and a non-technical stakeholder summary

#### Scenario: PIR output
- **WHEN** a `pir` run completes
- **THEN** it produces a post-incident report with timeline, quantified customer impact, and prevention actions

### Requirement: Strict JSON output contracts
Every artifact agent SHALL emit output conforming to its declared JSON schema; malformed output SHALL be rejected
and surfaced as a failure.

#### Scenario: Schema validation
- **WHEN** an artifact agent returns output that fails its schema validation
- **THEN** the run is marked failed with the validation error, not silently accepted

### Requirement: Confidence and missing-information discipline
Artifact agents SHALL not fabricate: when evidence is insufficient, they SHALL mark confidence low and populate a
missing-information list; undetermined fields SHALL be marked `UNKNOWN`.

#### Scenario: Sparse evidence
- **WHEN** an artifact agent is given sparse evidence
- **THEN** hypotheses carry low/zero confidence, missing information is listed explicitly, and undetermined fields
read `UNKNOWN`

### Requirement: Redaction
Artifact agents SHALL redact credential-like material in outputs.

#### Scenario: Secret redaction
- **WHEN** an artifact run encounters credential-like content in evidence
- **THEN** the output replaces it with a `[REDACTED]` marker

### Requirement: Parallel artifact composition
When composing artifacts, the system SHALL run the requested artifact agents concurrently and merge their outputs.

#### Scenario: Concurrent artifact run
- **WHEN** triage, comms, and pir are requested together
- **THEN** they run in parallel and the merged result contains all three product blocks
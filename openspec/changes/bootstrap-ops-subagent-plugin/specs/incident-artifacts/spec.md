## Purpose

Incident artifact agents transform supplied probe evidence into strict versioned JSON for triage, communications, and
post-incident review, with explicit unknowns, evidence references, confidence, and redaction.

## ADDED Requirements

### Requirement: Shared JSON output contract
Every artifact output SHALL be one JSON object, not markdown or fenced text, with required
`schemaVersion: "1"`, `artifactType`, `generatedAt` (RFC3339 or `UNKNOWN`), `missingInformation` (string array), and
`redactions` (integer >= 0). Unknown scalar values SHALL be the string `UNKNOWN`; unknown arrays SHALL be empty and
explained in `missingInformation`. Unknown keys SHALL fail validation.

#### Scenario: Prompt contract
- **WHEN** a bundled artifact manifest is loaded
- **THEN** its system prompt explicitly requests `JSON`, contains the complete schema, one valid JSON example, and forbids prose/fences

#### Scenario: Truncated JSON
- **WHEN** child stop reason is `length` or JSON parsing fails
- **THEN** the artifact is `failed` with parse/stop diagnostics and is not heuristically repaired

### Requirement: Triage schema
A triage output SHALL set `artifactType: "triage"` and require:

- `incidentSummary`: string
- `severity`: `SEV1 | SEV2 | SEV3 | SEV4 | UNKNOWN`
- `observations`: array of `{id: string, evidenceId: string, fact: string}`
- `hypotheses`: array of `{summary: string, evidenceIds: string[], confidence: number}` with confidence 0..1
- `immediateActions`: array of `{action: string, mutation: boolean, approvalRequired: boolean, runbook: string}`
- `runbookAlignment`: string
- shared contract fields

Every evidence id SHALL refer to supplied evidence. If `mutation` is true, `approvalRequired` SHALL also be true.

#### Scenario: Valid triage
- **WHEN** sufficient probe evidence is supplied
- **THEN** output validates, hypotheses cite existing evidence ids, and confidence values are within 0..1

#### Scenario: Unsupported hypothesis
- **WHEN** a hypothesis has no supporting supplied evidence
- **THEN** its `evidenceIds` is empty, confidence is 0, and the gap appears in `missingInformation`

### Requirement: Communications schema
A communications output SHALL set `artifactType: "comms"` and require `status` (`investigating | identified |
monitoring | resolved | UNKNOWN`), `severity`, `slackUpdate`, `stakeholderBrief`, `knownImpact`, `nextUpdateAt`
(RFC3339 or `UNKNOWN`), and shared contract fields. It SHALL distinguish observed facts from hypotheses and SHALL NOT
state an unverified root cause as fact.

#### Scenario: Valid communications artifact
- **WHEN** a comms run completes with partial incident evidence
- **THEN** it returns both concise Slack text and non-technical stakeholder text while unknown impact/timing is explicit

### Requirement: Post-incident report schema
A PIR output SHALL set `artifactType: "pir"` and require:

- `title`: string
- `status`: `draft | final`
- `timeline`: array of `{timestamp: string, event: string, evidenceIds: string[]}`
- `customerImpact`: `{summary: string, quantified: string}`
- `rootCause`: string
- `contributingFactors`: string array
- `preventionActions`: array of `{action: string, owner: string, dueDate: string, status: "open" | "done"}`
- shared contract fields

A PIR SHALL remain `draft` whenever root cause, quantified impact, or any required timeline fact is unknown.

#### Scenario: Sparse PIR evidence
- **WHEN** root cause or quantified impact is unavailable
- **THEN** status is `draft`, unknown values are `UNKNOWN`, and missing information lists the unresolved facts

### Requirement: Secret redaction
Before parsing or persistence, credential-like values in artifact text SHALL be replaced with `[REDACTED]`; the
`redactions` count SHALL equal replacements. Evidence ids and non-secret operational identifiers SHALL remain intact.

#### Scenario: Secret-like evidence
- **WHEN** supplied evidence contains an API key, bearer token, private key block, password assignment, or connection URI credential
- **THEN** output contains `[REDACTED]`, never the literal secret, and increments `redactions`

### Requirement: Parallel composition with partial success
Requested artifact types SHALL run concurrently in separate child contexts. The merged result SHALL be an object keyed
only by requested type; each value SHALL contain either `{status: "done", artifact: <validated object>}` or
`{status: "failed", error: <redacted diagnostic>}`. One failure SHALL NOT discard valid siblings.

#### Scenario: Mixed artifact composition
- **WHEN** triage and comms validate but PIR does not
- **THEN** merged output preserves validated triage/comms objects and reports only PIR as failed

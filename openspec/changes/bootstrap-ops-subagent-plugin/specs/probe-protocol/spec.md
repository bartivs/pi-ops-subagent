## Purpose

The v1 probe safety protocol enforces target verification, policy-mediated read-only diagnostics, structured evidence,
exact threshold evaluation, explicit unknowns, and proposal-only mutations.

## ADDED Requirements

### Requirement: Probe identification and tool policy
Only manifests with `kind: probe` SHALL receive the probe protocol. Probe children SHALL receive `read`, `grep`,
`find`, `ls`, and `probe_exec` subject to manifest narrowing; they SHALL NOT receive built-in `bash`, `write`, `edit`,
or any mutation tool. The runtime preamble SHALL state the same restrictions.

#### Scenario: Probe starts
- **WHEN** a `kind: probe` manifest is selected
- **THEN** effective child tools contain no unrestricted shell or file-mutation tool

#### Scenario: General agent
- **WHEN** a `kind: general` manifest is selected
- **THEN** probe preamble/threshold behavior is not injected merely because its name begins with `probe-`

### Requirement: Policy-mediated diagnostic executor
`probe_exec` SHALL accept `{profile, args, target}` where `profile` is an exact registered read-only diagnostic
profile, `args` is a string array, and `target` is a contract target id. Profiles SHALL map to fixed executable plus
argument validation and SHALL spawn directly with `shell: false`. Unknown profiles, unknown arguments, shell control
characters, redirection, mutation-capable subcommands, and target mismatch SHALL be rejected before spawn. V1 SHALL
NOT accept an arbitrary executable path from the model.

#### Scenario: Approved diagnostic
- **WHEN** a request matches a registered profile and argument policy for the verified target
- **THEN** the fixed executable is spawned directly and stdout/stderr/exit metadata becomes evidence

#### Scenario: Shell or mutation attempt
- **WHEN** args contain a shell operator/redirection or a restart/install/write/delete subcommand
- **THEN** `probe_exec` rejects before process creation and emits a `policy_denied` evidence event

#### Scenario: Arbitrary executable
- **WHEN** the model supplies an unregistered profile or executable-like profile value
- **THEN** validation rejects it and lists only registered profile names

### Requirement: Target verification gate
For a contract-backed probe, the first executable diagnostic SHALL be the contract's `verifyProfile`. The observed
normalized identity SHALL exactly match `expectedIdentity`. Until it matches, `probe_exec` SHALL reject every other
profile for that run. Mismatch SHALL terminate the probe as `failed` without local fallback.

#### Scenario: Correct target
- **WHEN** verify-profile output normalizes to `expectedIdentity`
- **THEN** evidence records `target_verified` and subsequent approved profiles may run

#### Scenario: Wrong target
- **WHEN** normalized identity differs
- **THEN** the run stops, reports expected and observed non-secret identities, and performs no further diagnostic

#### Scenario: No contract
- **WHEN** no contract applies
- **THEN** the task may use read-only local filesystem tools but `probe_exec` is unavailable and the digest states `target not configured`

### Requirement: Structured evidence
Every probe observation SHALL have `evidenceId` (`ev-` plus UUID v4), RFC3339 timestamp, target id, profile/tool,
redacted arguments, exit code/status, bounded observed output, and collection status
`collected | permission_denied | unavailable | policy_denied`. Digests SHALL cite evidence ids rather than inventing
command text or uncaptured values.

#### Scenario: Collected metric
- **WHEN** a diagnostic returns measurable output
- **THEN** the digest's interpretation references the corresponding evidence id and observed value

#### Scenario: Permission denied
- **WHEN** collection fails due to authorization
- **THEN** status is `permission_denied`, the digest says `not collected / permission denied`, and no value is guessed

### Requirement: Exact threshold schema and evaluation
A probe manifest `thresholds` entry SHALL be an array of objects with only these required keys:
`id` (agent-name pattern), `metric` (non-empty string), `operator` (`gt | gte | lt | lte | eq | neq`), `value`
(number), `unit` (string), and `severity` (`warning | critical`). Numeric observed values SHALL be normalized to the
threshold unit before evaluation. Missing/non-numeric/incompatible-unit evidence SHALL produce `not_evaluated`, not a
pass. Threshold output SHALL be `normal | warning | critical | not_evaluated` and cite threshold/evidence ids.

#### Scenario: Threshold crossed
- **WHEN** normalized evidence makes a threshold expression true
- **THEN** digest reports its severity, metric/value/unit, threshold id, and evidence id

#### Scenario: Threshold cannot be evaluated
- **WHEN** evidence is missing, non-numeric, or has incompatible units
- **THEN** result is `not_evaluated` and missing information explains why

### Requirement: No fabrication and confidence labels
Probe digests SHALL separate `Observed`, `Threshold evaluation`, `Interpretation`, `Unknown / not collected`, and
`Proposed actions`. Interpretations SHALL be labeled `high`, `medium`, or `low` confidence and cite evidence ids.
Unknown data SHALL never be converted into a normal status.

#### Scenario: Sparse evidence
- **WHEN** only part of the requested evidence is collected
- **THEN** collected facts remain visible, unknown items are listed, and conclusions unsupported by evidence are omitted

### Requirement: Mutation is proposal-only in v1
V1 SHALL NOT expose an execution path for mutating actions. Agents MAY describe a proposed action under
`Proposed actions` with rationale, risk, prerequisites, rollback, and `approvalRequired: true`; approval records intent
only and SHALL NOT cause this package to execute the action.

#### Scenario: Restart proposed
- **WHEN** evidence suggests a service restart
- **THEN** the digest describes it as approval-required and no restart-capable tool becomes available

## Purpose

The ops safety contract for every probe agent: read-only by construction, verify the target first, emit evidence-only
digests with thresholds, and never fabricate — mutation requires explicit gated approval.

## ADDED Requirements

### Requirement: Read-only by construction
Probe agents SHALL be constrained to a read-only toolset (`bash`, `read`, `grep`, `find`, `ls` as allowed per manifest)
and their system prompts SHALL forbid mutating, restarting, or installing anything.

#### Scenario: Non-mutating default
- **WHEN** a probe agent runs without an explicit mutation grant
- **THEN** its toolset and prompt forbid any destructive or mutating operation

### Requirement: Target verification
Probe agents SHALL verify the identity of their target (e.g. hostname) before running diagnostics and SHALL stop if
the verification fails.

#### Scenario: Wrong target abort
- **WHEN** a probe connects to a target whose identity does not match the expected one
- **THEN** the probe aborts early and reports the mismatch instead of proceeding

### Requirement: Evidence-only digests
A probe's final digest SHALL consist of observed evidence (command outputs, measured values) with a plain-language
interpretation; probes SHALL mark inaccessible or denied probes as "not collected / permission denied".

#### Scenario: Evidence reported
- **WHEN** a probe completes
- **THEN** its digest cites the commands run and observed outputs, and never inverts an unmeasured value

### Requirement: Threshold-based interpretation
Probe manifests SHALL declare thresholds (e.g. load > cores, %util ≈ 100, si/so > 0) and the probe SHALL flag
abnormal metrics against them.

#### Scenario: Threshold flagging
- **WHEN** an observed metric crosses a declared threshold
- **THEN** the digest explicitly flags it as abnormal with the threshold reference

### Requirement: No fabrication
Probes SHALL mark unknown or missing data explicitly rather than inventing plausible values.

#### Scenario: Missing data honesty
- **WHEN** a probe cannot collect a requested datum
- **THEN** the digest says "not collected / permission denied" and does not supply a guessed value

### Requirement: Gated action policy
Any mutating action proposed by an agent SHALL require explicit approval; the default posture is autonomous
investigation with gated action.

#### Scenario: Mutation requires approval
- **WHEN** a proposed fix involves a mutating action
- **THEN** it is surfaced as a proposal requiring explicit approval before execution
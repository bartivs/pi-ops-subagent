## Purpose

Environment contracts provide versioned, non-secret target identity and operational context. They never carry literal
credentials; connection profile identifiers are resolved outside model context.

## ADDED Requirements

### Requirement: Exact contract location and schema
Contracts SHALL be direct `*.md` children of `contractsDir` (default `<project>/.ops/contracts`, non-recursive). Each
file SHALL contain YAML frontmatter and an optional non-secret markdown notes body. Allowed frontmatter keys are:

- `version`: required integer `1`
- `name`: required string matching `^[a-z][a-z0-9-]{0,63}$`
- `targetId`: required non-empty string
- `expectedIdentity`: required non-empty string
- `verifyProfile`: required registered `probe_exec` profile name
- `connectionProfile`: required non-empty identifier, never a secret value
- `naming`: optional string-to-string map
- `runbooks`: optional string array
- `baselines`: optional string-to-number-or-string map

Unknown keys, duplicate contract names, invalid types, nested files, and empty required values SHALL invalidate only
the affected contract and produce diagnostics.

#### Scenario: Valid contract discovered
- **WHEN** a direct markdown file conforms to version 1 schema
- **THEN** it is available by `name` with canonical path and SHA-256 content hash

#### Scenario: Unsupported version
- **WHEN** a contract declares another version
- **THEN** it is rejected with supported version `1` and no child receives its content

### Requirement: Contract selection precedence
The call field `contracts` SHALL be an ordered array of 0-4 unique contract names. Selection precedence SHALL be
explicit call `contracts` > manifest `contract` as a one-item list > config `defaultContract` as a one-item list > no
contracts. Every selected name SHALL exist. Multiple selected contracts SHALL have identical `targetId`,
`expectedIdentity`, `verifyProfile`, and `connectionProfile`; conflicting targets SHALL fail before spawn.

#### Scenario: Explicit selection
- **WHEN** a call supplies `contracts: ["prod"]`
- **THEN** only `prod` is injected and manifest/config defaults are ignored

#### Scenario: Conflicting multi-contract selection
- **WHEN** selected contracts identify different targets or profiles
- **THEN** preflight fails with conflicting names/fields and no child starts

#### Scenario: No applicable contract
- **WHEN** call, manifest, and config provide no contract
- **THEN** the delegated task remains unchanged, details report an empty contract list, and probe behavior follows the no-contract restriction

### Requirement: Deterministic prompt injection
Selected normalized contracts SHALL be injected in caller-provided order before the delegated task under delimiters
`<ops_contract name="...">...</ops_contract>`. Injected data SHALL include exact normalized frontmatter values and
notes plus: `Verify expectedIdentity with verifyProfile before diagnostics. Never fall back to the local machine.` The
original delegated task SHALL follow under `<delegated_task>...</delegated_task>` and SHALL not be rewritten.

#### Scenario: Injection order
- **WHEN** two compatible contracts are selected
- **THEN** child prompt contains two contract blocks in selection order followed by one unchanged delegated-task block

#### Scenario: File edit
- **WHEN** a selected contract changes between calls
- **THEN** the next call uses its new content/hash while an already-running child remains unchanged

### Requirement: Secret-safe validation
Contracts SHALL contain identifiers, never credential values. Before spawn, validation SHALL reject and redact:
private-key block delimiters; bearer/basic authorization values; keys matching `password|passwd|token|secret|apiKey`
with non-placeholder values; and URI userinfo containing a password. Placeholders matching `${UPPER_SNAKE_CASE}` and
connection-profile identifiers are allowed. Literal secret content SHALL never reach prompts, observability, registry,
or artifacts.

#### Scenario: Profile reference
- **WHEN** `connectionProfile` is `prod-db-readonly`
- **THEN** the identifier reaches the child while connector code resolves any credential outside model context

#### Scenario: Literal secret
- **WHEN** contract text contains `password: actual-value`
- **THEN** preflight fails with canonical file, line, category, and `[REDACTED]` instead of the value

### Requirement: Single source of future-run context
Contract discovery SHALL run immediately before invocation. Naming, runbook, and baseline changes SHALL affect future
runs without package/code changes. Details SHALL record selected name, path, and hash.

#### Scenario: Baseline update
- **WHEN** a baseline changes in a valid contract
- **THEN** the next run receives the new normalized baseline and reports the new contract hash

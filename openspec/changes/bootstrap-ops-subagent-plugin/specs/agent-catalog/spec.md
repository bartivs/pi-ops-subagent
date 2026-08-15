## Purpose

The agent catalog makes pi-ops-subagent installable at user or repository scope and composes effective subagents from
bundled definitions, conventional user/project folders, and explicit configured folders with deterministic validation,
precedence, provenance, trust, and bundled-role opt-out.

## ADDED Requirements

### Requirement: Pi package installation without file copying
The package SHALL load from npm, git, or a local directory through pi's package mechanism. Installation without `-l`
SHALL write user settings; installation with `-l` SHALL write project `.pi/settings.json`. The package SHALL declare
`pi.extensions: ["./extensions"]` and SHALL NOT require copied or symlinked extension/agent files.

#### Scenario: Project-local local-path installation
- **WHEN** a user runs `pi install -l /absolute/path/to/pi-ops-subagent` in a trusted repository
- **THEN** project settings reference that package path and pi loads the extension plus packaged catalog on startup

#### Scenario: User-scoped installation
- **WHEN** a user runs `pi install npm:pi-ops-subagent` without `-l`
- **THEN** user settings make the extension available across projects

#### Scenario: Local source reload
- **WHEN** a locally referenced package source changes and the user runs `/reload`
- **THEN** pi reloads the extension and the next catalog discovery reads the changed files without reinstalling

### Requirement: Exact catalog source directories
Discovery SHALL scan direct, non-recursive `*.md` children from these source classes: package `<package>/agents`, user
`<getAgentDir()>/agents`, nearest trusted project `<project>/${CONFIG_DIR_NAME}/agents`, and each `.ops/config.json`
`agentDirs` entry. Each directory SHALL be canonicalized, files SHALL be sorted by canonical path, and missing/unreadable
directories SHALL produce diagnostics while other sources continue.

#### Scenario: Conventional project agent
- **WHEN** a trusted repository contains `${CONFIG_DIR_NAME}/agents/database-specialist.md`
- **THEN** the manifest is discovered with source `project` without modifying the package

#### Scenario: Configured local folder
- **WHEN** `.ops/config.json` contains `"agentDirs": ["subagents"]`
- **THEN** direct markdown files under `<project>/.ops/subagents` are discovered with source `configured`

#### Scenario: Nested file
- **WHEN** an agent directory contains `nested/agent.md`
- **THEN** v1 does not discover it and `/ops:agents` does not claim recursive scanning

### Requirement: Exact manifest schema
A manifest SHALL contain YAML frontmatter followed by a non-empty prompt body. Allowed frontmatter keys are:

- `name`: required string matching `^[a-z][a-z0-9-]{0,63}$`
- `description`: required non-empty string
- `kind`: optional enum `general | probe | artifact`, default `general`
- `tools`: optional comma-separated string or string array; normalized to unique non-empty tool names in input order
- `model`: optional non-empty model string
- `timeoutSeconds`: optional integer >= 1
- `thresholds`: optional array using the probe-protocol threshold schema; valid only for `kind: probe`
- `contract`: optional string matching the agent-name pattern

Unknown keys, invalid types, empty bodies, and duplicate names in the same directory SHALL invalidate that file/source
collision and SHALL NOT prevent unrelated valid files from loading.

#### Scenario: Valid custom manifest
- **WHEN** a file has valid required fields, supported optional fields, and a non-empty body
- **THEN** the normalized catalog entry contains every effective value plus source and canonical path

#### Scenario: Typo in timeout field
- **WHEN** a manifest uses `timeout` instead of `timeoutSeconds`
- **THEN** the file is rejected with an unknown-key diagnostic naming `timeoutSeconds` as the supported field

#### Scenario: Duplicate in one directory
- **WHEN** two files in one directory declare the same name
- **THEN** neither silently wins and `/ops:agents` reports both canonical paths as a duplicate-name error

### Requirement: Bundled definitions opt-out
Bundled definitions SHALL be enabled by default. Exact boolean project key `includeBundledAgents: false` SHALL skip all
package manifests before merge without disabling user, project, or configured sources.

#### Scenario: Opt out of included roles
- **WHEN** effective project config sets `includeBundledAgents: false`
- **THEN** no packaged probe, artifact, or other bundled definition appears in the effective catalog

#### Scenario: Custom-only operation
- **WHEN** bundled definitions are disabled and at least one custom source is valid
- **THEN** custom agents remain available and executable

### Requirement: Deterministic precedence and collision reporting
Cross-source name collisions SHALL resolve by configured directories (later `agentDirs` entry wins), then project,
then user, then bundled. Every winner SHALL retain source kind and canonical path. `/ops:agents` SHALL list each
shadowed source; shadowing SHALL NOT be treated as file validation failure.

#### Scenario: Project overrides bundled
- **WHEN** project and package manifests share a name
- **THEN** the project definition wins and bundled provenance appears as shadowed

#### Scenario: Configured directory ordering
- **WHEN** two configured directories define the same name
- **THEN** the definition from the later `agentDirs` array entry wins

### Requirement: Fresh discovery
Discovery SHALL run on `session_start`, `resources_discover` reload, and immediately before every invocation. An
invocation SHALL use one immutable catalog snapshot so files changing mid-run cannot alter the selected prompt.

#### Scenario: Edit between calls
- **WHEN** a manifest changes between two invocations
- **THEN** the second invocation uses the new content and provenance hash while the first remains unchanged

#### Scenario: Edit during call
- **WHEN** a selected manifest changes after child spawn
- **THEN** the running child continues with its captured prompt and the change applies only to later invocations

### Requirement: Project-controlled trust
Project and configured manifests SHALL be excluded unless `ctx.isProjectTrusted()` is true. Before interactive first
execution, approval SHALL be remembered at `<getAgentDir()>/pi-ops-subagent/trust.json` by project root, canonical
manifest path, and SHA-256 content hash. Changed content SHALL require reapproval. Repo-controlled files/config SHALL
NOT approve themselves. In JSON/print mode, an unapproved project-controlled manifest SHALL fail before spawn unless
user-controlled environment `PI_OPS_ALLOW_PROJECT_AGENTS=1` is present.

#### Scenario: Untrusted project
- **WHEN** project trust is false
- **THEN** project/configured manifests and `.ops/config.json` are not read and diagnostics state `project-untrusted`

#### Scenario: Changed approved agent
- **WHEN** an approved manifest's content hash changes
- **THEN** interactive execution requests approval again before spawn

#### Scenario: Headless fail closed
- **WHEN** JSON/print mode requests an unapproved project agent without the environment override
- **THEN** execution throws before spawn with approval and CI-override guidance

### Requirement: Catalog inspection
`/ops:agents` SHALL show config path, effective source order, bundled-enabled state, each selected entry's name,
description, kind, source, canonical path, model, tools, `timeoutSeconds`, contract, content hash, shadowed definitions, and all
validation/trust diagnostics. Unknown-agent and empty-catalog errors SHALL list searched directories and direct next
steps.

#### Scenario: Inspect effective catalog
- **WHEN** `/ops:agents` runs in TUI
- **THEN** it displays all effective entries, collisions, invalid files, trust exclusions, and source configuration

#### Scenario: Empty catalog
- **WHEN** no valid entry remains after filtering
- **THEN** invocation throws with searched paths and guidance to add a manifest or re-enable bundled definitions

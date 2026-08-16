## ADDED Requirements

### Requirement: Blueprints are inert initialization resources
An agent blueprint SHALL be recommendation and generation input only. Installing the package or discovering a blueprint SHALL NOT add an entry to the executable agent catalog, register a child agent, alter active tools, or write a project file. Only an approved initializer commit may turn selected blueprint-derived drafts into normal project agent manifests.

#### Scenario: Package installation
- **WHEN** pi-ops-subagent is installed with its bundled blueprints
- **THEN** `/ops:agents` shows no new executable agent solely because a blueprint exists

#### Scenario: Blueprint is recommended but not selected
- **WHEN** research recommends a blueprint and the user omits it from the staged manifests
- **THEN** no corresponding `${CONFIG_DIR_NAME}/agents/*.md` file is generated

### Requirement: Exact blueprint source directories
Blueprint discovery SHALL scan direct, non-recursive `*.md` children from these sources:

1. bundled `<package>/blueprints`;
2. user `<getAgentDir()>/pi-ops-subagent/blueprints`;
3. trusted current-project `<outputRoot>/${CONFIG_DIR_NAME}/ops-agent-blueprints`.

Each directory and file path SHALL be canonicalized, and files within a source SHALL be sorted by canonical path. Missing or unreadable directories SHALL produce bounded diagnostics while other sources continue. The project source SHALL be read only when `outputRoot` is inside the current trusted project root and `ctx.isProjectTrusted()` is true; scope confirmation for another repository SHALL NOT substitute for Pi project trust.

#### Scenario: User blueprint
- **WHEN** a valid direct markdown file exists in the user blueprint directory
- **THEN** it is available to initialization with source `user`

#### Scenario: Trusted project blueprint
- **WHEN** output targets the current trusted project and a valid file exists under `${CONFIG_DIR_NAME}/ops-agent-blueprints`
- **THEN** it is available with source `project`

#### Scenario: External output repository
- **WHEN** output targets another local repository not represented by the current Pi trust context
- **THEN** that repository's project blueprint directory is not read and diagnostics report `project-blueprints-untrusted`

#### Scenario: Nested blueprint
- **WHEN** a blueprint directory contains `nested/example.md`
- **THEN** v1 does not discover the nested file

### Requirement: Exact blueprint schema
A blueprint SHALL contain YAML frontmatter followed by a non-empty prompt body. Allowed frontmatter keys SHALL be the existing agent-manifest keys `name`, `description`, `kind`, `tools`, `model`, `timeoutSeconds`, `thresholds`, and `contract`, plus initializer keys `category`, `when`, and `recommendedByDefault`.

- `name`: required string matching `^[a-z][a-z0-9-]{0,63}$`;
- `description`: required string containing 1..1,000 UTF-8 bytes after trimming;
- `category`: required string matching `^[a-z][a-z0-9-]{0,63}$`;
- `when`: required string containing 1..1,000 UTF-8 bytes after trimming and describing applicability without executable detection rules;
- `recommendedByDefault`: optional exact boolean, default `false`;
- `kind`, `tools`, `model`, `timeoutSeconds`, `thresholds`, and `contract`: validated and normalized exactly as in the existing agent-manifest schema;
- prompt body: 1..51,200 UTF-8 bytes after trimming.

Unknown keys, wrong types, invalid values, and forbidden secret-like literals SHALL invalidate that file without blocking unrelated files. Duplicate tool names SHALL be normalized to the first occurrence in input order, matching the existing agent-manifest behavior. Secret diagnostics SHALL identify the field and canonical file but SHALL NOT echo the rejected literal. `${UPPER_SNAKE_CASE}` placeholders SHALL be allowed.

#### Scenario: Valid generic blueprint
- **WHEN** all required fields, optional manifest defaults, and the prompt body are valid
- **THEN** discovery returns a normalized inert blueprint with source, canonical path, and SHA-256 content hash

#### Scenario: Unknown key
- **WHEN** frontmatter contains an undeclared `framework` key
- **THEN** the blueprint is rejected with an unknown-key diagnostic rather than creating framework-specific implicit behavior

#### Scenario: Secret-like body
- **WHEN** a blueprint body contains a literal private key or credential-bearing URI
- **THEN** that blueprint is rejected and the diagnostic does not expose the literal

### Requirement: Deterministic blueprint collisions and precedence
Duplicate names within one source directory SHALL invalidate every file participating in that same-directory collision. Valid cross-source collisions SHALL resolve with precedence `project > user > bundled`. The winner SHALL retain source, canonical path, and content hash; every shadowed definition SHALL remain visible in initializer diagnostics. Discovery SHALL produce one immutable snapshot immediately after scope acceptance, when `outputRoot` is known; file changes SHALL apply to the next initialization, not the current snapshot.

#### Scenario: User overrides bundled
- **WHEN** user and bundled blueprints have the same valid name
- **THEN** the user definition wins and bundled provenance is reported as shadowed

#### Scenario: Duplicate in one directory
- **WHEN** two user blueprint files declare the same name
- **THEN** neither is available and diagnostics list both canonical paths

#### Scenario: Edit during initialization
- **WHEN** a blueprint changes after initialization starts
- **THEN** current recommendations retain the scope-time snapshot and a later initialization observes the changed hash

### Requirement: Generic bundled blueprint pack
The package SHALL include exactly these eight framework-agnostic blueprints, all with `kind: general` and default tools `read, grep, find, ls`:

| Name | Category | `recommendedByDefault` |
|---|---|---:|
| `architecture-review` | `architecture` | `true` |
| `testing-quality-review` | `testing-quality` | `true` |
| `security-review` | `security` | `true` |
| `data-persistence-review` | `data-persistence` | `false` |
| `api-integrations-review` | `api-integrations` | `false` |
| `performance-review` | `performance` | `false` |
| `deployment-operations-review` | `deployment-operations` | `false` |
| `documentation-review` | `documentation` | `false` |

Bundled names, descriptions, `when` guidance, and prompt bodies SHALL NOT name or assume a programming language, framework, database product, cloud, or repository layout. `recommendedByDefault` SHALL be recommendation guidance only; the current agent SHALL still justify and may omit any entry.

#### Scenario: Framework-neutral package contents
- **WHEN** bundled blueprint assets are inspected
- **THEN** they contain generic review responsibilities and no Django-specific or other framework-specific rules

#### Scenario: Conditional common category
- **WHEN** evidence contains no API or external integration surface
- **THEN** `api-integrations-review` may be omitted despite being available in the bundled pack

### Requirement: Blueprint-derived drafts remain editable
A staged manifest derived from a blueprint SHALL inherit omitted normalized manifest fields and body while retaining blueprint name, source, path, and hash only as preview provenance. Before staging, the current agent and user MAY change the generated agent name, description, kind, tools, optional fields, and prompt; exact `null` for a nullable optional stage field SHALL remove the inherited value. Blueprint provenance SHALL NOT be serialized into the final executable manifest.

#### Scenario: User narrows tools
- **WHEN** a blueprint declares four read tools and the user removes one before staging
- **THEN** the staged manifest uses the approved narrowed list and the final file contains no hidden blueprint defaults

#### Scenario: User creates an agent without a blueprint
- **WHEN** research identifies a useful category absent from the snapshot
- **THEN** the user may stage a conforming custom manifest with provenance `custom`

## ADDED Requirements

### Requirement: Managed root AGENTS.md guidance
Every staged initialization SHALL include usage guidance at `<outputRoot>/AGENTS.md`. The initializer SHALL create the file when absent or update only one managed section when present. It SHALL NOT create per-directory guidance files, replace the full existing file, or modify text outside the managed section except for the minimum line breaks required when appending a first section.

The exact marker lines SHALL be:

```text
<!-- pi-ops-subagent:init:start -->
<!-- pi-ops-subagent:init:end -->
```

#### Scenario: AGENTS.md is absent
- **WHEN** at least one valid manifest is staged and `<outputRoot>/AGENTS.md` does not exist
- **THEN** the preview includes creation of `AGENTS.md` containing exactly one managed section

#### Scenario: Unmanaged AGENTS.md exists
- **WHEN** a valid UTF-8 `AGENTS.md` has no managed markers
- **THEN** the preview preserves its existing bytes and appends one blank line followed by the managed section

#### Scenario: Managed section exists
- **WHEN** `AGENTS.md` contains exactly one start marker followed by exactly one end marker
- **THEN** the preview replaces the inclusive managed section and preserves prefix and suffix bytes

### Requirement: Marker and file validation
Before staging succeeds, an existing `AGENTS.md` SHALL be a regular, non-symbolic-link UTF-8 file no larger than 1,048,576 bytes. Zero markers or exactly one correctly ordered marker pair SHALL be valid. Orphaned, reversed, nested, or duplicate markers SHALL fail staging with manual-repair guidance. Marker matching SHALL require the exact full line after removing only a trailing `\r`; indented or extended lookalikes SHALL not be treated as managed markers.

#### Scenario: Duplicate markers
- **WHEN** an existing file contains two exact start markers
- **THEN** staging fails and preserves the file unchanged

#### Scenario: Symlinked AGENTS.md
- **WHEN** `<outputRoot>/AGENTS.md` is a symbolic link
- **THEN** staging fails before reading its target or producing a committable preview

#### Scenario: Oversized AGENTS.md
- **WHEN** the existing file exceeds 1,048,576 bytes
- **THEN** staging fails with the size limit and no file content in the diagnostic

### Requirement: Exact generated guidance template
The managed section SHALL be generated from the valid direct manifests that will exist in `<outputRoot>/${CONFIG_DIR_NAME}/agents` after applying the staged preview, including unchanged pre-existing manifests and excluding invalid files. Agents SHALL be sorted by normalized name. Descriptions SHALL collapse whitespace to one ASCII space, escape Markdown control characters and `<`/`>`, and truncate at a valid UTF-8 boundary to 300 bytes followed by `...` when longer. Existing invalid manifests SHALL be listed only in preview diagnostics.

The canonical LF template SHALL be:

```markdown
<!-- pi-ops-subagent:init:start -->
<H2> Project subagents

Project-owned agents are discovered from `<CONFIG_DIR_NAME>/agents`. Run `/ops:agents` to inspect effective definitions, provenance, validation, and approval state.

Use the `subagent` tool with a specific task. Generated project agents remain subject to project trust and content-hash execution approval.

<H3> Available agents
<AGENT_ROWS>

<H3> Invocation examples

Single agent:
`{"agent":"<AGENT_NAME>","task":"<TASK>"}`

Parallel agents, maximum 8:
`{"tasks":[{"agent":"<AGENT_NAME>","task":"<TASK>"},{"agent":"<OTHER_AGENT_NAME>","task":"<TASK>"}]}`
<!-- pi-ops-subagent:init:end -->
```

`<H2>` SHALL be replaced by the exact two ASCII characters `##`; each `<H3>` SHALL be replaced by the exact three ASCII characters `###`. `<CONFIG_DIR_NAME>` SHALL be replaced by Pi's effective configuration directory name. `<AGENT_ROWS>` SHALL render as a Markdown table with header `| Agent | Kind | Purpose |` and one row per agent in the exact form ``| `<NAME>` | <KIND> | <ESCAPED_DESCRIPTION> |``, sorted by normalized name; `<KIND>` is the normalized manifest kind. Invocation placeholders SHALL remain literal reusable placeholders; they SHALL NOT embed an arbitrary absolute path or project fact. For an existing file, generated section line endings SHALL match its first observed line ending (`CRLF` or `LF`); a new file SHALL use `LF`. A new file SHALL end with one final line ending.

#### Scenario: Existing and newly staged agents
- **WHEN** the target has one valid unchanged manifest and the preview creates another
- **THEN** `AGENT_ROWS` contains both names once in lexical order

#### Scenario: Framework-specific generated agent
- **WHEN** an approved generated agent is named for an observed framework
- **THEN** guidance may list that approved name and description while the static template remains framework-agnostic

#### Scenario: Description contains Markdown controls
- **WHEN** a manifest description contains backticks, brackets, or HTML-like text
- **THEN** the guidance row escapes those characters so they cannot terminate the managed block or create unintended markup

### Requirement: Guidance preview and transaction coupling
The complete before/after `AGENTS.md` diff, action `create | replace | unchanged`, before hash when present, and after hash SHALL be part of the immutable initializer preview. The same approval SHALL cover manifests and guidance. Guidance SHALL be committed and rolled back in the same transaction as the manifests; no separate approval or partial guidance update SHALL occur.

#### Scenario: User declines combined approval
- **WHEN** the confirmation displays manifest and `AGENTS.md` changes and the user declines
- **THEN** neither manifests nor guidance are written

#### Scenario: Guidance write fails
- **WHEN** manifest temporary files succeed but the `AGENTS.md` final rename fails
- **THEN** the transaction restores the previous manifests and `AGENTS.md` and does not report completion

### Requirement: Guidance remains user-owned outside markers
Users SHALL retain full ownership of `AGENTS.md` text outside the managed markers and MAY edit the managed section knowing the next approved initialization replaces it. The generated section SHALL contain no initializer ids, blueprint paths, content hashes, external context roots, hidden reasoning, secret-like values, or generated-at timestamps.

#### Scenario: Reinitialization after user edits outside markers
- **WHEN** a user changes text before or after the managed section and stages another initialization
- **THEN** preview and commit preserve those edits byte-for-byte

#### Scenario: External reference context
- **WHEN** recommendations used another repository as read-only context
- **THEN** the managed section contains no absolute path to that repository unless it already appears in user-owned text outside the markers

## ADDED Requirements

### Requirement: Natural-language initialization command
The extension SHALL register `/ops:agent-init` with one argument interpreted as a natural-language initialization prompt rather than a positional path grammar. The trimmed prompt SHALL contain 1..20,000 UTF-8 bytes. The command SHALL reject an empty or oversized prompt before changing tools or session state. The command SHALL require `ctx.isProjectTrusted()` to be true and SHALL use the current Pi agent; it SHALL NOT invoke the `subagent` tool or spawn a child Pi process.

#### Scenario: Prompt uses current directory defaults
- **WHEN** a trusted interactive user runs `/ops:agent-init Research this project and propose useful review agents` without naming a location
- **THEN** initialization starts with the command `ctx.cwd` as both the default context root and default output root

#### Scenario: Prompt includes intent and locations
- **WHEN** the prompt says to use one local repository as reference context and create agents in another local repository
- **THEN** the current agent receives the exact prompt and can propose distinct context roots and output root through the initializer scope tool

#### Scenario: Empty prompt
- **WHEN** `/ops:agent-init` receives only whitespace
- **THEN** the command reports that a natural-language prompt is required and creates no initialization state

#### Scenario: Untrusted project
- **WHEN** `ctx.isProjectTrusted()` is false
- **THEN** the command fails before reading blueprint sources, changing active tools, inspecting project files, or writing files

### Requirement: One guarded initialization at a time
Each Pi session branch SHALL have at most one active initialization. An initialization SHALL have an id matching `init-<UUID v4>`. While an initialization is non-terminal, another `/ops:agent-init` command SHALL deliver its prompt as a follow-up to the same initialization rather than create a second id. The extension SHALL preserve the exact active-tool list captured at initialization start and restore that list once when the initialization reaches a terminal state.

#### Scenario: Follow-up prompt revises an active initialization
- **WHEN** a user invokes `/ops:agent-init Focus more on deployment` while an initialization is `researching` or `staged`
- **THEN** the prompt is delivered to the current initializer conversation under the existing initialization id

#### Scenario: Terminal initialization permits a new run
- **WHEN** an initialization is `completed`, `cancelled`, or `failed` and the user invokes `/ops:agent-init` again with a valid prompt
- **THEN** a new initialization id and a new captured active-tool list are created

### Requirement: Exact initialization lifecycle
Initialization states SHALL be `resolving_scope | researching | staged | committing | completed | cancelled | failed`. Initial state SHALL be `resolving_scope`; terminal states SHALL be `completed | cancelled | failed`. Allowed transitions SHALL be:

- `resolving_scope -> researching` after valid scope acceptance;
- `researching -> staged` after a valid preview is staged;
- `staged -> staged` when a revised preview replaces the prior preview;
- `staged -> committing` after the commit tool validates the current immutable preview and receives UI approval;
- `committing -> completed` after every transaction output is committed;
- any non-terminal state except `committing -> cancelled` when the cancel tool runs;
- any non-terminal state -> `failed` on unrecoverable state, validation, or transaction failure.

No terminal state SHALL transition. `committing` SHALL reject cancellation and finish commit or rollback before becoming `completed` or `failed`.

#### Scenario: Successful lifecycle
- **WHEN** scope, research, staging, approval, and transaction commit succeed
- **THEN** observed states are `resolving_scope`, `researching`, `staged`, `committing`, and `completed` in order

#### Scenario: Revision invalidates old preview
- **WHEN** a staged initialization is staged again after user tweaks
- **THEN** it remains `staged`, replaces the current preview id, and makes the prior preview id uncommittable

#### Scenario: Cancellation during research
- **WHEN** the cancel tool runs while state is `researching`
- **THEN** state becomes `cancelled`, no project file is written, and the captured active tools are restored

### Requirement: Explicit scope contract
The tool `ops_agent_init_scope` SHALL accept exactly `initializationId`, `contextRoots`, `outputRoot`, and `allowNetwork`; additional properties SHALL be rejected at runtime. `contextRoots` SHALL contain 1..8 unique non-empty local directory paths. `outputRoot` SHALL be one non-empty local directory path. Relative paths SHALL resolve against the command `ctx.cwd`; every path SHALL be canonicalized with `realpath`, exist, and be a readable directory, and `outputRoot` SHALL additionally be writable. `allowNetwork` SHALL be boolean and SHALL be true when online research would give better context, such as remote systems, external tools, or general reference topics; the injected coordinator protocol SHALL instruct the agent to prefer `allowNetwork: true` for such topics and keep it false for purely local tasks. Runtime UI confirmation SHALL remain the authoritative attestation before any network tool activates.

The scope tool SHALL display canonical context roots and output root and SHALL obtain UI confirmation before accepting any path outside the canonical `ctx.cwd` tree. It SHALL also obtain explicit UI confirmation whenever `allowNetwork` is true; that confirmation is the runtime attestation that network research was requested. External-path or network scope SHALL be rejected when `ctx.hasUI` is false. Scope confirmation SHALL authorize research only; it SHALL NOT authorize file creation or replacement.

#### Scenario: Current-directory scope
- **WHEN** the scope tool receives `contextRoots: [ctx.cwd]`, `outputRoot: ctx.cwd`, and `allowNetwork: false`
- **THEN** it canonicalizes the directory and enters `researching` without an external-path confirmation

#### Scenario: External reference context
- **WHEN** any canonical context root is outside the `ctx.cwd` tree
- **THEN** the scope tool shows every canonical root and output root and waits for UI confirmation before entering `researching`

#### Scenario: External scope is declined
- **WHEN** the user declines the external-path confirmation
- **THEN** the initialization remains `resolving_scope` and no file under the declined root is inspected or written

#### Scenario: Invalid or duplicate root
- **WHEN** a root is missing, unreadable, not a directory, or resolves to the same canonical path as another context root
- **THEN** scope validation fails without changing state or reading project contents

#### Scenario: Network research confirmation
- **WHEN** the scope tool supplies `allowNetwork: true`
- **THEN** it displays the requested network capability and activates no network tool unless the user explicitly confirms

#### Scenario: Headless external or network scope
- **WHEN** JSON or print mode proposes an external root or `allowNetwork: true`
- **THEN** scope fails without inspecting the external root or activating a network tool

### Requirement: Enforced research tool boundary
Before scope acceptance, only the four initializer tools SHALL be callable. During `researching` and `staged`, callable project-inspection tools SHALL be limited to active `read`, `grep`, `find`, and `ls` tools plus `ops_agent_init_scope`, `ops_agent_init_stage`, `ops_agent_init_commit`, and `ops_agent_init_cancel`. If accepted scope has `allowNetwork: true`, the extension MAY additionally activate only those originally active tools named `web_search`, `source_check`, `fetch_content`, or `get_search_content` that are registered in the current Pi runtime.

The extension SHALL block every other tool call while initialization is non-terminal, including `bash`, `write`, `edit`, `subagent`, and unknown mutation-capable tools. File-oriented inspection calls SHALL be rejected when their resolved target falls outside accepted `contextRoots`. Prompt instructions SHALL supplement, not replace, these runtime restrictions.

#### Scenario: Mutation attempt during research
- **WHEN** the current agent attempts `write`, `edit`, `bash`, or `subagent` while initialization is `researching`
- **THEN** the extension blocks the call before execution and tells the agent to stage intended manifests through the initializer

#### Scenario: Out-of-scope read
- **WHEN** a file-oriented inspection tool targets a path outside all accepted context roots
- **THEN** the extension blocks the call before filesystem access

#### Scenario: Explicit network research
- **WHEN** the accepted scope has `allowNetwork: true` and `web_search` was registered and active before initialization
- **THEN** `web_search` may remain active while unrecognized network or mutation tools remain blocked

### Requirement: Current-agent research and recommendation behavior
After scope acceptance, the injected initializer protocol SHALL instruct the current agent to inspect context before recommending agents, separate observed evidence from user-provided inline context, report why each category is useful, prefer least-privilege tools, and avoid framework assumptions absent from evidence. Bundled blueprints SHALL be optional recommendation material, not a mandatory output set. The agent SHALL be able to propose an agent without a blueprint and SHALL be able to omit every bundled blueprint that does not fit.

The protocol SHALL run an explore-style pipeline that keeps the user involved: it SHALL instruct the coordinator to ask targeted clarifying questions about surface, boundaries, runtime/SSH wiring, and desired categories and to stop the turn so the user can answer; propose the candidate set as a Markdown table with columns `Agent | Kind | Purpose` grounded in evidence and blueprint provenance; stop the turn to let the user select, tweak, and approve; and stage only after explicit user approval. The protocol SHALL forbid fabricating evidence and SHALL forbid ending the turn with only prose (the coordinator SHALL end with a table, a question, or a tool call).

#### Scenario: Clarify before staging
- **WHEN** the user prompt leaves surface or wiring ambiguous
- **THEN** the coordinator asks clarifying questions and stops the turn instead of staging from guesses

#### Scenario: Table-proposed agent set
- **WHEN** the coordinator presents the candidate agents for user review
- **THEN** they are shown as a `Agent | Kind | Purpose` Markdown table and the user may select, tweak, and approve before staging

### Requirement: Definition completion task lists
Every custom prompt generated at stage SHALL end with a `### Definition completion task list` section: a checklist of tasks with blanks that the runtime agent completes, deciding the best course of action from the live task and context (mirroring the openspec propose step — propose the structure, leave the best-action blanks). Each task SHALL follow the shape `- [ ] <task> — <context>. <blank>`, be adapted to the agent's domain (docker is only an example — OS, cloud, web, data, and so on), cover targets, connection, scope/evidence, and output destination, and SHALL always end with an `Open decisions` task so unresolved facts are recorded instead of guessed. The protocol SHALL also instruct tool selection so generated definitions are runnable: `bash` for agents that run local commands (for example the docker or OS CLI), `write` for agents that author a document (or scope output to the caller), `ssh` for remote-over-SSH agents, and read-only inspection tools only for pure observers.

#### Scenario: Task list with blanks in every prompt
- **WHEN** the coordinator stages custom manifests
- **THEN** each prompt ends with a `### Definition completion task list` of `- [ ] …` tasks with blanks, including an `Open decisions` task, and the tool lists match what the agent actually executes

#### Scenario: Local command-running agent stays runnable
- **WHEN** a staged agent enumerates local workloads by running commands
- **THEN** it lists `bash` (for the local CLI) alongside read-only inspection tools rather than read/grep/find/ls alone

### Requirement: Exposed manifest schema and runtime-ambient guidance
The protocol SHALL expose the exact generated-manifest schema to the coordinator so it does not guess fields or kinds: allowed fields `name` (required), `description` (required), `prompt` (required unless `blueprintName` is set), and optional `kind`, `tools`, `model`, `timeoutSeconds`, `thresholds`, `contract`, and `blueprintName`. It SHALL give kind guidance: `general` for acting/SSH agents, `probe` for read-only observation, and `artifact` only for agents producing a structured incident artifact (triage/comms/PIR) and never for generic diagnostic/research report agents. It SHALL give optional-field shapes so the coordinator does not invent values: leave `timeoutSeconds`, `thresholds`, `contract`, and `model` OUT unless their exact shape is known; `contract` is a short lowercase slug string (never an object), `thresholds` is an array of metric objects (never a bare map), and `timeoutSeconds` is a whole number of seconds. The protocol SHALL also instruct the coordinator to treat the pi-ops-subagent package referenced by `.pi/settings.json` as ambient tooling infrastructure — not to ask the user about it, inspect its files, or shape agents around it unless the user explicitly requires it.

#### Scenario: Optional fields are not guessed
- **WHEN** the coordinator is not certain of the shape of `thresholds` or `contract`
- **THEN** it omits them instead of inventing values, and stage succeeds on the first attempt

### Requirement: SSH runtime tool
For manifests that act over SSH, the package SHALL register a minimal `ssh` runtime tool so a generated probe/general listing `tools: ["ssh", ...]` is runnable. The tool SHALL spawn the local `ssh` binary with a strict argv (no local shell string, so the remote `command` cannot inject local shell metacharacters), reject `host`/`identity` values that are not safe argv leaves, require a trusted project, request UI confirmation before opening a connection when interactive, use BatchMode to avoid password hangs, guarantee a kill timeout, bound output, and redact sensitive material. The protocol SHALL tell the coordinator that SSH-capable agents may list `ssh` in `tools` and that only tools the agent actually uses should be listed.

#### Scenario: Generated SSH probe uses the tool
- **WHEN** a staged manifest lists `tools: ["ssh", "read", "grep", "ls"]` for an SSH inspection probe
- **THEN** the `ssh` tool is registered by the package, gated by trust + confirmation, and the probe is runnable end to end

#### Scenario: Framework-specific project
- **WHEN** project evidence identifies a specific framework
- **THEN** recommendations may be specialized to that framework even though no framework-specific blueprint ships

#### Scenario: Blueprint does not fit
- **WHEN** a bundled category has no relevance to the researched context or user prompt
- **THEN** the agent may omit it and states no unsupported project claim

### Requirement: Stage-review separation
`ops_agent_init_stage` SHALL terminate its current agent turn after returning the complete staged preview summary and structured details. Its model-visible content SHALL be limited to 51,200 UTF-8 bytes or 2,000 lines with an explicit truncation marker; full generated bytes and diffs SHALL remain in structured details. Its custom renderer SHALL show paths/actions in compact mode and exact manifest text plus the `AGENTS.md` diff in expanded TUI mode; RPC/JSON consumers SHALL receive the same structured details. The visible summary SHALL state the output root and SHALL explicitly tell the user that this is a preview only, that no files were written, and that replying `commit` writes the files after a TUI confirmation (requesting changes restages; `cancel` abandons). In interactive mode the stage step SHALL also present the approval dialog immediately after building the preview: approving commits the exact immutable preview in the same step (writes the files and restores tools); declining or headless mode keeps the preview staged and writes nothing. A commit call in the same assistant tool-call batch SHALL still fail because no prior current preview existed during preflight. Users SHALL be able to request revisions in later turns, producing a new immutable preview.

#### Scenario: First preview
- **WHEN** stage validation succeeds
- **THEN** state becomes `staged`, the response identifies every proposed output and elevated tool capability, states that no files were written, and instructs the user to reply `commit` to write them, then the agent turn terminates without committing

#### Scenario: Immediate approval at stage
- **WHEN** the stage step is interactive and the user approves the presented dialog
- **THEN** the exact preview is committed in the same step (files written, tools restored, state `completed`) without a separate commit turn

#### Scenario: Stage declined or headless
- **WHEN** the user declines the stage dialog, or the stage step runs without a UI
- **THEN** the preview stays staged, no files are written, and the visible summary includes the commit/restage/cancel hand-off

#### Scenario: Commit guidance after stage
- **WHEN** the user sees the staged preview summary
- **THEN** it includes the output root and an explicit `commit` / restage / `cancel` hand-off so the next user action is unambiguous

#### Scenario: Parallel stage and commit attempt
- **WHEN** one assistant message attempts to call stage and commit together
- **THEN** commit fails preflight and no file is written

### Requirement: Interactive commit approval and mode behavior
`ops_agent_init_commit` SHALL accept exactly `initializationId` and `previewId`. It SHALL commit only the latest preview and only when `ctx.hasUI` is true. Its confirmation dialog SHALL be fully specified: it SHALL show the initialization id, preview id, canonical output root, every create/replace path as a row with its kind and tools (parsed from the manifest frontmatter for display only), the `AGENTS.md` action, and each selected tool outside `read | grep | find | ls` as elevated or unknown capability, and it SHALL state that approving writes the listed files to the output root while declining keeps the preview staged and writes nothing. Declining or dismissing confirmation SHALL retain `staged` state and write nothing. JSON and print modes SHALL support scope, research, and preview but SHALL reject commit with guidance to resume in TUI or RPC mode.

The `/ops:agent-init` command SHALL accept verbs so approval does not require a model turn: `approve [previewId]` (writes the staged preview after the specified dialog; defaults to the current preview id), `cancel` (abandons without writes), and `status` (reports state and current preview). A verb is recognized only when the argument is exactly the verb, or `approve` followed by a `preview-…` id; any other argument remains the natural-language initialization prompt, so prompts such as "status of docker services" are not misrouted.

#### Scenario: Approved TUI commit
- **WHEN** the latest preview id is supplied in TUI mode and the user confirms the displayed transaction
- **THEN** state enters `committing` and only the immutable preview is passed to generation

#### Scenario: Command approval
- **WHEN** the user runs `/ops:agent-init approve` against a staged preview
- **THEN** the specified dialog appears, and on confirmation the preview is committed without requiring the coordinator model to call the commit tool

#### Scenario: Stale preview id
- **WHEN** commit supplies an id from an earlier staged revision
- **THEN** it fails before confirmation and no file is written

#### Scenario: Headless commit
- **WHEN** commit is called in JSON or print mode
- **THEN** it fails before side effects and keeps the preview available in session details

### Requirement: Completion verification steps
After a successful commit, the injected protocol SHALL instruct the coordinator to verify completion itself within the accepted roots before ending the turn, without assuming the write succeeded: confirm every committed path exists and matches the preview (names and count via `ls`/`read`), confirm `AGENTS.md` contains the managed section with the expected table rows, confirm no temporary or staged leftovers remain in the output root, and confirm the initializer tools are no longer the active set (tool restore happened). The coordinator SHALL report the verification result explicitly and, on any failure, state exactly what failed and how to fix it.

#### Scenario: Post-commit verification
- **WHEN** commit writes the preview files and `AGENTS.md`
- **THEN** the coordinator re-checks the written paths and the managed table within the accepted roots and reports the result before ending the turn

#### Scenario: Missing committed file detected
- **WHEN** a path named in the preview does not exist after commit
- **THEN** the coordinator reports exactly which file is missing and how to fix it instead of declaring success

### Requirement: Session-scoped recovery and cleanup
Before commit, initializer state SHALL be stored only in extension memory and initializer tool-result details on the active session branch; no draft, registry, lock, or report file SHALL be created in the project. On reload, the extension SHALL reconstruct the latest valid non-terminal initialization and its preview from current-branch tool details, reapply the guarded active-tool set, and continue. Missing, malformed, or hash-inconsistent recovery details SHALL move the recovered initialization to `failed` without project writes. Session shutdown SHALL restore tools in memory and SHALL NOT create project state.

#### Scenario: Reload with staged preview
- **WHEN** Pi reloads after a valid staged preview
- **THEN** the same initialization and preview ids are restored and the project remains unchanged until approval

#### Scenario: Corrupt recovery details
- **WHEN** persisted tool-result details do not validate or their preview hash is inconsistent
- **THEN** recovery fails closed, no files are written, and the user is told to start a new initialization

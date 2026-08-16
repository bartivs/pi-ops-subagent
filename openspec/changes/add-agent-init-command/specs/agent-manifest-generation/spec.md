## ADDED Requirements

### Requirement: Exact staging input contract
The tool `ops_agent_init_stage` SHALL accept exactly `initializationId`, `manifests`, and `replaceExisting`; additional properties SHALL be rejected at runtime. `manifests` SHALL contain 1..32 objects with unique `name` values. Each object SHALL allow exactly:

- `name` and `description`: required, with the existing agent-manifest types and validation;
- `kind` and `tools`: optional, with existing agent-manifest types and validation;
- `model`, `timeoutSeconds`, `thresholds`, and `contract`: optional existing agent-manifest value or exact `null`, where `null` explicitly removes a blueprint value;
- `prompt`: optional string containing 1..51,200 UTF-8 bytes after trimming;
- `blueprintName`: optional blueprint name from the initialization's immutable snapshot.

A supplied `blueprintName` SHALL resolve to the captured snapshot. For a blueprint-derived object, each omitted field other than required `name` and `description` SHALL inherit its blueprint value, while explicit `null` SHALL omit a nullable optional field; the draft `name` and `description` remain freely editable required values. Without `blueprintName`, omitted `kind` SHALL default to `general`, omitted `tools` SHALL default to `read, grep, find, ls`, optional nullable fields SHALL remain absent, and `prompt` SHALL be required. Omitted blueprint-derived `prompt` SHALL copy the blueprint body. `replaceExisting` SHALL be an array of unique agent names, default `[]`, and every listed name SHALL correspond to an existing exact target `<agent-name>.md`. Omitted `blueprintName` SHALL mean provenance `custom`. All inputs SHALL be validated before filesystem mutation.

#### Scenario: Minimal custom draft
- **WHEN** staging supplies only valid `name`, `description`, and `prompt` for one manifest
- **THEN** its normalized draft has `kind: general`, tools `read, grep, find, ls`, and custom provenance

#### Scenario: Blueprint body inheritance
- **WHEN** staging supplies valid required fields and `blueprintName` but omits `prompt`, kind, tools, and optional fields
- **THEN** normalization uses the captured blueprint body and values

#### Scenario: Remove blueprint optional value
- **WHEN** a blueprint has `model` and its draft supplies `model: null`
- **THEN** the normalized generated manifest omits `model`

#### Scenario: Custom draft omits prompt
- **WHEN** a draft omits both `blueprintName` and `prompt`
- **THEN** staging fails before preview creation

#### Scenario: Unknown generated argument
- **WHEN** a model-generated manifest object contains an undeclared field
- **THEN** staging fails before preview creation or filesystem mutation

#### Scenario: Excessive manifest count
- **WHEN** staging supplies 33 manifests
- **THEN** staging fails and the previous current preview, if any, remains current

### Requirement: Generated manifests conform to the existing catalog
Each generated manifest SHALL be a direct file at `<outputRoot>/${CONFIG_DIR_NAME}/agents/<name>.md`, where `<name>` is the normalized manifest name. Output SHALL use UTF-8, LF line endings, and one final newline. Frontmatter keys SHALL be serialized in this order when present: `name`, `description`, `kind`, `tools`, `model`, `timeoutSeconds`, `thresholds`, `contract`. Strings and arrays SHALL use JSON-compatible YAML values, followed by the exact approved trimmed prompt body. `blueprintName` and all initializer provenance SHALL NOT be serialized. Before staging succeeds, generated text SHALL round-trip through the existing `parseManifest` validator and preserve every normalized field.

#### Scenario: Deterministic generated file
- **WHEN** the same normalized manifest is staged twice against unchanged filesystem inputs
- **THEN** both previews contain byte-identical manifest output

#### Scenario: Round-trip mismatch
- **WHEN** serialization and existing catalog parsing produce different normalized values
- **THEN** staging fails and no preview is committable

### Requirement: Secret-safe generated content
Before preview creation, the initializer SHALL scan every generated frontmatter string, prompt body, and usage-guidance substitution for credential-like literals using the package secret policy. Literal passwords, access tokens, private keys, and credential-bearing URIs SHALL fail staging. `${UPPER_SNAKE_CASE}` references SHALL remain allowed. Diagnostics SHALL identify the manifest and field but SHALL NOT echo the rejected value. The initializer SHALL NOT silently redact or repair an approved draft.

#### Scenario: Credential in prompt
- **WHEN** a draft prompt contains a literal credential-bearing URI
- **THEN** staging fails without including that URI in model-visible output, logs, preview details, or files

#### Scenario: Environment placeholder
- **WHEN** a draft refers to `${DATABASE_URL}` without a literal credential value
- **THEN** the placeholder is accepted and preserved

### Requirement: Collision and replacement policy
Staging SHALL inspect direct existing target agent files before producing a preview. Actions SHALL be `create | replace | unchanged`:

- absent target path -> `create`;
- byte-identical target path -> `unchanged`;
- differing exact target path listed in `replaceExisting` -> `replace`;
- differing exact target path not listed in `replaceExisting` -> staging failure.

A `replaceExisting` name with no differing exact target SHALL fail as stale or invalid. If another direct file declares the proposed manifest name under a different filename, staging SHALL fail and require manual resolution; it SHALL NOT delete or rename that file. Invalid unrelated existing manifests SHALL be reported in preview diagnostics but SHALL NOT be modified. Any target path or parent directory that is a symbolic link SHALL fail closed.

#### Scenario: Existing file without replacement approval
- **WHEN** `<name>.md` exists with different bytes and `replaceExisting` omits the name
- **THEN** staging fails with rename-or-replace guidance and leaves the file unchanged

#### Scenario: Explicit exact replacement
- **WHEN** a differing `<name>.md` exists and its name is listed in `replaceExisting`
- **THEN** the preview marks that path `replace` and includes its before/after hash and diff

#### Scenario: Same name in another file
- **WHEN** `legacy.md` already declares the name proposed for `review.md`
- **THEN** staging fails rather than creating a duplicate catalog name

#### Scenario: Symlinked agent directory
- **WHEN** `${CONFIG_DIR_NAME}/agents` or a target manifest is a symbolic link
- **THEN** staging fails before following or replacing the link

### Requirement: Immutable complete preview
A successful stage SHALL produce `previewId` matching `preview-<64 lowercase SHA-256 hex>` over canonical JSON containing initialization id, canonical output root, normalized manifests, generated bytes and hashes, existing-input hashes, manifest actions, exact `AGENTS.md` bytes/action, blueprint provenance, diagnostics, and elevated-tool warnings. Object keys SHALL be sorted lexicographically for hashing and arrays SHALL retain their defined order. Manifests and output paths SHALL be displayed sorted by manifest name. The structured preview SHALL be persisted in tool-result details and SHALL be the sole commit input identified by `previewId`.

Every tool outside `read`, `grep`, `find`, and `ls` SHALL be labeled `elevated-or-unknown` in the preview and approval summary; this label SHALL NOT claim the tool is mutating. Unknown existing-manifest and blueprint diagnostics SHALL remain bounded to 100 entries and 51,200 UTF-8 bytes, with omitted counts reported.

#### Scenario: Elevated tool warning
- **WHEN** a draft includes `bash` or a custom tool
- **THEN** the preview names that agent and tool under `elevated-or-unknown` before approval

#### Scenario: Filesystem changes after preview
- **WHEN** any recorded existing target or `AGENTS.md` hash changes after staging
- **THEN** the preview id remains immutable but commit rejects it as stale before writing

### Requirement: Rollback-capable transaction
Commit SHALL revalidate preview hash, state, canonical paths, symlink policy, existing-input hashes, and output-root writability before side effects. It SHALL then:

1. create missing `${CONFIG_DIR_NAME}` and `agents` directories with mode `0755` only when required;
2. write every changed output to a unique same-directory temporary file with mode `0644` and verify its SHA-256 hash;
3. rename replaced files to unique same-directory backups;
4. rename temporary files to final paths;
5. remove backups and temporary files after all final renames succeed.

On failure after side effects begin, commit SHALL remove newly installed files, restore every backup and original mode, remove temporary files, and remove directories created by this transaction when empty. Successful rollback SHALL end initialization `failed` with no content change. Failed rollback SHALL also end `failed` and SHALL report only affected canonical paths and recovery guidance, never file contents or secrets. The transaction SHALL include all changed manifests and managed `AGENTS.md` output; partial success SHALL never be reported as `completed`.

#### Scenario: Successful multi-file commit
- **WHEN** every preflight check, temporary write, backup, and rename succeeds
- **THEN** all previewed changed outputs appear with approved bytes and state becomes `completed`

#### Scenario: Mid-rename failure
- **WHEN** one final rename fails after an earlier output was installed
- **THEN** rollback removes the new output, restores originals, and state becomes `failed`

#### Scenario: Stale input before side effects
- **WHEN** a recorded existing file hash changed since preview
- **THEN** commit fails before creating directories, temporary files, or backups

### Requirement: No-op and post-commit behavior
If every manifest and the generated managed guidance are `unchanged`, approval SHALL complete as a no-op without temporary files or timestamp-only changes. After a successful commit, result details SHALL list created, replaced, and unchanged paths plus SHA-256 hashes, restore the captured active tools, and explain that `/ops:agents` performs fresh discovery. When output root is not the current project, guidance SHALL tell the user to open and trust that target repository before execution. Generated project manifests SHALL remain subject to the existing per-content-hash execution approval behavior.

#### Scenario: No-op commit
- **WHEN** approved preview bytes equal every existing output
- **THEN** commit becomes `completed`, reports all paths unchanged, and does not rewrite them

#### Scenario: Current project discovery
- **WHEN** commit succeeds in the current trusted project
- **THEN** `/ops:agents` can discover the new manifests without requiring an extension reload

#### Scenario: External output target
- **WHEN** commit succeeds in another repository
- **THEN** completion guidance states that repository must be opened and trusted and that each generated project agent still requires normal execution approval

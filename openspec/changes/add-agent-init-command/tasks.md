## 1. Shared contracts and catalog reuse

- [x] 1.1 Add initializer/blueprint/preview/action/state constants and versioned public types to `extensions/constants.ts` and `extensions/types.ts`; add boundary assertions to `tests/agent-init-state.test.ts`; pass `npx tsx --test tests/agent-init-state.test.ts` and `npm run typecheck`.
- [x] 1.2 Factor reusable manifest normalization from `extensions/catalog.ts` without changing executable-catalog parsing, diagnostics, precedence, or trust behavior; extend `tests/catalog.test.ts` and `tests/artifact-parse.test.ts`; pass `npx tsx --test tests/catalog.test.ts tests/artifact-parse.test.ts` and `npm run typecheck`.

## 2. Inert blueprint catalog

- [x] 2.1 Implement strict blueprint parsing, secret validation, byte bounds, source-local duplicate handling, precedence, trust filtering, immutable snapshots, and bounded diagnostics in `extensions/blueprints.ts`; add `tests/blueprints.test.ts`; pass `npx tsx --test tests/blueprints.test.ts` and `npm run typecheck`.
- [x] 2.2 Add the exact eight framework-neutral assets under `blueprints/*.md`, update `package.json` publication files without adding Pi resources, and test exact names/defaults plus absence from executable discovery in `tests/blueprints.test.ts` and `tests/bundled-agents.test.ts`; pass `npx tsx --test tests/blueprints.test.ts tests/bundled-agents.test.ts` and `npm run typecheck`.

## 3. Managed usage guidance

- [x] 3.1 Implement exact marker parsing, UTF-8/size/symlink validation, line-ending preservation, deterministic template rendering, description escaping/truncation, and outside-section byte preservation in `extensions/usage-guidance.ts`; add `tests/usage-guidance.test.ts`; pass `npx tsx --test tests/usage-guidance.test.ts` and `npm run typecheck`.
- [x] 3.2 Implement post-preview direct-manifest composition and invalid-existing-manifest diagnostics for managed `AGENTS.md` rows in `extensions/usage-guidance.ts`; cover existing/new/invalid/colliding manifests in `tests/usage-guidance.test.ts`; pass `npx tsx --test tests/usage-guidance.test.ts` and `npm run typecheck`.

## 4. Manifest staging and immutable previews

- [x] 4.1 Implement strict stage-input validation, custom defaults, blueprint inheritance, explicit-null removal, deterministic JSON-compatible YAML serialization, threshold ordering, secret rejection, and `parseManifest` round-trip comparison in `extensions/manifest-generation.ts`; add focused cases to `tests/manifest-generation.test.ts`; pass `npx tsx --test tests/manifest-generation.test.ts` and `npm run typecheck`.
- [x] 4.2 Implement existing-target inspection, symlink/name/path collision rules, per-name replacement authorization, create/replace/unchanged actions, input hashes, diffs, elevated-or-unknown warnings, diagnostic bounds, canonical JSON, and `preview-<sha256>` generation in `extensions/manifest-generation.ts`; complete preview fixtures in `tests/manifest-generation.test.ts`; pass `npx tsx --test tests/manifest-generation.test.ts` and `npm run typecheck`.
- [x] 4.3 Implement stale-input preflight, same-directory temp/backup writes, mode handling, ordered final renames, no-op commits, cleanup, and rollback in `extensions/manifest-generation.ts`; inject filesystem failures in `tests/manifest-generation.test.ts` to prove no partial completion and original restoration; pass `npx tsx --test tests/manifest-generation.test.ts` and `npm run typecheck`.

## 5. Initializer state and safety boundary

- [x] 5.1 Implement the exact lifecycle reducer, one-active-initialization rule, recoverable versus terminal errors, current-preview replacement, and versioned branch recovery in `extensions/agent-init.ts`; complete transition/corruption/reload tests in `tests/agent-init-state.test.ts`; pass `npx tsx --test tests/agent-init-state.test.ts` and `npm run typecheck`.
- [x] 5.2 Implement scope runtime validation, realpath containment, external/network UI confirmation, trusted project-blueprint eligibility, read-tool path gating, state-specific allowlists, optional approved network tools, and exact active-tool restoration in `extensions/agent-init.ts`; test preflight, symlink escape, headless refusal, blocked mutation/subagent, and restoration in `tests/agent-init-state.test.ts`; pass `npx tsx --test tests/agent-init-state.test.ts` and `npm run typecheck`.

## 6. Command, tools, and rendering

- [x] 6.1 Register `/ops:agent-init`, the `ops:agent-init-request` message/renderer, and the four strict initializer tools in `extensions/agent-init.ts`; wire them from `extensions/index.ts`; verify exact natural-language coordinator protocol, prompt bounds, trust refusal, current-cwd defaults, follow-up routing, and no child spawn in `tests/agent-init-command.test.ts`; pass `npx tsx --test tests/agent-init-command.test.ts` and `npm run typecheck`.
- [x] 6.2 Connect scope-time blueprint snapshots and stage/revision execution to the state reducer in `extensions/agent-init.ts`; return bounded model-visible summaries, complete structured details, `terminate: true`, compact actions, and expanded exact preview rendering; cover same-batch commit rejection and stale revision ids in `tests/agent-init-command.test.ts`; pass `npx tsx --test tests/agent-init-command.test.ts` and `npm run typecheck`.
- [x] 6.3 Connect commit/cancel execution to UI approval and transaction code in `extensions/agent-init.ts`; display roots/actions/`AGENTS.md`/capability warnings, reject headless commits, preserve staged state on decline, restore tools on terminal results, and redact errors; cover approve/decline/cancel/failure paths in `tests/agent-init-command.test.ts`; pass `npx tsx --test tests/agent-init-command.test.ts` and `npm run typecheck`.

## 7. Integration and compatibility

- [ ] 7.1 Add `tests/integration-agent-init.test.ts` for trusted current-directory create, user revision, explicit replacement, unchanged no-op, managed-section preservation, external context/output confirmation, reload recovery, and post-commit `/ops:agents` discovery; pass `npx tsx --test tests/integration-agent-init.test.ts` and `npm run typecheck`.
- [ ] 7.2 Run existing catalog, runner, trust, tool-schema, lifecycle, package-metadata, and persistence suites after initializer wiring; make compatibility-only corrections in affected `extensions/*.ts` without altering normative behavior; pass `npx tsx --test tests/catalog.test.ts tests/catalog-trust.test.ts tests/runner.test.ts tests/tool-schema.test.ts tests/bundled-agents.test.ts tests/integration-persistence.test.ts` and `npm run typecheck`.

## 8. Documentation and release verification

- [ ] 8.1 Document `/ops:agent-init <prompt>`, inline/local/external context semantics, generic blueprint defaults and extension paths, preview/revision/approval, generated `${CONFIG_DIR_NAME}/agents/*.md` plus managed `AGENTS.md`, elevated tools, trust, and headless limits in `README.md`; verify documented paths and commands against specs with `npx tsx --test tests/agent-init-command.test.ts tests/blueprints.test.ts`.
- [ ] 8.2 Perform a package-files smoke check proving `blueprints/` is published but not loaded as executable Pi resources, then run `npm pack --dry-run`, `npm test`, and `npm run typecheck`; do not mark complete unless every command succeeds and no runtime dependency or framework-specific bundled asset was added.

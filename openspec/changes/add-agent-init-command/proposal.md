## Why

Users can add project agents today only by authoring strict manifests manually, which makes initial catalog design difficult and encourages copied, over-privileged definitions. A guided, framework-agnostic initializer can use the current Pi agent to research user-supplied context, recommend common agent categories, and create only the manifests the user reviews and approves.

## What Changes

- Add `/ops:agent-init <prompt>` as a natural-language initialization entrypoint; absent location instructions, both research context and output target default to the current working directory.
- Add a guarded initialization lifecycle in which the current Pi agent resolves scope, performs local read-only research, stages editable recommendations, and commits an immutable preview only after explicit approval.
- Add an inert blueprint catalog with generic bundled blueprints plus user and trusted-project extension sources; blueprints are recommendation material and never become executable catalog agents by installation alone.
- Generate normal, user-owned `<target>/${CONFIG_DIR_NAME}/agents/*.md` manifests (normally `.pi/agents`) selected and customized during initialization, plus a managed usage section in the target root `AGENTS.md`, without creating configuration, registries, reports, framework-specific agents by installation alone, or application-code changes.
- Support inline prompt context, multiple local context roots, and one output root while preventing unapproved external-path inspection, mutation-tool bypass, secret leakage, silent overwrite, and headless commits.
- Add catalog inspection and target-trust guidance after successful generation while preserving the existing project trust and per-manifest execution approval boundary.

## Capabilities

### New Capabilities
- `agent-initialization`: Natural-language command behavior, scope resolution, guarded research, staging, revision, approval, cancellation, and mode behavior.
- `agent-blueprints`: Strict inert blueprint format, generic bundled defaults, extensible source discovery, precedence, trust, and diagnostics.
- `agent-manifest-generation`: Preview validation, deterministic output paths, collision policy, atomic commit/rollback, generated-file contract, and post-generation catalog integration.
- `agent-usage-guidance`: Safe creation or replacement of a managed `AGENTS.md` section explaining the approved project agents and how to invoke them.

### Modified Capabilities

None. The existing catalog contract remains unchanged; generated files conform to it.

## Impact

- Extension registration and lifecycle wiring in `extensions/index.ts`, with new initializer, blueprint, and generation modules plus shared types/constants.
- New generic blueprint assets included in package publication metadata.
- Focused parser, state, safety, persistence, command, and integration tests.
- README documentation for interactive initialization, custom blueprint sources, trust, generated artifacts, and managed `AGENTS.md` guidance.
- No new runtime dependency, no active bundled agent, and no change to existing `subagent` tool inputs or agent-manifest schema.

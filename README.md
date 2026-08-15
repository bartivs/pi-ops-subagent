# pi-ops-subagent

Operations-first subagent fleet for [pi](https://github.com/earendil-works/pi). It runs isolated `pi --mode json`
children for read-only investigation, preserves bounded/redacted evidence, and exposes foreground, durable background,
named-session, and fleet-cockpit workflows.

## Install

Install globally for the user:

```sh
pi install npm:pi-ops-subagent
# or from git:
pi install git:github.com/bartivs/pi-ops-subagent
# or from a local checkout:
pi install /absolute/path/to/pi-ops-subagent
```

Install only for the current project with `-l`:

```sh
pi install -l npm:pi-ops-subagent
pi install -l git:github.com/bartivs/pi-ops-subagent
pi install -l /absolute/path/to/pi-ops-subagent
```

The package metadata loads `extensions/index.ts` and the bundled `agents/*.md` files directly; installation does not
copy or symlink agent definitions into the project.

## Configuration

The nearest `.ops/config.json` is discovered from the current working directory upward. Project configuration is honored
only after pi project trust is granted.

| Key | Default | Meaning |
|---|---:|---|
| `timeoutSeconds` | `300` | Default child timeout, integer >= 1 |
| `timeoutCeilingSeconds` | `900` | Hard timeout ceiling |
| `concurrency` | `2` | Parallel worker count, 1-8 |
| `includeBundledAgents` | `true` | Include packaged probe/artifact agents |
| `agentDirs` | `[]` | Trusted direct custom-agent directories |
| `defaultContract` | `null` | Default `.ops/contracts` manifest |
| `contractsDir` | `contracts` | Relative to `.ops/config.json` |
| `runsDir` | `runs` | Durable jobs under `.ops` |
| `sessionsDir` | `sessions` | Named children under `.ops` |
| `sessionExpiryMs` | `604800000` | Seven-day idle expiry; minimum 60000 |
| `fleetShortcut` | `alt+o` | Focused fleet overlay shortcut |
| `fleetWidgetLines` | `3` | Passive widget lines, 1-8 |
| `fleetRetentionMs` | `900000` | Finished-run age retention; 0 disables age retention |
| `fleetRetentionCount` | `50` | Finished-run count retention, 0-500 |
| `fleetStaleAfterMs` | `30000` | Stale warning interval, minimum 5000 |

Example:

```json
{
  "timeoutSeconds": 300,
  "timeoutCeilingSeconds": 900,
  "concurrency": 2,
  "includeBundledAgents": true,
  "agentDirs": ["agents"],
  "contractsDir": "contracts",
  "runsDir": "runs",
  "sessionsDir": "sessions",
  "fleetShortcut": "alt+o"
}
```

State is stored at `.ops/runs` and `.ops/sessions`; contracts are `.ops/contracts` and should remain private.

## Agents and contracts

Custom agents are direct `*.md` files in a trusted `agentDirs` directory. They require strict frontmatter:

```markdown
---
name: latency-review
description: Read-only latency review
kind: general
tools: read, grep, find
---

Use only supplied evidence. Return a bounded digest.
```

`probe` agents are read-only and receive the verification/evidence protocol. Mutation proposals must be explicitly
approved; this package does not autonomously remediate. Contracts are versioned `.ops/contracts/*.md` documents and
must not contain literal passwords, tokens, private keys, or credential-bearing URIs. Use `${UPPER_SNAKE_CASE}`
placeholders and external connection profiles instead. Secret-like values are rejected or redacted before prompts,
logs, and artifacts. In headless mode, project agents require approval or `PI_OPS_ALLOW_PROJECT_AGENTS=1`.

Set `includeBundledAgents` to `false` for custom-only operation.

## Tool and commands

The `subagent` tool accepts one of:

```text
{ "agent": "probe-host", "task": "check disk and memory" }
{ "tasks": [{ "agent": "probe-host", "task": "..." }, { "agent": "probe-net", "task": "..." }] }
{ "chain": [{ "agent": "probe-host", "task": "..." }, { "agent": "triage", "task": "use {previous}" }] }
```

Common options include `timeoutSeconds`, `session`, `restartExpired`, `contracts`, and `runAsync`. Output is capped at
51200 UTF-8 bytes or 2000 lines; raw child events stay extension-local.

Commands:

- `/ops:agents` — effective catalog, provenance, trust diagnostics.
- `/ops:status` — active and retained run snapshots.
- `/ops:jobs list|inspect <id>|resume <id>|cancel <id>` — durable background jobs.
- `/ops:session list|info <handle-or-key>|end <handle-or-key>|cleanup <handle-or-key>` — named children.
- `Alt+o` — focused fleet overlay in TUI mode; the passive widget never captures editor input.

Artifact agents `triage`, `comms`, and `pir` return one strict JSON object. Unknown facts use `UNKNOWN`, unsupported
hypotheses cite no evidence with confidence zero, and partial parallel composition preserves successful artifacts.

## Development

```sh
npm install
npm test
npm run typecheck
```

MIT — see [LICENSE](LICENSE).

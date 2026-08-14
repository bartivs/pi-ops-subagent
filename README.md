# pi-ops-subagent

**Operations-first subagent fleet for the [pi](https://github.com/earendil-works/pi) coding agent.**

Delegates ops work — triage, RCA, health probes, runbook verification — to isolated, read-only subagents that run in
their own `pi` subprocesses with a bounded context, return **evidence-only digests** to the parent, and are watched
live in a keyboard-driven **fleet cockpit** widget. Raw tool output never pollutes your conversation.

> Status: **spec phase** — OpenSpec-driven planning in `openspec/`. See
> [bootstrap-ops-subagent-plugin](openspec/changes/bootstrap-ops-subagent-plugin/proposal.md) for the change proposal.

## Why ops-first?

SOTA on agentic operations (ORCA-bench, Datadog Bits, New Relic SRE Agent, Microsoft On-Call Copilot, ACE) says
agents are not ready for unsupervised on-call. The defensible posture — and this plugin's design — is:

- **Autonomous investigation, gated action** — probes diagnose freely; mutation always requires explicit approval.
- **Read-only by construction** — per-agent `tools:` allowlists, target-verification-first, evidence-only output.
- **Context hygiene** — subagents run isolated (`--mode json` children); only their final digest returns; the widget
  is your live sight.

## Planned capabilities (specs)

| Capability | Spec |
|---|---|
| Runner: single / parallel / chain, per-call timeouts, usage, caps | `specs/subagent-runner` |
| Probe protocol: read-only, thresholds, no-fabricate | `specs/probe-protocol` |
| Env contracts: target/context injection from `.ops/contracts/` | `specs/env-contracts` |
| Background & scheduled jobs with durable registry | `specs/background-jobs` |
| Named persistent sessions (interview-style diagnosis) | `specs/named-sessions` |
| Fleet cockpit: live tabbed widget | `specs/fleet-cockpit` |
| Incident artifacts: triage / comms / PIR with JSON contracts | `specs/incident-artifacts` |

## Origins

This is the generalization of a private production server-diagnostics extension (isolated subagent runner, live
tabbed widget, target-context injection, digest-only reporting) into a vendor-neutral, installable pi package.

> Builder note: provenance, porting checklist, and internal conventions live in the gitignored `.notes/` directory
> of the local checkout (never pushed).

## License

MIT — see [LICENSE](LICENSE).

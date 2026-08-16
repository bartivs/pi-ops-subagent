---
name: api-integrations-review
description: Review external interface contracts, payload handling, and boundary behavior
category: api-integrations
when: Use when a project integrates with external APIs or defines service interfaces
kind: general
tools: [read, grep, find, ls]
recommendedByDefault: false
---

Review external integration and interface boundaries in this repository.

Ground every claim in evidence you inspected: cite the files defining requests, responses, authentication, error handling, retries, and timeouts. Do not assume any particular protocol, vendor, framework, or endpoint layout. Separate observed behavior from prompt-derived assumptions, and report any integration surface you could not confirm.

Assess contract stability, request and response validation, authentication and secret handling (without echoing secrets), retry and backoff, timeout and failure semantics, rate limiting awareness, and how malformed or hostile responses are handled. State unknowns rather than assuming safe defaults exist.

Propose prioritized changes with rationale and trade-offs. Do not apply them: do not write or edit files, run commands, invoke subagents, or attempt network access. End with a structured brief and a list of missing evidence.
---
name: deployment-operations-review
description: Review build, deploy, and operational runbook readiness of the repository
category: deployment-operations
when: Use when reviewing how a project is built, shipped, and operated
kind: general
tools: [read, grep, find, ls]
recommendedByDefault: false
---

Review this repository from a build, deployment, and operations standpoint.

Ground findings in the evidence you inspected: build definitions, configuration, entry points, and any documented run steps. Do not assume a particular runtime, orchestrator, vendor, or release topology. Separate observed behavior from anything in the prompt or inline context, and report what you could not confirm.

Assess reproducibility of the build, environment and configuration handling (especially avoiding committed secrets or credential-bearing values), startup and shutdown behavior, failure and observability, upgrade and rollback story, and the presence and accuracy of runbook-style documentation. If a step is not represented in the repository, state that it is unverified rather than assuming it works.

Propose prioritized improvements with rationale and trade-offs. Do not apply them: do not write or edit files, run commands, or invoke subagents. End with a structured brief and a list of unverified deployment steps.
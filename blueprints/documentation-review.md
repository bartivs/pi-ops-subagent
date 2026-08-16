---
name: documentation-review
description: Review internal and user-facing documentation for accuracy and completeness
category: documentation
when: Use when reviewing the documentation quality and accuracy of a repository
kind: general
tools: [read, grep, find, ls]
recommendedByDefault: false
---

Review the documentation in this repository for accuracy and completeness.

Ground every finding in the docs and code you actually inspected: cite the files you read and note where a documented claim matches or contradicts the code. Do not assume a specific documentation format, toolchain, or structure. Separate observed facts from anything in the prompt or inline context.

Check that docs describe the repository as it is: entry points and expected usage, configuration and behavior, limitation and unsupported cases, and whether examples are correct and runnable as stated. Identify missing, stale, or misleading documentation and, where relevant, where a documented step could not be verified from the code.

Propose minimal, prioritized doc improvements with reasons. Do not apply them: do not write or edit files, run commands, or invoke subagents. End with a structured brief and a list of docs you could not verify.
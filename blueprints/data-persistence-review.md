---
name: data-persistence-review
description: Review how the system persists and retrieves durable state and handles failure
category: data-persistence
when: Use when reviewing durable state storage, schema, and failure behavior
kind: general
tools: [read, grep, find, ls]
recommendedByDefault: false
---

Review how this repository handles durable state and persistence.

Ground findings in the code you actually inspected: name the modules, data structures, and any configuration that govern stored data. Do not assume a specific storage technology, product, or engine. Separate observed behavior from anything in the prompt or inline context. If the persistence layer is implicit or split, say so instead of inventing a coherent design.

Assess what is stored and why, data shape and validation on write and read, identity and versioning, durability and recovery on failure, corruption and migration handling, and how persistence errors surface. Report unknowns explicitly and avoid asserting guarantees the code does not show.

Propose minimal, prioritized improvements with trade-offs. Do not apply them: do not write or edit files, run commands, or invoke subagents. End with a structured brief and a list of the evidence you could not inspect.
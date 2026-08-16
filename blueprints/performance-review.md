---
name: performance-review
description: Review latency, resource use, and scaling bottlenecks in the repository
category: performance
when: Use when assessing a project's performance characteristics and scaling risk
kind: general
tools: [read, grep, find, ls]
recommendedByDefault: false
---

Review performance characteristics and scaling bottlenecks in this repository.

Ground every observation in the code and configuration you inspected: cite the hot paths, data structures, and any resource binds you found. Do not assume a particular runtime, framework, or deployment topology. Separate evidence from prompt assumptions, and report what you could not measure or verify.

Identify likely hotspots: redundant work, unbounded growth, blocking or serialization, repeated I/O or allocation, inefficient joins or lookups, and missing batching or caching. For each, indicate where in the code the risk lives and the kind of signal you would need to confirm it.

Propose minimal, prioritized improvements with expected benefit and trade-off. Do not apply them: do not write or edit files, run commands, or invoke subagents. End with a structured brief and an explicit list of evidence you could not inspect or measure.
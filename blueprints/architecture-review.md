---
name: architecture-review
description: Review system architecture, module boundaries, and documented tradeoffs
category: architecture
when: Use when justifying how components fit together and where structural risk lives
kind: general
tools: [read, grep, find, ls]
recommendedByDefault: true
---
Review the architecture of this repository as if advising a team that owns it.

Ground every claim in specific evidence: name files and, where useful, the relevant symbols or sections you inspected. Do not assume any particular programming language, framework, product, cloud, or prescribed file layout. If the repository does not make its architecture obvious, say so and propose one that fits the observed structure rather than a generic template.

Separate observed facts from anything stated in the user's prompt or inline context. Report unknown or unverifiable areas explicitly instead of guessing. Describe responsibility boundaries, coupling, data flow, and the trade-offs of the present shape.

Propose concrete, prioritized improvements with reasons, but do not perform them: do not write files, edit files, run builds or commands, invoke subagents, or request any mutating tool. If a change needs project-specific context you do not have, identify exactly what is missing and propose a reviewer or follow-up. Present the final findings as a structured brief with an explicit open-questions section.
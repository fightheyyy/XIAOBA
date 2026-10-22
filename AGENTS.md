# XiaoBa-CLI Agent Instructions

XiaoBa-CLI uses a small spec/plan-driven documentation set. Architecture must stay clear, but documentation must not grow one SPEC/PLAN pair per directory, role, benchmark, experiment, or implementation package.

## Stable Documentation Set

The only architecture and planning sources are:

- `docs/SPEC.md` and `docs/PLAN.md` for the whole repository.
- `docs/surface/SPEC.md` and `docs/surface/PLAN.md`.
- `docs/agent-runtime/SPEC.md` and `docs/agent-runtime/PLAN.md`.
- `docs/roles-skills/SPEC.md` and `docs/roles-skills/PLAN.md`.
- `docs/observability-evidence/SPEC.md` and `docs/observability-evidence/PLAN.md`.
- `docs/evaluation/SPEC.md` and `docs/evaluation/PLAN.md`.
- `docs/arena/SPEC.md` and `docs/arena/PLAN.md`.

This is a fixed set of 14 maintained files: one repository pair plus six module pairs. Do not create another `SPEC.md`, `PLAN.md`, architecture report, experiment report, or documentation index elsewhere in the repository.

Implementation packages belong to one of the six modules:

- `src/surfaces/`, `src/events/`, `src/connectors/`, and `desktop/` belong to Surface.
- `src/runtime/` and `src/capabilities/tools/` belong to Agent Runtime; runtime evidence and delivery schemas remain owned by Observability & Evidence.
- `roles/`, `src/capabilities/roles/`, `skills/`, and `src/capabilities/skills/` belong to Roles & Skills.
- `logs/`, `data/`, `memory/`, `output/`, and `src/runtime/observability/`, `src/runtime/delivery/`, and `src/memory/` belong to Observability & Evidence.
- `eval/`, `eval/benchmarks/`, `src/eval/`, `src/eval/replay/`, and engineering tests belong to Evaluation or the module they verify.
- `arena/` and `src/eval/arena/` belong to Arena.

Role prompts and `SKILL.md` files are runtime source assets, not architecture documentation. User-facing role and skill usage lives only in `roles/README.md` and `skills/README.md`.

## SPEC.md Expectations

Each of the seven maintained `SPEC.md` files should answer:

- What problem does this repository or module solve?
- What is in and out of scope?
- What are the current concepts and boundaries?
- What does the current code actually implement?
- What target architecture guides the next work?
- What data contracts, APIs, commands, or file layouts matter?
- How does it interact with the other five modules?

Each SPEC must include two simple Mermaid diagrams:

1. `Current Architecture`: current implementation only.
2. `Target Architecture`: the agreed direction only.

Keep diagrams horizontal, readable, and uncolored. Prefer a few module-level nodes over one giant implementation graph.

## PLAN.md Expectations

Each maintained PLAN should answer:

- What is done, partial, or not started?
- What is the next useful step?
- Who owns the work?
- What acceptance criteria and risks remain?
- What recent verification supports the status?

Keep plans current and compact. Git history owns old implementation journals; do not append an unbounded chronological changelog to PLAN files.

## Spec / Plan Coupling

- If a SPEC changes a concept, boundary, component, or phase, update its paired PLAN.
- If a PLAN marks a milestone complete, make sure code, docs, and verification evidence support it.
- If implementation differs from the current diagram, update either the implementation or the diagram.
- Do not duplicate the same contract or status across repository, module, role, benchmark, and experiment documents.

## Development Gate

Before substantial code changes:

1. Read `docs/SPEC.md` and `docs/PLAN.md`.
2. Read the one or more relevant module SPEC/PLAN pairs.
3. Confirm the target Mermaid matches the requested direction.
4. If the target is unclear or disputed, clarify it before production implementation.

After substantial code changes:

1. Update the relevant module current architecture if implementation changed.
2. Update target architecture only if the intended direction changed.
3. Update the paired PLAN with current status, next steps, acceptance criteria, risks, and recent verification.

## Stable Role Architecture

- Base Main Agent is the only user-facing main agent and dispatcher.
- The eight default Role Subagents are UserCat, InspectorCat, ReviewerCat, EngineerCat, BrowserCat, GuiCat, SecretaryCat, and EvolutionCat.
- UserCat, InspectorCat, and ReviewerCat form the self-evolution review side.
- EngineerCat, BrowserCat, GuiCat, and SecretaryCat form the execution-takeover side.
- EngineerCat owns coding and implements Inspector/Reviewer repair work.
- BrowserCat owns browser takeover; GuiCat owns desktop GUI takeover.
- SecretaryCat owns Feishu workplace workflows and delegates domain capabilities to the official `lark-cli`; `FeishuCat` is an alias, not a second role.
- EvolutionCat owns deterministic long-term memory through the role-scoped `remember` tool plus role-local `self-evolution`, `skill-publish`, and `role-publish` workflows. It does not own coding, evaluation, or cross-role dispatch.
- Base ships with zero default Skills; explicit standalone Skill installation and Arena subject mounting remain supported.
- All eight roles reuse the XiaoBa Agent loop. Drivers provide deterministic capabilities and do not run a second Chat/Agent/MCP loop.
- Do not add RouterCat, Recovery Role, or a general task framework unless the stable architecture is explicitly changed first.

## Working Rule

Architecture first, then implementation. Default to the simplest workable design. When one field, file, command, or narrow rule is enough, do that; do not introduce extra schemas, manifests, subsystems, or governance machinery without a demonstrated need.

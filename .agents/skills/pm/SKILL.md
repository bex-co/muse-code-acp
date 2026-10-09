---
name: pm
description: Inspect and maintain muse-code-acp's .pm board, including workstreams, inbox notes, milestones, tasks, completion and evidence-backed drops. Use when asked for board status or a board mutation; not for ordinary code edits or brainstorming without board changes.
---

# Maintain the `.pm` board

Usage: `$pm [status | new workstream <title> | add <wN> <idea> | promote <wN/NNN> | new milestone <wN> <title> | add-task <wN/mN> <title> | done <wN/mN/tNNN> | drop <wN/mN or wN/NNN> <reason>]`

Treat `/pm` as the same invocation. Default to `status`. These are agent procedures, not shell commands; use file tools to perform them. This skill is the canonical board convention, including when loopx needs to update the board.

`/pm-brainstorm` proposes work as text; `/pm` materializes it. All board writes, including those made by loopx, follow this skill. Canonical skills live in `.agents/skills/`; Claude discovers them through relative directory symlinks in `.claude/skills/`.

## Mission and existing conventions

Sequence work toward a reliable, faithful ACP adapter for Muse Code: verified public SDK/MSP behavior, usable editor integration, session continuity, truthful capabilities and dependable installation. Read `.pm/DO_NOT_DO.md` before mutations and status validation. Preserve its constraints; do not import another project's adoption pillars or package structure.

Workstreams are general-purpose worker queues, not permanent feature lanes. Use the worker named in the workstream README, defaulting to `worker1`. Existing milestones retain their scope and acceptance criteria; adding these skills does not authorize rewriting the backlog.

| Item       | Open path             | Completed path                                                          |
| ---------- | --------------------- | ----------------------------------------------------------------------- |
| Workstream | `.pm/wN/README.md`    | Retain the index                                                        |
| Inbox note | `.pm/wN/NNN.md`       | Promotion consumes the note after preserving its content and provenance |
| Milestone  | `.pm/wN/mN/README.md` | `.pm/wN/done/mN/README.md`                                              |
| Task       | `.pm/wN/mN/tNNN.md`   | `.pm/wN/mN/done/tNNN.md`, then `.pm/wN/done/mN/done/tNNN.md`            |

- Inbox notes are terse Markdown without frontmatter, for ideas or work taking roughly an hour or less. Milestones require more than an hour across multiple substantive tasks; closing tasks alone do not justify a milestone.
- Every board item explains why: inbox notes include a one-line `Why: ...` directly under the title. Milestones require direct project-goal linkage, an observable expected outcome, and a why-now rationale; reject or reshape proposals that fail this quality gate.
- Allocate IDs above the highest existing number in the applicable scope, scanning open files, archives and dropped tombstones. Use `wN`, `mN`, three-digit inbox numbers and `tNNN`. Never reuse an ID.
- Task IDs and `depends_on` are logical IDs such as `w1/m8/t007`. Archival does **not** insert `done/` into those IDs. Resolve dependencies in all three task locations above, including other workstreams. Missing dependencies are unresolved, not satisfied.
- Keep task `status:`, milestone table `— **DONE**` markers, milestone `**Status:**`, and workstream checkboxes consistent. Completion requires physical archival, not just a status edit.
- Keep the board public-safe: no credentials, user data or private repository contents. Record reproducible evidence using public or repository-local references.
- With `DRY_RUN=1`, show planned edits and moves without writing or deleting anything. PM operations alone do not commit, push or publish.

## Commands

### `status`

Read workstream indexes, live milestones and tasks, inbox notes and anti-goals. Use archived tasks to resolve dependencies. Report each milestone's status and its first actionable task in table order: unfinished, with all prerequisites satisfied and no applicable documented blocker. Report blocked/deferred work and open notes separately.

Flag mismatched IDs, missing/cyclic dependencies, status/archive drift, anti-goal conflicts, missing source/goal linkage, inbox notes missing `Why:`, and unobservable definitions of done. Do not repair anything during this read-only command.

### `new workstream <title>` / `add <wN> <idea>`

Create the next workstream with a generic queue title and the workstream template, or add the next numbered plain-Markdown note to an existing workstream, with `Why: ...` directly under its title. Preserve the requested idea without inventing implementation commitments.

### `promote <wN/NNN>` / `new milestone <wN> <title>`

Apply the sizing rule and anti-goals first. Keep small work as an inbox note and explain why. Otherwise create the next milestone and its tasks, with observable acceptance criteria, explicit dependencies and source/goal linkage. Add the unchecked milestone and total task count to the workstream index. For promotion, remove the source note only after verifying that its scope and provenance are preserved in the milestone.

Append these standing closing tasks after implementation:

1. **Adoption surface**, when users or agents encounter a changed surface: update applicable README capability tables, configuration/quickstarts, `docs/sdk-migration.md`, `docs/mcp-passthrough.md`, or development skill instructions. Check SDK/exec differences and negotiated ACP fallbacks. Do not require an editor UI this repository does not own. Existing milestones may cover this in implementation or CI tasks; avoid duplicating it. Record why a separate task is included or omitted in source/goal linkage.
2. **Simplify milestone changes**: review the diff for unnecessary state, duplication and reusable logic; apply behavior-preserving improvements. Use an applicable simplify skill if available, otherwise do that review directly.
3. **CI and behavior coverage**: run affected repository checks and cover real behavior and failure modes. See the validation section below. Record commands, results and host versions where relevant.
4. **Close out the milestone**, last: verify all preceding acceptance criteria and the milestone definition of done before completing the archive moves.

Adoption surface depends on implementation; Simplify follows it (or implementation when omitted); CI depends on implementation and Simplify; Closeout depends on CI and any other outstanding closing work. Include closing tasks in the task count.

### `add-task <wN/mN> <title>`

Allocate the next unused task ID, insert its table row before closing tasks and update their dependencies to include the new work. IDs need not be numerically ordered in the table. Update the workstream task count. Reject archived milestones; do not reopen history implicitly. If new work invalidates a completed closing check in an active milestone, add an explicit revalidation task before Closeout.

### `done <wN/mN/tNNN>`

1. Resolve the logical ID and inspect its dependencies and acceptance criteria. Mark only verified work complete. A supported schema, mock success or graceful unsupported fallback does not prove host delivery when the task requires it.
2. Record concise evidence in the task or milestone. For work already satisfied by existing code, append `## Closed by triage` to the task with commit/path/test evidence; distinguish it from implementation this session.
3. Set `status: done`, mark the table row `— **DONE**`, update milestone status and move the task into the milestone's `done/` directory. Keep its logical ID unchanged.
4. Complete Closeout last, only when the definition of done holds. When no open tasks remain, set milestone `**Status:** done`, move the entire milestone to `.pm/wN/done/mN/` and check its workstream checkbox. Legacy milestones without a Closeout task still require this verification before archival.
5. Verify the completed task exists only in its archive location; a completed milestone must exist only under the workstream's `done/`, with all status representations agreeing. Repair affected completion drift rather than reporting success before the moves. Repeated completion of an already consistent archived task is a no-op.

### `drop <wN/mN or wN/NNN> <reason>`

Use for work demonstrably no longer wanted, not work already completed or merely difficult. Require a reason backed by an anti-goal, recorded decision or superseding milestone. Read the target and inspect references/dependents before removal. Never drop completed milestones or rewrite archived history.

Remove the open milestone directory (including its completed subtasks) or inbox note, remove its open index entry, and add a tombstone under `## Dropped` in the workstream README:

```markdown
- ~~**mN**~~ — <title> — dropped <YYYY-MM-DD>: <reason and evidence>
```

Use the note number for inbox tombstones. A dropped dependency is not completed: report affected dependents and leave them unresolved unless an authorized scope change supplies a justified replacement. Do not silently rewire them. Propose general anti-goal additions separately; write them only when requested. Verify the old path and checkbox are gone and the tombstone remains.

## Validation for engineering milestones

Read `package.json`, `.github/workflows/ci.yml` and task acceptance criteria for the current checks. Run from the repository root:

- Code changes: `npm run check`, `npm run build`, `npm run test:unit`.
- Package, entrypoint or install changes: also `npm run test:pack-smoke`.
- SDK/MSP, host lifecycle, permissions or real-host claims: also `MUSE_CODE_ACP_REQUIRE_MUSE=1 npm run test:muse-loopback`, after build, with the supported Muse host installed. The required flag prevents missing-host skips from appearing successful. New host features need their own observable acceptance evidence if existing suites do not exercise them.
- Docs/skill-only work: check formatting and instruction/link consistency; do not add meaningless runtime tests.
- Standalone packaging changes: also run `npm run build:standalone` and `npm run test:standalone -- <artifact-path>` on the supported platform, following the current standalone CI job.

CI currently includes build, deterministic tests, packed-install smoke, real Muse loopback and standalone smoke. Milestone scope can require the full set. Paid-provider tests (`RUN_INTEGRATION_TESTS=true npm run test:integration`) require existing authorization. Record unavailable required checks as blockers. Do not substitute unrelated monorepo commands or claim a skipped check passed. Format only the Markdown files changed by the operation using the repository's installed Prettier; avoid rewriting unrelated board files.

## Templates

Workstream `README.md`:

```markdown
# wN — <generic queue title>

**Worker:** worker1 — general-purpose worker for this project.

## Milestones

- [ ] **mN** — <title> (<N> tasks) ← from <source>
```

Milestone `README.md`:

```markdown
# wN · mN — <title>

**Worker:** worker1 **Goal:** <result> **Status:** todo

## Tasks (in order)

| id   | title   | est | depends_on |
| ---- | ------- | --- | ---------- |
| t001 | <title> | 30m | —          |

## Definition of done

- <observable result and how to verify it>

## Source + Goal linkage

- **Source:** <request, note or repository document>
- **Goal linkage:** <how this improves the faithful, reliable ACP adapter>
- **Expected outcome:** <who can now do what>
- **Why now:** <priority, prerequisite or risk>
- **Adoption surface:** <included, covered by named tasks, or omitted with reason>

## Validation evidence

<commands, outcomes, applicable host/SDK versions and unresolved limitations>
```

Task `tNNN.md`:

```markdown
---
id: wN/mN/tNNN
title: "<title>"
worker: worker1
status: todo
estimate: 30m
depends_on: []
---

## Objective

<result>

## Context

- <relevant paths, constraints and prerequisites>

## Steps

1. <concrete action>

## Files

- <repository paths>

## Acceptance criteria

- [ ] <observable check>

## Out of scope

- <adjacent work excluded>
```

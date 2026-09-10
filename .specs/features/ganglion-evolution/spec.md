# ganglion-evolution — Specification (authoritative)

**Status:** SPECIFIED, NOT STARTED. Zero lines of code. See "Why this one is
not built" below before picking it up.
**Date:** 2026-09-10.
**Spans:** `crab-ganglion-harness`, `crab-shell-proxy`, `crab-exoskeleton-webapp`.
**Depends on:** `ganglion-model-registry` FR-1 (the config file).

## What picoclaw's evolution actually is

Measured, not assumed: `pkg/evolution/` is 34 files and roughly 12 500 lines
including tests, shipped and inert by default (`enabled: false`, `mode: observe`).

It is **not** a tool the model can call, and it does not rewrite the harness. It
is a background listener on turn-end events with two paths:

- **hot** — every turn end appends a `LearningRecord` to
  `state/evolution/task-records.jsonl` and updates per-skill usage stats.
- **cold** — triggered `after_turn`, on a schedule, or manually; reads the
  records, judges success, clusters repeated successful patterns once
  `min_task_count` (2) and `min_success_ratio` (0.7) are met, and generates
  **skill drafts**.

In `apply` mode, and only there, an accepted draft is written to
`workspace/skills/<name>/SKILL.md` — with a structural and secret scan before the
write, an atomic write, a timestamped backup of whatever it overwrote, and a
rollback closure on downstream failure. `AGENT.md` and `SOUL.md` are **never**
touched by it.

So the honest summary is: **it evolves the agent's skill library.**

## The prerequisite nobody would notice until it shipped

`grep -rn skill --include='*.go'` in `crab-ganglion-harness` returns **nothing**.
The harness has no skills: it does not read `workspace/skills/`, it does not put
skill content in the system prompt, and `ganglionBinds` (workspace + credential
key + the persona cascade) mounts no skills root — the proxy's shared-skills
machinery reaches picoclaw agents only.

Evolution in `apply` mode would therefore write `SKILL.md` files **into a void**.
That is precisely the failure the `crab-ganglion-harness` spec's deferred table
exists to prevent: *"A deferred feature must answer 501 with the harness named.
Storing a setting that has no effect is the failure mode this table exists to
prevent."*

**So this feature is two, and it says so:** a skills loader, then evolution on top
of it. `apply` mode is not shipped without the loader.

## Part 1 — skills

**R1 — load `workspace/skills/*/SKILL.md`.** Each is YAML frontmatter
(`name`, `description`) plus a body, picoclaw's format unchanged, so a skill
written for one harness works on the other.

**R2 — the system prompt gets a skills index**, not every body: name and
description per skill, under a budget (**R2.1**: 8 KiB total, oldest-by-mtime
dropped first, and the drop is logged). Bodies are read on demand by the agent
through the shell tool, which already reaches the workspace.

**R3 — precedence.** The persona (`GANGLION_SYSTEM_FILE` → `AGENT.md`) comes
first and is never displaced; the skills index is appended below it. A skill can
add capability, never overwrite identity.

**R4 — reload per turn**, the same cadence `AGENT.md` is already re-read at.

**R5 — OPEN, and put to the owner rather than assumed:** whether the proxy's
admin-managed shared skills should mount into ganglion containers at all.
Evolution-authored skills live inside the workspace bind and persist without any
proxy change; admin-authored ones would need a new bind. See OQ-1.

## Part 2 — evolution

**R6 — picoclaw's config block, keys unchanged**
(`pkg/config/config.go:58-70`), read from the config file:

```jsonc
{ "evolution": {
    "enabled": false, "mode": "observe",
    "state_dir": "", "min_task_count": 2, "min_success_ratio": 0.7,
    "cold_path_trigger": "after_turn", "cold_path_times": [] } }
```

`mode ∈ observe | draft | apply`; `cold_path_trigger ∈ after_turn | scheduled | manual`.
Same defaults, so a picoclaw `config.json` dropped in behaves the same.

**R7 — the hot path.** At turn end, one `LearningRecord` per turn appended to
`state/evolution/task-records.jsonl`: the input, the tools invoked and their
outcomes, token usage (which ganglion has and picoclaw does not — FR-8 of the
harness spec accumulates it), duration, and whether the turn ended cleanly.
Append-only, `fsync`'d, same durability contract as the transcript.

**R8 — the cold path.** Cluster records into patterns; a pattern with at least
`min_task_count` occurrences and at least `min_success_ratio` success generates a
draft through the model itself, using the same candidate chain the turn uses.

**R9 — the safety ladder, ported in full.** `observe` records only; `draft`
generates and stores drafts, writing no skill; `apply` may write. Before any
write: frontmatter validation, skill-name validation against path traversal, the
secret scan for `sk-live-`, `sk_test_`, `api_key=` and PEM private-key headers,
a timestamped backup of the overwritten file, an atomic write, and rollback on
failure. picoclaw's own documentation calls this scanner *"a narrow guardrail,
not a complete safety boundary"* and that assessment is carried over verbatim
rather than quietly upgraded.

**R10 — `apply` requires the loader.** Selecting `apply` while Part 1 is absent is
a **boot failure naming the reason**, not a silent downgrade.

**R11 — scale-to-zero honesty.** `cold_path_trigger: scheduled` on an agent in
`scale-to-zero` is refused at load with the mode named — a stopped container fires
no timers, and this stack has already made exactly this decision once, for cron
(`/v1/cron/*` answers `501` naming the mode). `after_turn` and `manual` are
unaffected and are the modes a scale-to-zero agent uses.

**R12 — a member-visible surface.** Drafts are the interesting artefact and today
they would be invisible. A read-only Evolution panel lists drafts with their
status (candidate / quarantined / accepted / applied) and the pattern that
produced them, so `draft` mode is a usable review workflow rather than a folder
nobody opens.

## Acceptance criteria

- **AC-1** With `enabled: false` (the default), nothing is written and no turn is
  measurably slower. The hot path is off, not merely quiet.
- **AC-2** A skill written by picoclaw's evolution loads in ganglion unchanged.
- **AC-3** `apply` mode with no skills loader refuses to boot, naming the reason.
- **AC-4** A draft containing an API-key-shaped string is quarantined, never
  written.
- **AC-5** An applied skill that breaks its own frontmatter validation is rolled
  back and the previous file restored from the backup.
- **AC-6** `scheduled` on a scale-to-zero agent is refused at load.

## Out of scope

The lifecycle maintenance half — picoclaw's decay scoring that eventually
**deletes** a stale `SKILL.md`. Automated deletion of agent-authored content needs
an operator story this feature does not have.

`pattern-records.jsonl` clustering by LLM in v1 uses a deterministic clusterer;
picoclaw's `LLMDraftGenerator` prompt-based clustering is the second cut.

## Open questions

- **OQ-1 — R5.** Do admin-managed shared skills apply to ganglion agents? This is
  a product decision, not a technical one: `ganglion.go` deliberately mounts a
  narrow bind set, and adding a skills root widens it. **To the owner.**
- **OQ-2** — Should `apply` require an approval hop through the `Approver` port
  that already exists for tool gating? It would make evolution the second consumer
  of the mechanism the harness was built for, at the cost of a proxy endpoint that
  is itself still unbuilt (harness spec OQ-3).

---

## Why this one is not built (2026-09-10)

The other three features of this round shipped; this one did not, and the reason
is worth writing down rather than leaving as an empty directory.

**It is two features, and the first one is invisible from the outside.** The
skills loader is the prerequisite established above — `grep -rn skill
--include='*.go'` in the harness still returns nothing — and without it `apply`
mode writes `SKILL.md` files nothing reads. Shipping only the evolution half
would have been the exact failure the harness spec's deferred table exists to
prevent: a setting that stores something and changes nothing.

**Its size is measured, not guessed.** picoclaw's `pkg/evolution` is 34 files and
roughly 12 500 lines including tests. A faithful port of the ladder, the
clustering, the draft review and the rollback is the largest single piece of the
four, and it is the only one with no user-visible surface until the last step.

**Two of its decisions are still open**, and both are the owner's rather than an
implementer's:

- **OQ-1** — whether admin-managed shared skills mount into ganglion containers
  at all. `ganglionBinds` is deliberately narrow; adding a skills root widens it,
  and evolution-authored skills need no such widening. This changes what Part 1
  is for.
- **OQ-2** — whether `apply` should go through the `Approver` port, which would
  make evolution the second consumer of the mechanism the harness was built for,
  at the cost of a proxy endpoint that is itself still unbuilt.

**Build order when it is picked up:** Part 1 alone first, shipped and used —
skills that a member or an admin wrote, loaded into the prompt, with the budget
and the precedence in R2 and R3. Only then Part 2, starting at `observe`, which
writes records and changes nothing. `draft` and its review panel (R12) come
before `apply` ever ships.

# ganglion-evolution — Specification (authoritative)

**Status:** Both parts IMPLEMENTED. `apply` cannot be switched on until OQ-3 is
answered — see "Implementation status" at the end.
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

**R5 — ANSWERED YES (owner, 2026-09-10): admin-managed shared skills mount into
ganglion containers.** So the loader has two sources, not one, and they are not
equivalent:

- `<workspace>/skills/` — writable, where evolution's own drafts land.
- the admin's shared skills root — **read-only**, mounted by the proxy the way
  the persona cascade already is.

**R5.1 — a name collision resolves in favour of the ADMIN's copy**, and the
shadowed one is logged. The other way round would let an agent overwrite an
administrator's instruction by writing a file with the same name, which is a
privilege escalation dressed as a merge rule.

**R5.2** — evolution may only ever write into the workspace copy. The shared root
is mounted read-only, so this is enforced by the kernel rather than by a check,
which is the point of mounting it that way.

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

## Decisions

### D-1 — Admin-managed shared skills mount into ganglion containers (owner, 2026-09-10)

Answers the former OQ-1. `ganglionBinds` was deliberately narrow — workspace,
credential key, persona — and this widens it by one read-only mount. Read-only is
load-bearing rather than tidy: it is what makes R5.2 a kernel guarantee instead
of a check somebody can forget.

### D-2 — `apply` requires approval (owner, 2026-09-10)

Answers the former OQ-2. Evolution becomes the **second consumer of the
`Approver` port**, which is one of the two capabilities that justified building
this harness at all (spec §Problem, A1).

**And it carries a dependency the question did not mention.** The harness side of
approval is done: the port, the loop suspension, the heartbeat, the fail-closed
timeout, and a `proxy.Client` adapter whose wire is fully defined —
`POST {session_key, session_id, tool_call_id, tool, arguments}` answering
`{allowed, reason, by}`. **The proxy endpoint it calls does not exist.** With no
`GANGLION_APPROVAL_ENDPOINT` configured, the loop installs an allow-all approver,
so "apply requires approval" would be a sentence that changes nothing.

So D-2 is implemented as **R10.1: selecting `apply` with no approval endpoint
configured is a BOOT FAILURE naming the reason.** Not a downgrade to `draft`,
which would leave an operator believing apply was on. The consequence is stated
plainly: until the proxy grows the endpoint, `apply` cannot be switched on at
all, and `observe` and `draft` are what run.

## Open questions

- **OQ-3 (inherited from the harness spec) — WHO approves, and how are they
  asked?** The wire is settled; the policy is not. A human in the webapp, an
  admin-set scope policy of the kind `ScopePolicy` already carries for personal
  models, or an auto-approve with an audit trail are three different products.
  This is the one thing still blocking a usable `apply`, and it is the owner's.

---

## Why this waited a round (2026-09-10)

Kept rather than deleted, because the reasoning is what the two decisions above
were answers to.

**It is two features, and the first one is invisible from the outside.** The
skills loader is the prerequisite established above — `grep -rn skill
--include='*.go'` in the harness returned nothing — and without it `apply` mode
writes `SKILL.md` files nothing reads. Shipping only the evolution half would
have been the exact failure the harness spec's deferred table exists to prevent:
a setting that stores something and changes nothing.

**Its size is measured, not guessed.** picoclaw's `pkg/evolution` is 34 files and
roughly 12 500 lines including tests. A faithful port of the ladder, the
clustering, the draft review and the rollback is the largest single piece of the
round, and it is the only one with no user-visible surface until the last step.

**Build order, unchanged by the answers:** Part 1 alone first — skills that a
member or an admin wrote, loaded into the prompt, with the budget and the
precedence in R2 and R3. Only then Part 2, starting at `observe`, which writes
records and changes nothing. `draft` and its review panel (R12) come before
`apply` ever ships — and after D-2, `apply` additionally cannot ship before
OQ-3 is answered.


---

## Implementation status (2026-09-10)

| Requirement | State |
|---|---|
| R1, R2, R2.1, R3, R4 | **done** — `internal/adapter/skills`, `domain.SystemPrompt` |
| R5, R5.1, R5.2 | **done** — the proxy mounts the admin root read-only; the admin's copy wins a collision |
| R6, R7, R8 | **done** — picoclaw's config block, records fsync'd, clustering by tool signature |
| R9 | **done** — name and frontmatter validation, the credential scan, backup, atomic write, post-write re-validation, rollback |
| R10, R10.1 | **done** — `apply` without an approver is a boot failure naming the variable |
| R11 | **done** — `GANGLION_LIFECYCLE_MODE`, refused at load |
| R12 | **NOT built** — the drafts are on disk and `Engine.Drafts()` reads them, but no panel shows them. `draft` mode is therefore a review workflow whose review happens over `cat` |
| AC-1..AC-6 | **asserted by test**, with mutation checks on both approval gates |

**One decision made during implementation that the spec did not anticipate.**
`internal/domain/arch_test.go` caught `evolution` importing the `skills` adapter
on the first build — AR-4 forbids one adapter importing another. The `SKILL.md`
FORMAT is shared vocabulary rather than either adapter's property, so it moved to
`internal/skillfile`. Both adapters import it; neither imports the other.

**What blocks a usable `apply`.** OQ-3, and it is the owner's: *who* approves.
The wire is settled and the harness end is built, but the proxy endpoint does not
exist, so `GANGLION_APPROVAL_ENDPOINT` is unset in every deployment and `apply`
refuses to boot. That refusal is correct — it is what stops the mode from being
decoration — and it means the shipped, usable rungs today are `observe` and
`draft`.

**Not verified against a real deployment.** No agent has run with evolution
enabled. The clustering, the review and the rollback are exercised against
fixtures and a scripted provider; nothing here has yet watched a real agent
produce a real pattern.

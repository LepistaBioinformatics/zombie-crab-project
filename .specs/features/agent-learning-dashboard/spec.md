# agent-learning-dashboard — Spec

**Status:** IMPLEMENTED 2026-09-08. Collectors in harness-sphere#28; dashboard here.
**Spans:** `harness-sphere` (three new collectors — the substantial part) +
`zombie-crab-project` (a second Grafana dashboard).
**Date:** 2026-09-08.
**Predecessor:** `harness-sphere-zombie-crab-scope`. Its FR-S group and DEC-13 are this
feature's premises: one source per workspace, full tuple attribution, no transcript
content. Not restated.

## Problem

**The request was for a dashboard. The blocker is that none of its data exists.**

harness-sphere currently emits, per workspace: `harness.messages` (by role),
`harness.sessions`, `tool.calls`, `harness.cron.sessions`. There is no metric for memory,
for skills, or for the knowledge graph. A dashboard about *learning* built on today's
metrics could only show how much an instance **talked** — which is the opposite of what
the request asks for.

So this feature is three collectors first and a dashboard second.

**What the existing dashboard is for, and why a second one:** `zombie-crab — stack` answers
*"is the stack healthy?"* — liveness, host pressure, watcher footprint. It is organised by
**layer**, which is the right shape for that question and the wrong shape for this one.
This dashboard answers *"where does each instance sit?"* and is organised by **instance**.
The first stays as the general view; nothing moves out of it.

## What is actually on disk (measured 2026-09-08, from inside the running container)

Read as root through the existing read-only `/data` mount. **Counts, names and sizes only
— no file content was read**, which is the same line FR-S6 draws for the metrics.

One real workspace, `42bb2905…/e0006752…/alpha/28690354…`:

```
./skills                      0 files          <- empty; the per-workspace one is the real store
./workspace/skills           14 files, 128 KB
./workspace/memory            4 files, 4.3 KB
./workspace-chat-ux/skills    0 files
./workspace-chat-ux/memory    0 files
./memory-graph-chat-ux        1 file, 13.5 KB  <- memory.jsonl
./workspace/cron              1 file            <- jobs.json
./workspace/state             1 file
./logs                        2 files, 118 KB
```

### Three distortions, each measured, each a requirement below

**1. A skill directory is not a skill.** `workspace/skills` holds **10 directories** but
only **9 `SKILL.md` files** — `shared-content/` has none. Counting directories overcounts
by 10% here, and the error grows with whatever else the agent leaves in that tree.

**2. Three of the four memory files are empty scaffolding.** `workspace/memory` holds
`CONTEXT_RECOVERY.md`, `FILE_DELIVERY.md`, `MEMORY_ROUTING.md` — **all zero bytes**,
created at provisioning — and `MEMORY.md` at 317 bytes. A naive file count reports **4**
when the truth is **1**: a **4× overcount** on a metric whose entire purpose is to say
whether the agent retained anything. Every freshly provisioned instance would read as
already having memory.

**3. The graph is records, not lines.** `memory.jsonl` holds **10 entities + 10
relations = 20 records**, but `wc -l` returns **19** — the last line carries no trailing
newline. Counting lines undercounts by one, permanently and silently.

### The shape of the knowledge graph

Verified by parsing keys only:

```
type="entity"   : name, entityType, observations[], createdAt
type="relation" : from, to, relationType, createdAt
```

**`observations` is the learning volume.** It is an array per entity — the facts the agent
actually retained about that entity. Its summed length across entities is the single most
meaningful number available here, and it is not derivable from any count of files.

### A location rule that does not match the others

`memory-graph-chat-ux` sits at the **user root**, not under `workspace-chat-ux/`, and is
named per **project**. So the stack now has three different location rules:

| What | Where |
|---|---|
| sessions | `workspace/sessions` **and** `workspace-<project>/sessions` |
| memory | `workspace/memory` **and** `workspace-<project>/memory` |
| knowledge graph | `memory-graph-<project>` **at the user root** |

The graph must be enumerated by globbing `memory-graph-*` at the user root, the same way
FR-S5 enumerates session directories. Assuming one path would silently drop every project
graph — the same failure that dropped 42% of conversations before FR-S5.

## Goals

- Position **instances**, not metrics: one screen that says which agents are building
  capability, which are consuming without retaining, and which are dormant.
- Fit **one screen with no scrolling**.
- Leave `zombie-crab — stack` untouched as the general view.

## Non-goals

- No transcript content, no observation text, no entity names (DEC-27).
- No new mount, no Docker socket, no listening port. The existing read-only `/data` bind
  already reaches every file this needs.
- Not a replacement for the stack dashboard.

## Decisions

### DEC-25 — Capability × consumption is the primary framing (chosen by the owner)

The dominant panel is a scatter: **X = tool calls, Y = skills**, point size = graph
entities. It separates agents *building* capability from agents merely *consuming* it, and
names the quadrants — Especialista, Aprendiz, Operária, Dormente.

The alternatives were a learning-quadrant framing (messages × retention) and a
four-scatter grid. Messages × memory survives as a **secondary** panel, so the relationship
the request named directly is still on screen; it just is not what the eye lands on first.

### DEC-26 — Skill names are labels; entity names never are (chosen by the owner)

`harnesssphere.harness.skill{skill.name="github"} 1`, one series per skill. Skill names are
**agent-authored capability names**, bounded at roughly ten per instance, and knowing
*which* skills an instance has is most of what "positioning" means.

Entity names are the opposite on both counts: they are **extracted from the member's
conversations** — so they are member content, and FR-S6 already forbids that — and their
cardinality is **unbounded**, growing one permanent series per concept ever mentioned. The
graph is therefore reported as counts only.

### DEC-27 — `observations` is counted, never read

The summed length of the `observations` arrays is emitted. The strings inside them are
never deserialized into a signal. This is the same construction FR-S6 uses for transcript
`content`: the parser reaches the array, takes its length, and discards it.

### DEC-28 — A separate collector, not an extension of SessionCollector

Skills, memory and the graph change **rarely**; transcripts change constantly. They belong
on a slower cadence, and DEC-24's per-file offset machinery has no analogue here — these
files are read whole, and they are small (13.5 KB for the graph, 4 KB for memory).

Sharing a collector would force one interval onto both and put incremental-read state
beside code that does not want it.

### DEC-29 — The scatter's feasibility is a known risk with a named fallback

**Verified against the running Grafana 11.4.0, and the first answer was wrong.** `xychart`
is installed — but it plots X and Y from fields of **one frame**, and two Prometheus
queries return two frames. Worse, the labels needed to join them are **not columns**: the
datasource returns them as field *metadata*.

```
fields: [ {name: "Time"}, {name: "harnesssphere_harness_sessions",
                           labels: {crab_user: "28690354…", crab_agent: "alpha", …}} ]
```

So the panel requires a transformation chain before it can plot anything:

```
2 instant queries → labelsToFields (crab_user, crab_agent) → joinByField (crab_user) → xychart
```

This is standard Grafana, but it is the one part of this feature that can fail at
implementation rather than at design. **FR-L10 makes it a gate**, and the fallback if the
chain does not join is a **table with sparkline columns** — same information, one row per
instance, no scatter. That trade is accepted in advance rather than discovered.

### DEC-30 — The dashboard cannot be validated by looking at it yet

The live deployment has **one** workspace. A scatter with one point cannot show a pattern,
and quadrants drawn around a single observation say nothing. This is recorded so the first
review is not *"the scatter is broken"*.

The feature is still correct to build now: the numbers are real, the collectors are what
take time, and cardinality grows with adoption rather than with effort. But **visual
validation waits for a second instance**, and FR-L11 discharges what can be checked
without one.

## Requirements

### Collection (FR-L)

**FR-L1** A `LearningCollector`, one instance per workspace, discovered by the same
mechanism as `SessionCollector` (F2 FR-D1) and attributed with the same full tuple
(`crab.tenant`, `crab.subscription`, `crab.agent`, `crab.user`).

**FR-L2** Its interval is configurable and **slower than the session interval** by default
(DEC-28).

**FR-L3** `harnesssphere.harness.skills` counts **`SKILL.md` files**, not directories
(distortion 1). Both `workspace/skills` and `workspace-<project>/skills` are covered.

**FR-L4** `harnesssphere.harness.skill{skill.name=…} = 1` is emitted per skill (DEC-26).
The name is the **directory name**, never file content.

**FR-L5** `harnesssphere.harness.memory.files` counts only **non-empty** files, and
`harnesssphere.harness.memory.bytes` sums only their bytes (distortion 2). Zero-byte
provisioning scaffolds are excluded, explicitly and with a test.

**FR-L6** The knowledge graph is enumerated by globbing `memory-graph-*` at the **user
root** (the third location rule), and every graph found is summed into the instance's
totals.

**FR-L7** `harnesssphere.graph.entities` and `harnesssphere.graph.relations` count
**parsed records** discriminated by the `type` field — never lines (distortion 3). A record
that fails to parse is skipped, not counted as either.

**FR-L8** `harnesssphere.graph.observations` sums the **length** of each entity's
`observations` array. The strings are never read into a signal (DEC-27).

**FR-L9** No entity name, relation name, observation text or memory file content appears in
any signal or label.

### Dashboard (FR-D)

**FR-D1** A **second** dashboard, `zombie-crab — learning`, provisioned beside the
existing one. `zombie-crab — stack` is not modified.

**FR-D2** It fits **one 1080p screen with no vertical scrolling** — a hard constraint, not
a preference. Panels are cut to fit rather than the layout being allowed to grow.

**FR-D3** The dominant panel is the capability scatter of DEC-25, with named quadrants and
a legend keyed by `crab.agent` / `crab.user`.

**FR-D4** A secondary panel relates **messages to memory volume**, the relationship the
request named directly.

**FR-D5** A panel shows **graph growth**: entities, relations, and observations-per-entity
— the last being the density measure, not a raw count.

**FR-D6** A panel shows **skills per instance**, and — because DEC-26 allows it — *which*
skills.

**FR-D7** Every panel description states what the number **excludes**, in the manner
established by the stack dashboard: a reader must be able to tell from the panel that
memory excludes empty scaffolds and skills counts `SKILL.md` files.

**FR-D8** Ratios are computed in **PromQL**, not baked into the collector. The collector
emits facts; the dashboard composes them. A ratio in the collector cannot be re-derived
when the question changes.

### Verification (FR-V)

**FR-L10 (gate)** The `labelsToFields → joinByField → xychart` chain is proven to render
against live data **before** the layout is finalised. If it cannot join, the dashboard
ships the table fallback of DEC-29 and this spec is amended rather than the panel being
left broken.

**FR-L11** What can be verified with one instance is verified: every new metric appears in
Prometheus with the full tuple, `skills` reports **9** (not 10), `memory.files` reports
**1** (not 4), and `graph.entities` + `graph.relations` report **10 + 10** (not 19).

These are the four measured numbers from this document, and they are the point: each one
is a distortion that a plausible implementation gets wrong.

## Open questions

**OQ-10 — DROPPED by the owner (2026-09-08).** The "sustainable use" threshold is not
pursued. The dashboard delivers capability, retention and consumption as raw material; no
line is drawn on the chart, and none is planned.

**OQ-11 — Should `logs/` size be a signal?** 118 KB of `gateway.log` and
`gateway_panic.log` sit in every workspace. Growth there is a health signal rather than a
learning one, and it may belong on the stack dashboard instead. Not decided.

**OQ-12 — Cron jobs as a capability axis.** `workspace/cron/jobs.json` names the agent's
scheduled tasks. A scheduled task is arguably capability — but F2 OQ-8 already flags cron
as latent-not-manifest here, so there is nothing to calibrate against yet.

## What FR-L10 actually found (2026-09-08)

The gate was worth having: **the first two configurations rendered `Err`**, and the
failure was found by screenshotting the running Grafana in headless Chromium and reading
the image, not by reasoning about it.

Three things were wrong, each discovered by measurement:

1. **`labelsToFields` cannot pivot a `format: table` frame.** That format already expands
   labels into columns, so the transform has nothing to do. Removing it produced the pivot
   — and then one frame *per series*, which the table exposed as a frame picker.
2. **The join works; the naming was the problem.** `joinByField` on `crab_user` aligns
   members as rows correctly. It names each query's value column **`Value #<refId>`** and
   suffixes every duplicated label column ` 1`, ` 2`, … **per query** — so an exclude list
   covering only ` 1` left `crab_agent 2` and `__name__ 1` on screen, which is the
   duplicate-column defect the owner reported.
3. **The manual `byName` matchers never bound in Grafana 11.4.** `mapping: "auto"` is used
   instead, with the frame reduced to exactly the numeric fields the panel should infer
   from.

**Then the real blocker, which was not in the dashboard at all.** The panel sat at
"Loading plugin panel…" forever, in a real browser as well as headless. Grafana's own boot
log had been saying why since the beginning:

```
level=error msg="Could not register plugin" pluginId=xychart
      error="plugin xychart is already registered"
```

**`xychart` was the only panel that failed to register**, so it never loaded. Disabling the
`autoMigrateXYChartPanel` toggle did not help. Booting 11.4.0 and 11.6.0 side by side and
diffing the logs settled it: 11.4.0 logs the error twice, **11.6.0 zero times**. The
observability overlay now pins **11.6.0**, with the reason written where the version is set.

On 11.6.0 the panel loaded and threw `TypeError: Cannot read properties of undefined
(reading 'map')` — it dereferences `options.series` unconditionally, so `mapping: "auto"`
still requires `series: [{}]` to be present. With that, the scatter renders.

**Outcome: every panel renders, verified by screenshot.** One trade: auto mapping turns a
third numeric field into a second Y series rather than point size, so graph size is not
encoded on the scatter — the Knowledge graph panel carries it instead. The table ships as a
peer panel regardless, so every measure is on screen whatever the scatter does.

## What the live stack showed (FR-L11, discharged)

All four predicted numbers landed, and **a second instance appeared during the work**, so
the table is no longer a single row:

| member | skills | tool calls | retained facts | memory | conversations |
|---|---|---|---|---|---|
| `28690354…` | 9 | 125 | 56 | 317 B | 12 |
| `ba226b3b…` | 9 | 0 | 0 | 317 B | 1 |

`skills` reports **9**, not the 10 directories present. `memory` reports **317 B** from
**one** non-empty file, not four. `retained facts` is **56** — the number that did not
exist before this feature.

The second row is already doing the job the feature was built for: same capability, no
consumption, nothing retained. That is the *Apprentice* quadrant, readable from the table
without the scatter.

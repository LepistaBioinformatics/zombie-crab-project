# ganglion-scale-to-zero — Spec

**Status:** Specified. Not implemented.
**Date:** 2026-09-10.
**Spans:** `crab/crab-ganglion-harness` (durability, startup) + `crab-shell-proxy`
(cron gating, transcript path).
**Builds on:** `.specs/features/crab-ganglion-harness/spec.md` — read its FR-6 and FR-9
first; this feature is what makes them survive a stop.

## Problem

Both picoclaw agents in this deployment run `mode: continuous`, for two stated reasons.
Only one of them still holds.

**"picoclaw loses its memory on a stop" — obsolete.** `internal/history/history.go:96`
carries a correction dated 2026-08-28: *"v0.3.1 runs the JSONL store by default … and
`JSONLStore.GetHistory` re-reads the session file on every call — so a restart no longer
costs the agent its history."* The comment in `crab/crab-shell-proxy/config.yaml` still
states the old behaviour and is stale. This is the third stale-comment finding in this
area; it is not evidence that picoclaw should switch, but it removes this reason.

**"scheduled tasks need the container alive" — holds.** picoclaw's cron service keeps its
schedule **in memory** (`internal/cron/cron.go`: *"picoclaw creates, schedules and deletes
jobs, and holds the live schedule in memory"*). A stopped container fires nothing. Any
harness with in-process timers has the same property.

`continuous` costs a container per member, running permanently, whether or not anyone is
talking to it. Scale-to-zero is what the per-user-container model is supposed to afford,
and the ganglion is the harness where it can be made safe by design rather than worked
around.

## What is already true, and what is not

Verified in the current tree, so the work is scoped to the gap and not to what already
works:

| | State |
|---|---|
| `ArmIdle` after every turn | **Works, harness-agnostic** (`handlers.go:766`, `sse.go:318`) — it keys on `agent.Mode`, not on the harness |
| Idle timer disarmed during a turn | Works — a scale-to-zero stop cannot fire mid-turn |
| Ganglion cold start | **0.18-0.23s** to health, measured (SZ-3). 21.6MB static binary, no supervisor |
| Transcript durability | **Gap** — see below |
| Partial answer during a turn | **Gap** — nothing is written until the stream closes |
| Proxy reading ganglion transcripts | **Broken** — path mismatch, see H-1 |
| Cron gated by mode | **Does not exist** |

### The durability gap, stated precisely

`internal/adapter/store/jsonl` does `OpenFile(O_APPEND) → Write → Close` per message, with
no `fsync`. Being exact about what that costs, because the common claim is too strong:
**killing the process or the container loses nothing** — the page cache is the kernel's,
and it outlives the process. `docker stop`, which is what scale-to-zero issues, is
therefore already safe today. What is lost is the last writes on a **host** crash or power
loss.

The larger gap is different and it is not about `fsync`: **a turn's answer is written only
when the stream closes.** A turn interrupted at 59 of 60 seconds loses everything the
member watched appear on screen, keeping only their question.

---

## Requirements

### Mode

**SZ-1 — A ganglion agent runs in `scale-to-zero` and the deployment may set it.**
No code change is expected here (`ArmIdle` is already harness-agnostic); the requirement
exists so the claim is tested rather than assumed.

**SZ-2 — A scale-to-zero agent still LISTS its scheduled tasks, and is told they will
not fire.**

*Rewritten 2026-09-10, after the first version was implemented and a pre-existing test
refused it.* The original read: "scheduled tasks are offered ONLY on an agent whose mode
is `continuous`", with `/v1/cron/*` answering 501. That was aimed at the wrong surface,
for two reasons the tree already knew:

- **The routes are read-only and need no container.** `internal/cron` "exposes no
  writer"; the proxy reads `jobs.json` off the volume. There is no create endpoint — the
  agent makes tasks from inside a conversation, and the proxy never sees it happen. So a
  501 here prevents nothing.
- **`cron.go` had already decided that hiding is worse.** Its own comment: *"A job the
  member cannot see is a job they cannot stop."* On a scale-to-zero agent the tasks are
  real, listed, and inert; refusing the list leaves the member unable to act on schedules
  that exist.

What the mode genuinely breaks is the **firing**, and no response code at this endpoint
fixes that. So the listing reports it: `cronTasksResponse.Fires` is false on a
scale-to-zero agent, whatever its harness. The member sees their tasks and sees that they
are not running.

**SZ-3 — Cold start to health-ready is under 1s**, and it is **measured, not asserted**.

Measured 2026-09-10 on the deployment's own NVMe volume, `docker run` to a 200 from
`/health`, three runs: **0.18s, 0.20s, 0.23s**. The budget is set at 1s — 5x headroom over
the measurement — rather than at the 3s this requirement originally carried, because a
budget fifteen times looser than the observed value is not a budget.

For scale, the Hermes harness took **180s** and that is what withdrew it. The difference is
a static Go binary with no supervisor and no bundled runtime.

### Durability

**D-1 — Every transcript append is `fsync`ed before the call returns.**
Three per ordinary turn (question, answer, tool result); one LLM call costs seconds, so
the cost is not observable. This is what makes a host crash lose nothing already
acknowledged.

**D-2 — A turn's partial answer is checkpointed while it streams.**
At most every 2 seconds of streaming, the text produced so far is written durably. A turn
interrupted mid-stream keeps what the member already saw.

**D-3 — A checkpoint is superseded, never duplicated.**
The final assistant message replaces its checkpoints. A reader must never show the same
answer twice, and must never show a stale partial next to the complete one. This is the
requirement that makes D-2 safe rather than merely well-intentioned; how it is achieved is
design.

**D-4 — A crash between the transcript write and the window write is recoverable.**
Already true by construction — the window is derived and rebuildable from the transcript —
but it becomes load-bearing once stops are routine, so it gets a test.

**D-5 — Nothing in D-1..D-3 may block the stream to the member.**
Durability is on the turn's critical path for correctness, not for latency: a checkpoint
that stalls delivery trades a visible problem for an invisible one.

### History

**H-1 — The proxy can read a ganglion agent's transcript.**
Today it cannot, and the durability work is pointless without it:

```
proxy reads:      <userDir>/<segment>/sessions/      (config.SessionsDir)
ganglion writes:  <userDir>/sessions/                (GANGLION_DATA_DIR + /sessions)
```

Reloading a gamma conversation returns an empty history. **Preferred fix: the ganglion
writes where the proxy already reads** — zero proxy change, and it keeps one path
convention across harnesses. The alternative (teach the proxy a per-harness path) is more
code for no gain, and is rejected unless the design finds a reason.

**H-2 — The transcript stays readable by `internal/history`'s existing parser.**
The ganglion already writes picoclaw's on-disk vocabulary (`role`, `content`,
`reasoning_content`, `created_at`) for exactly this reason. D-2's checkpoints must not
break that parser — a reader that predates checkpoints must not crash or show garbage.

---

## Out of scope

- **Switching picoclaw agents to scale-to-zero.** The reason to keep them continuous is
  gone (see Problem), but picoclaw is what production runs and the change is not needed by
  this work. Worth its own ticket, with the stale `config.yaml` comment fixed alongside.
- **Making cron work without a live container.** A durable scheduler that survives
  scale-to-zero is a real feature and a different one; SZ-2 reports that schedules are
  inert rather than reimplementing them.
- **Per-turn model selection, MCP, projects, memory graph** — still DF-1..DF-6.

## Acceptance

| # | Criterion |
|---|---|
| AC-1 | A ganglion agent set to `scale-to-zero` answers a turn, is stopped after idle, and answers the next turn with its history intact |
| AC-2 | Cold start to health-ready **< 1s**, recorded by a test (measured 0.2s) |
| AC-3 | `/v1/cron/*` LISTS tasks on a scale-to-zero agent with `fires:false`; unchanged, with `fires:true`, on a continuous one |
| AC-4 | A turn killed mid-stream leaves the partial answer in the transcript, and the next read shows it once |
| AC-5 | Reloading a ganglion conversation in the webapp shows the transcript |

## Open questions

All three were closed on 2026-09-10; kept with their answers because the numbers are the
argument.

- **OQ-1 — RESOLVED: no batching.** Measured on the NVMe volume the containers mount:
  `fsync` costs **887µs** per append (18µs without). Three per ordinary turn is **2.7ms**;
  a 60-second turn checkpointing every 2s is 30 syncs, **27ms**. Against 1.9–4.0s to the
  first token alone that is under 0.1%. Batching would be optimising something no member
  can perceive, at the cost of the guarantee it exists to provide.

  *(Measured at 4.79ms on `/tmp` first — that is the root ext4 volume, not where the data
  lives. Worth repeating on the Dokploy host before trusting it there.)*

- **OQ-2 — RESOLVED: recovery only.** A checkpoint is written but ordinary readers ignore
  it while the turn is alive; it becomes visible only when the turn did not finish. The
  rule that buys is simple — **a live turn has exactly one owner, the stream** — and it
  keeps this feature out of the way of `turn-stream-continuity`'s re-attach, which is the
  feature that actually owns "I reloaded mid-turn". Accepted cost: until re-attach ships,
  a reload during a turn shows less than the stream was showing.

- **OQ-3 — RESOLVED: 120s.** picoclaw's 15m exists because its cold start was expensive;
  SZ-3 measures the ganglion's at **0.2s**, so that reason is gone. Two minutes is short
  enough for scale-to-zero to be worth having and long enough not to recreate a container
  between two messages of one conversation.

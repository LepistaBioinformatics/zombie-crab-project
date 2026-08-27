# steering-messages — Feasibility Investigation

**Status:** Investigation (pre-spec). No implementation, no commitment.
**Date:** 2026-08-27.
**Verdict on the immediate question:** **not part of `turn-stream-continuity` — next
feature.** Reasons in §4. But it interacts with that feature's Group C in a way that must
be written down *now*, and §5 is that note.

## The question

picoclaw can fold a message that arrives mid-turn into the turn already running, instead
of answering it as a separate turn. Does this stack use it, and should
`turn-stream-continuity` pick it up?

## 1. picoclaw supports it. This stack cannot reach it.

**Upstream (from `picoclaw-as-library/investigation.md` §3.1, read in `v0.3.1`):** turns
are serialized per session key; a second message for an already-active session *"is not a
second turn. It is enqueued as a steering message folded into the running turn"* —
`enqueueSteeringMessage`, consumed at `turn_coord.go:115`.

**This stack never sends one.** The webapp holds it in a client-side queue and does not
POST it until the previous turn has fully finished:

- `flushPending` (`turn-store.ts`) turns a burst into one entry on `queue` and calls
  `drain`.
- `drain` loops `await runTurn(...)` then `await awaitDrained(sid)` — the second wait is
  for the *reveal* to finish, not merely for arrival, *"without this the next runTurn
  resets `revealed`/`buffered` and the previous reply is wiped off the screen
  mid-sentence"*.
- `draining` is a synchronous flag precisely so two bursts cannot run concurrently.

So the second message is POSTed strictly after the first turn's stream has ended. picoclaw
sees two sequential turns and its steering path is **structurally unreachable** from
zombie-crab. This is not an oversight — the queue was built to fix a real defect — but it
does mean the capability is unused.

The proxy imposes nothing here either: nothing in `sse.go` or `handlers.go` serializes per
session. A concurrent POST would reach picoclaw and *would* be folded. Only the browser
prevents it.

## 2. What using it would buy

The member types a correction ten seconds into a five-minute turn — "na verdade, só o Q3"
— and the agent takes it into account instead of finishing the wrong answer and then
starting a second five-minute turn. On long turns that is the difference between one wasted
turn and none, and long turns are exactly this stack's problem case.

## 3. What it would cost, and where it bites

Three real interactions, none of them cosmetic.

**3.1 — Two POSTs, one turn: the wire semantics are undefined.**
A steering POST is a `chat/completions` request that will never get its own answer — its
content lands in the *first* request's stream. Today's client assumes one POST → one
stream → one reply. Something has to say what the second stream returns: an immediate
`[DONE]` with no content, a distinct `x_crab_steering` acknowledgement, or a refusal. All
three are defensible; none exists.

**3.2 — The proxy's completion heuristic gets harder.**
`internal/pico/turn.go` finalizes on "real plain content has arrived AND typing has
stopped", after `graceWindow = 500ms`. A steering message injects more agent activity into
a turn the proxy may already have armed to finalize. `picoclaw-as-library` §5 already calls
this race *"tuned rather than solved"*; steering stresses it directly, and the failure mode
is a turn finalized mid-answer — worse than the bug being fixed.

**3.3 — The webapp's whole queue would need rethinking, not extending.**
`drain`'s two awaits exist to protect the reveal buffer. Steering means a running turn's
reveal receives content provoked by a message the member sent *after* it started. That is
not a change to the queue; it is a change to what a "turn" is on screen.

## 4. Why it is not part of `turn-stream-continuity`

Different problem, different failure, different surface. `turn-stream-continuity` is about
**bytes staying on the wire** — heartbeats, an inactivity bound, re-attach. Steering is
about **what a message means when one is already running** — turn semantics, in picoclaw
and in the proxy's completion machine.

Folding it in would also break that feature's own discipline: its Non-goals protect
`RunTurn`, the picoclaw processor and the completion heuristic, and §3.2 lands squarely on
the last of those. A feature that prevents connection cuts should not also be the feature
that renegotiates the turn boundary.

**Sequencing:** after `turn-stream-continuity`, and read together with
`picoclaw-incremental-streaming` — both are picoclaw-semantics work, both touch the
`graceWindow` race, and doing them as one study is cheaper than twice.

## 5. The forward-compatibility note that must not be lost

**`turn-stream-continuity` Group C keys its frame log `memgraph.Scope → sessionID`, which
assumes at most one turn in flight per conversation.** That assumption is true today
*because of the webapp queue in §1*, not because anything enforces it. Steering makes a
second POST arrive for a conversation that already has a live log.

If Group C is built, its log must either key by turn rather than by conversation, or
document the single-turn assumption explicitly so steering is a known migration and not a
surprise. **This is cheap to get right up front and expensive to retrofit** — it is the one
concrete reason this investigation was written before the feature it defers to.

(`turnRegistry` itself is already fine: `Begin` is re-entrant and counts, and
`background-turn-dock` DEC-4 made `since` first-seen, so a steering POST would correctly
keep the original turn's start time rather than resetting it.)

## Open questions

**OQ-1 — What does the steering POST's own stream return?** §3.1. The first thing to
decide; everything else follows from it.

**OQ-2 — Does folding a steering message disturb the 500ms `graceWindow`?** §3.2. Must be
answered before any implementation, not after.

**OQ-3 — Is there an upstream signal that a message was folded rather than answered?**
Not established. Without one the client cannot tell steering from a dropped message, and
would have to infer it from the absence of a second reply. Needs a read of
`turn_coord.go:115` and its surroundings in `v0.3.1`.

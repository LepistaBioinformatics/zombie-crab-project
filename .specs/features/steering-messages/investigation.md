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

---

## 6. OQ-1 and OQ-3 — ANSWERED from the source (2026-09-05)

Both were answered by reading `v0.3.1` while investigating a member report (§7), not by
implementing anything. They were the two questions this document said had to be settled
first, and the answers change the shape of the feature.

**OQ-3 — is there an upstream signal that a message was folded rather than answered? NO.**
`pkg/agent/agent.go:190-213`: the inbound loop claims the session key with
`activeTurnStates.LoadOrStore`, and when the key is already claimed it calls
`enqueueSteeringMessage` and `continue`s. The sender is told nothing — the only branch that
emits anything is the failure one, and it emits a **log line**. There is no ack frame, no
error, no distinct type. A steering POST is, from the harness's point of view, a message
that produced no reply of its own.

**OQ-1 — what does the steering POST's own stream return? THE RUNNING TURN'S OUTPUT.**
This is the part nobody expected. The pico channel fans every outbound frame out with
`broadcastToSession(chatID, msg)` — *"sends a message to all connections with a matching
session"* (`pkg/channels/pico/pico.go:936`). The second POST opens a **second WebSocket for
the same `session_id`**, so it receives the frames of the turn already running: its typing
pair, its tool narration, and its final plain message.

So the second stream does not hang and does not close empty. `RunTurn` on that connection
sees plain content and finalizes by the ordinary rules — with the **first turn's** answer,
after however long the first turn still had to run. The three defensible answers §3.1
listed (immediate `[DONE]`, an `x_crab_steering` ack, a refusal) were all wrong about the
default: the default is *"you get someone else's turn"*, and it is already happening.

**What this does to §3.2 (the `graceWindow` race).** Still open, and now sharper: the
folded message provokes further agent activity inside a turn the proxy may already have
armed to finalize, and the proxy sees that activity on **two** connections. Neither is
answered here.

## 7. The trigger: a reload removes the client-side queue

§1's claim — *"picoclaw's steering path is structurally unreachable from zombie-crab"* — is
true only while the page stays open. The queue that enforces it (`drain`'s `draining` flag
plus `awaitDrained`) lives in module scope in the browser, and **a reload wipes it**.

After a reload, `resumeIfActive` marks the conversation as running again, but nothing in
the send path consults that: `drain` gates on the synchronous `draining` set, which is
empty on a fresh page. So a message sent after a reload, while the previous turn is still
running, is POSTed straight through and folded as steering.

Which is exactly what a member reported (2026-09-05): after reloading during a long turn,
the next message *"demora muito pra enviar"*. It is not slow to send and it is not queued
anywhere in this stack — it was folded, and its stream is waiting out the remainder of the
turn it was folded into.

**So steering is not a capability to add. It is a behaviour already in production, with no
name in the interface and no acknowledgement on the wire.** That reframes the decision:

- **Tell the member** — the proxy already knows (`turnRegistry.Active(scope, sessionID)`,
  exposed at `/v1/turns/active`). Detecting the condition on the second POST and emitting a
  distinct `x_crab_steering` frame is one round-trip and no race, and it rides the same
  extension shape the client already parses. A pre-send probe from the webapp is the
  cheaper-looking alternative and is **advisory only**: the turn can end between the probe
  and the POST.
- **Make it a feature** — everything in §3 still applies, and §6 has now removed the worst
  unknown (OQ-1) while leaving §3.2 untouched.

Either way, the current default — the member's message silently changing someone else's
turn, and their stream showing an answer to a question they did not ask — is the thing to
retire.

## 8. The other half of the same report

The same member reported that after a reload the conversation *stops updating* until yet
another reload. That is a different defect in a different feature and is written up in
`turn-stream-continuity/field-observation-resume.md`. It matters here only because it is
what makes the steering path reachable in practice: a member whose chat looks idle sends
the next message.

## 9. What shipped: the announcement (2026-09-05)

Option "tell the member", from §7. **Not** the feature — steering is still not something
this stack offers on purpose; it is something that happens to a member who reloads, and
now it says so.

**Proxy (`crab-shell-proxy`).**

- `handleChatCompletions` reads `s.turns.Active(scopeOf(key), req.SessionID)` **before**
  `Begin`. The order is the whole of it: `Begin` counts this request in, so asking
  afterwards would report every turn as steering.
- `streamTurn` takes that flag and, right after the opening role chunk and before any
  wait, emits `x_crab_steering: {folded: true}` — an ordinary `chat.completion.chunk` with
  an **empty delta**, the same compatibility shape `x_crab_progress` and `x_crab_error`
  use, so a generic OpenAI client skips it rather than rendering it as the assistant.
- The synchronous path gets a log line only: its response shape has no room for an
  extension field, and the only caller that could act on one always streams.
- The turn is **not** refused or short-circuited. What follows on that stream is the other
  turn's output, which is the member's own conversation and what they want to read.

**Webapp (`crab-exoskeleton-webapp`).** `consumeStream` grew a fifth callback,
`TurnState.steering` records it for the conversation (reset per turn), and `TurnSteering`
renders one line above the band in both its arms — no spinner and no elapsed readout,
because nothing there is waiting on *this* message. Copy in both locales.

**Tests, each watched failing first.**

| Test | Pins |
|---|---|
| `TestSecondPostOnALiveConversationIsAnnouncedAsSteering` (proxy) | a real second POST, made while a first turn is blocked in `RunTurn`, carries exactly one `x_crab_steering` frame with an empty delta |
| `TestFirstPostCarriesNoSteeringFrame` (proxy) | a lone turn is byte-identical to before |
| `consumeStream` → *"routes x_crab_steering without emitting a content delta"* | the announcement is not content, and the frames after it still are |
| *"marks the conversation while the folded turn streams"* | the store records it end to end, from a stream a `runTurn` actually consumed |
| `TurnSteering` → *"says the message joined the turn already running"* | the sentence renders, and is not dressed up as progress |

`internal/httpapi` and `internal/pico` green; `go vet` clean; the webapp's 1379 tests and
`next build` green. The only failures in `go test ./...` are the ten pre-existing
`internal/docker` `lchown … operation not permitted` ones (that suite needs root).

**Deliberately still open:** §3.2 — whether folding disturbs the 500ms `graceWindow` —
because nothing here changes when a turn finalizes. And OQ-2 of this document is that same
question, still unanswered.

**Not covered by the announcement:** the member has no way to *choose*. If they wanted a
separate turn rather than a correction folded into the running one, the only lever is Stop
followed by a resend. Making that a choice is the feature, and it is still deferred.

---

## 10. The ganglion (2026-09-13)

**Question asked:** how complex is it to implement steering on the ganglion.

**Answer:** the question has no useful number yet, because the ganglion has no
definition of what a second POST on a live conversation IS. Everything from §1 to §9
above is about picoclaw, which has one (`enqueueSteeringMessage`). The ganglion has
none — not a refusal, not a queue, not a fold. Alpha runs the ganglion
(`config.yaml:110`), so this is the live behaviour, and it is worse than the one §7
reported.

### 10.1 What a concurrent POST does on the ganglion today

Three legs, each read rather than assumed:

| Layer | What it does | File |
|---|---|---|
| harness HTTP | calls `s.handler(r.Context(), turn, sink)` directly. No claim, no lock, no queue. | `internal/adapter/httpsse/httpsse.go` |
| harness loop | `Transcript.Append` (the question), then `Context.Load`, then appends and `Save`s per iteration | `internal/runtime/loop.go` |
| proxy runner | `active[req.SessionID] = cancel`, `defer untrack(id)` | `crab-shell-proxy/internal/ganglion/turn.go` |

Nothing else serializes: `MaxConcurrent` in the harness bounds SUB-agents, not member
turns, and the proxy's chat handler counts turns without gating on the count.

So two POSTs on one conversation are **two concurrent turns**, with three distinct
consequences that should not be merged:

**10.1.a — The context window takes a LOST UPDATE.** Turn A loads the window at N
messages; turn B loads the same N; A appends its work and saves; B appends and saves,
and A's iterations are gone. The store's mutex guards each `Load` and each `Save`, never
the read-modify-write that spans a turn. The agent forgets work it just did. This is the
severe one.

**10.1.b — The served transcript INTERLEAVES.** `jsonl.Store.Append` holds its mutex per
append, so nothing is corrupted — but the two turns' steps land in arrival order, and the
member reads one conversation's narration threaded through another's. Confusing,
recoverable, not destructive.

**10.1.c — Stop stops the wrong turn, or none.** `active` is keyed by session id alone.
The second turn overwrites the first's cancel func, and whichever turn finishes first
deletes the entry with `untrack`. After that, `Cancel` is a no-op for the one still
running.

**And the interface says the opposite of all three.** `handlers.go`'s steering
announcement (§9) reads `s.turns.Active(scope, sessionID)` with **no harness check**, so
the ganglion path emits `x_crab_steering: {folded: true}` and the webapp renders "your
message joined the turn already running". Nothing was folded. A second turn started and
is about to overwrite the first's window.

**This is a data-loss defect wearing a feature's label, and it is live.** It is
separable from steering and much smaller — see §10.4.

### 10.2 What is CHEAPER on the ganglion than picoclaw's estimate

Three of §3's costs do not transfer.

**§3.2 (the 500ms `graceWindow`) is void.** The ganglion serves SSE natively and ends a
turn by closing the stream; `internal/ganglion`'s own package doc says there is no
analogue of `pico/turn.go`'s heuristic. OQ-2 of this document is answered for this
harness: **nothing to disturb.**

**§6's OQ-1 answer does not apply.** "The second stream returns the running turn's
output" was a consequence of picoclaw's `broadcastToSession` fan-out. The ganglion serves
each request its own stream and broadcasts nothing, so the second POST's stream is a free
design choice rather than an inherited accident.

**The announcement is already built, end to end.** `x_crab_steering`, `consumeStream`'s
fifth callback, `TurnState.steering`, `TurnSteering`, copy in both locales (§9). Folding
would make that frame TRUE rather than retiring it.

### 10.3 What is NEW, and the constraint that sizes it

picoclaw folds for free — it is upstream's code. On the ganglion it is ours to write, and
one structural rule decides the shape.

**A folded user message may be appended at exactly one place in the window.** An
assistant message carrying `tool_calls` must be followed by its tool results
CONTIGUOUSLY, or the provider answers `insufficient tool messages following tool_calls
message` and the conversation is dead for every later turn — this is not theory, it is
the 400 traced to `loop.go`'s per-call loop and fixed by holding `media` until the whole
batch had answered. So the only legal injection point is **after the media append, before
the next `completeWithFallback`** — where `compact` and `Context.Save` already run. "Inject
whenever it arrives" is not an option.

Two things check out in the design's favour at that point: `compact` drops from the
OLDEST end, so a message appended at the tail cannot be evicted before it is sent; and
`repair`/`dropOrphanTools` only trims LEADING tool results, so a user message at a batch
boundary is structurally safe by construction.

What has to be built:

1. **A per-session claim in the harness** (`httpsse.go`), the shape picoclaw uses —
   `LoadOrStore` on the session id. This is the prerequisite for everything, including
   doing nothing about steering.
2. **A mailbox on that claim**, and a drain at the batch boundary above.
3. **A transcript write path for a folded user message.** `record` writes assistant
   messages only; the member's correction has to land in the served history where it was
   said, or it vanishes and the answer addresses a question nobody can see. The proxy's
   reader then sees `user → step → step → user → step → answer`, which
   `keepAnswerlessTurns` has never been shown.
4. **A turn-boundary decision.** A message arriving after the final frame has started —
   the one with no tool calls — has no next iteration to be drained into. It must either
   become its own turn or force one more iteration. Neither is free, and the choice
   decides whether "steering" has a deadline the member cannot see.
5. **A way for the steering POST to REACH the running turn.** Today each POST is its own
   request into its own goroutine; the second one has to hand its message to the first's
   mailbox and then answer its own client. This is a harness API question, not a detail.
6. **`Cancel` keyed per turn, not per session** (§10.1.c), or Stop stays broken the moment
   two turns exist on purpose.
7. **The webapp's queue**, unchanged from §3.3: `drain`'s two awaits exist to protect the
   reveal buffer, and steering means a running turn's reveal receives content provoked by
   a message sent after it began. That is not an extension of the queue; it is a change to
   what a turn is on screen.

### 10.4 Sizing

**The prerequisite — define the concurrent POST — is Small.** One file in the harness
(`httpsse.go`), a claim keyed by session id, and a decision for the loser: refuse with a
distinct frame, or wait. It removes 10.1.a and 10.1.b outright, and it is the same hook
steering would later hang the mailbox on. Add the harness check on the proxy's steering
announcement so the interface stops asserting a fold that did not happen, and a per-turn
key for `active` (10.1.c). Estimate: one sitting, three files, tests each.

**Steering itself is Large**, and the size is not in any one repo — it is that items 4, 5
and 7 above are each a decision nobody has made, in three different repos, and 7 was
already called out as a rethink rather than an extension eighteen days ago. The harness
mechanics (items 1–3) are the easy half.

**Recommendation:** take the prerequisite now as a defect, on its own. Leave steering
deferred until someone wants it as a feature, at which point the claim from the
prerequisite is already the hook and OQ-2 is already answered for this harness.

### 10.5 What this changes about §4's sequencing

§4 deferred steering to "after `turn-stream-continuity`, read together with
`picoclaw-incremental-streaming`, because both are picoclaw-semantics work". Both of those
are now about a harness this deployment no longer runs on alpha. The pairing is void; the
prerequisite in §10.4 stands on its own and depends on neither.

### 10.6 What shipped: the prerequisite (2026-09-13)

§10.4's "take the prerequisite now as a defect, on its own". **Not** steering — a
message that arrives mid-turn is still not folded on the ganglion, it is queued.

**The harness** (`crab-ganglion-harness#19`). `httpsse.go` claims a conversation for
the duration of a turn; a second POST WAITS rather than running concurrently. Refusing
would make the member resend a message while waiting on a turn they cannot see, and
queueing is what the browser's own queue does when it has not been wiped by a reload —
so a reloaded page now behaves like one that was never reloaded.

Two properties the implementation is shaped around, and both are load-bearing:

- the wait is **after the headers and the heartbeat**, so the connection carries bytes
  while it waits and no hop between there and the member reclaims it;
- the wait is **interruptible**, so a request killed by the proxy's turn budget or by a
  member navigating away starts no turn at all. That is why it is a channel per
  conversation rather than a mutex: a goroutine parked on a mutex cannot notice a dead
  context.

Serialization is per CONVERSATION, not per container. A member with two chats open is
two conversations, and making them wait for each other would turn a correctness fix
into a queue nobody asked for.

**The proxy** (`crab-shell-proxy#60`). Two things that were saying something untrue.

`internal/ganglion`'s `active` kept one cancel func per session (§10.1.c); it is a map
per session now and `Cancel` stops every turn on the conversation — the member asked for
the chat to stop, not for one of its requests to.

And the steering announcement stopped being harness-blind. The frame carries `folded`
and `queued`, exactly one true, read from the AGENT for the same reason the
streaming-mode header is: it is flushed before `EnsureRunning`, so the docker target does
not exist yet.

**The webapp** (`crab-exoskeleton-webapp#69`). `TurnState.steering` is
`"folded" | "queued" | null` and the banner renders a sentence for each. `folded` is read
first and explicitly, so a proxy that predates `queued` still reads as a fold rather than
as neither.

**What this closes, from §10.1:** the lost update on the context window (a), the
interleaved transcript (b), the Stop that stopped the wrong turn (c), and the
announcement asserting a fold that did not happen.

**What it does not close:** steering itself. §10.3's items 4, 5 and 7 — the turn
boundary, how a second POST reaches the running turn, and the webapp's reveal queue —
are each still a decision nobody has made. The claim is now the hook they would hang on,
and OQ-2 stays answered for this harness: there is no graceWindow to disturb.

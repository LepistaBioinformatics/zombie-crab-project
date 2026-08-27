# turn-stream-continuity — Spec

**Status:** Specified. Not implemented.
**Spans:** `crab-shell-proxy` (heartbeat, frame sequencing, re-attach endpoint) +
`crab-exoskeleton-webapp` (BFF stream route, re-attach client, network-aware waiting).
**Date:** 2026-08-27.
**Successor to:** `long-turn-resilience` (webapp), `resume-turn-after-reload`,
`background-turn-dock`. Read `context.md` before this file — it records which of those
are actually deployed, and that is what decides this feature's shape.

## Problem

A member sends a message, the agent works for a few minutes, and the chat stops
representing the work. They reload the page to find out whether anything happened.

That complaint has been answered three times already, and all three answers are
**recovery**: notice the stream is gone, then find the reply some other way.
`long-turn-resilience` polls the durable transcript. `resume-turn-after-reload` asks the
proxy on mount. `background-turn-dock` shows what is running elsewhere. Two of the three
are running in production today (`context.md` §1), and the complaint is being filed
against a build that has them.

So recovery is not the missing half. **Nothing in this stack prevents the cut**, and both
specs that noticed said so and declined:

- `long-turn-resilience` → *"Alternatives not taken: keep-alive frames from the proxy …
  It belongs in the proxy repo."*
- `crab-shell-proxy/.specs/features/multi-harness-support/implementation-notes.md` §9 →
  *"Anyone re-adding Hermes should treat this as the first problem to solve, not the
  last."*

This feature is that half, plus the reconnection the recovery path never had.

## Why the stream goes quiet in the first place

The chain is already in the repo; it had not been joined up.

1. **picoclaw does not stream.** It returns the whole answer in one terminal frame —
   measured, `chat-responsiveness` OQ-1: `typing.start`, **51 seconds of complete
   silence**, then the reply.
2. **`sse.go` emits nothing of its own.** Content, progress, error and attachment frames
   are all reactions to picoclaw. Between picoclaw's frames the SSE is genuinely idle,
   for as long as the agent thinks.
3. **That idle stream crosses four hops** — browser ↔ Traefik ↔ the Next BFF ↔ mycelium
   ↔ crab-shell-proxy — each with its own tolerance for a connection that carries no
   bytes. The hop this feature cannot see or configure is the first one: mobile NAT, a
   wifi handover, a VPN, a corporate proxy. That is the hop the member calls "the
   internet fluctuating".

This is deliberately **not** a claim that the gateway is the culprit. `context.md` of
`long-turn-resilience` established that it is not (`gatewayTimeout=60s`, but *"awc timeout
is headers-only"*), and nothing here contradicts it. FR-1 is written the way
`long-turn-resilience` FR-1 was written: against a locally observable invariant, not
against a theory of which hop is guilty. A stream that is never idle cannot be dropped
for being idle — by any hop, including the ones we will never instrument.

## Goals

- A running turn's connection is never silent long enough for anything to reclaim it.
- When a cut happens anyway, the client re-attaches to the *live* turn and keeps
  receiving it, instead of waiting blind for a transcript to grow.
- A member on a flaky connection is told which thing is wrong — their network, or ours —
  and the interface reacts the moment their network comes back.

## Non-goals

- **Never re-POST a turn.** Unchanged from `long-turn-resilience`: once the stream is
  open the turn is committed upstream, and re-sending would run a ten-minute turn twice.
  Every mechanism here is a *read*.
- **No change to how a turn is *produced*.** Not `RunTurn`, not the picoclaw processor,
  not the completion heuristic, not the background `turnCtx` the turn runs on, not the
  `clientCtx` guards that stop writing without stopping the turn. If a task starts editing
  any of those, the task is wrong.

  **This is narrower than `background-turn-dock` DEC-1's "this feature reads state; it does
  not produce it", and deliberately so.** That sentence is inherited from the dock and is
  **false for Group C**: re-attach changes the *response-write path* — the sinks stop
  writing a `ResponseWriter` directly and write a fan-out log instead. Nothing about how
  the turn is computed changes; how its bytes are delivered does. FR-14a is what keeps that
  change off the turn's critical path.
- **Not raising mycelium's `gatewayTimeout`.** Rejected in `multi-harness-support` §9 and
  again in `long-turn-resilience`, for the same reason both times: it is global, so it
  degrades failure detection for every other service to accommodate this one. It stays
  rejected. (Note `deploy/standalone/config.standalone.toml:96` already sets 600 — that
  is the single-tenant profile, and it did not make this problem go away.)
- **Not making picoclaw stream.** That is the right fix for the *silence* and the wrong
  scope for this spec. See `picoclaw-incremental-streaming/investigation.md`, written in
  parallel with this one, and DEC-8.
- **Not using picoclaw's steering messages.** picoclaw folds a message that arrives
  mid-turn into the running turn (`enqueueSteeringMessage`), and this stack never reaches
  that path — the webapp queues the second message client-side and POSTs it only after the
  first turn's reveal has drained. Worth having, and **not here**: this feature is about
  bytes staying on the wire, steering is about what a message *means* when one is already
  running, and it lands directly on the completion heuristic this spec's Non-goals protect.
  See `steering-messages/investigation.md`, and OQ-4 below for the one part of it that
  constrains Group C.
- **Not making a failed turn survive a reload.** Still `turn-failure-visible`'s
  limitation; picoclaw does not persist errors. Inherited, not fixed.

## Prerequisite

**P-0 — SATISFIED for its deploy half (2026-08-27); one half remains.**

*Why it existed:* the dock is the affordance that answers "what is running right now"
without a reload. While the deployed build predated it, any before/after judgement of this
feature would have measured the dock's absence as well as the cut.

- **Deploy + verification — done.** `background-turn-dock` is deployed and its T-10 run
  and confirmed by the maintainer. That feature is finished.
- **Baseline — still open, and still needed before T-02 ships.** T-08 is a real gate: it
  counts how often the recovery path fires *after* the heartbeat, and without a
  pre-heartbeat count taken on the now-deployed build it produces one figure and nothing to
  compare it against. `long-turn-resilience` OQ-1 already gives the instrument — a recovery
  that fires is a cut that happened. See `tasks.md` P-0.

This is a measurement, not code.

## Requirements

### Group A — the stream is never silent (crab-shell-proxy)

**FR-1 — While a turn is in flight, the proxy writes a heartbeat at a fixed interval.**
It starts once the stream is open and stops when the turn ends. Its purpose is to keep
the connection carrying bytes, so no hop can reclaim it for being idle — whichever hop
that would have been.

**FR-2 — The heartbeat is an SSE comment, never a data frame.**
`: ping\n\n`. This is not cosmetic and it is the requirement most likely to be
"simplified" into a bug, so the reason is here rather than in the design:

`background-turn-dock` DEC-12 made the band's elapsed readout and the dock's chips both
derive from `lastEventAt`, precisely so *"a chip and the band it corresponds to can never
disagree"*. `lastEventAt` is stamped in `runTurn`'s `onDelta` and `onProgress`
(`turn-store.ts`). A heartbeat shaped as an empty-delta `x_crab_progress` chunk — the
obvious shape, since that extension already exists — would stamp it every ten seconds,
pinning "quiet for" at zero forever and destroying `long-turn-resilience` FR-11/FR-12
outright. A comment line cannot: `consumeStream` does
`if (!line.startsWith("data:")) continue` **before** any bookkeeping, so a comment is
dropped ahead of every state change. **The webapp therefore needs no change for Group A
at all**, and that is a property to preserve, not a coincidence to rely on silently.

**FR-3 — The interval is chosen against the tightest plausible hop, not against the
gateway.** Ten seconds. Mycelium's 60s is the *loosest* bound in the chain and the only
one written down; mobile NAT and edge idle timeouts sit well below it, and the member's
complaint is specifically about their connection, not ours.

**FR-4 — The heartbeat obeys the same client-gone guard as every sink.**
`clientCtx.Err() != nil` stops it writing, exactly as `Content`, `Progress`, `Error` and
`Attachment` already early-return. The turn keeps draining regardless — that invariant is
untouched.

**FR-5 — Every write to the response is serialized.**
Today all writes happen on the request goroutine, so `sse.go` needs no lock. A heartbeat
is a second writer by construction. Without a mutex around `writeChunk` /
`writeProgress` / `writeError` / `done` / the heartbeat this is a data race on an
`http.ResponseWriter`, and interleaved output would corrupt a frame the client is
mid-parse on. `go test -race` must be part of this task's gate.

**FR-6 — Heartbeats are neither sequenced nor buffered.**
They carry no state. Group C's sequence numbers and replay buffer are for frames that
mean something; admitting heartbeats would fill the buffer with noise and make a
re-attach replay ten minutes of pings.

### Group B — the BFF stops cutting its own upstream (crab-exoskeleton-webapp)

**FR-7 — The streaming route must not impose an inactivity bound shorter than the
proxy's own turn bound.**
`fetchMycelium` calls bare `fetch` with no dispatcher (`lib/mycelium.ts:79`), so the
streaming POST inherits whatever the runtime's default inactivity behaviour is. If that
default is shorter than `turnTimeout` (10 min, `sse.go:19`), then **our own BFF aborts the
upstream body** on a long quiet turn and the member's "the internet dropped" was never
the internet. **This is stated as a hypothesis to test, not a finding** (OQ-2): the first
task is the measurement, and the fix is whatever the measurement points at. Group A alone
may already make this unreachable — a stream that pings every ten seconds is never
inactive — which is why the measurement matters more than the guess.

**FR-8 — The streaming route declares itself unbuffered.**
`X-Accel-Buffering: no` alongside the `Cache-Control: no-cache` it already sets. Traefik
does not buffer responses by default, so this changes nothing today; it is a one-line
guard against an nginx-shaped hop being introduced later and turning progressive delivery
into a single blob at the end, which would present as this exact bug.

**FR-9 — Whatever the fix for FR-7, it is scoped to the streaming route.**
A global dispatcher change would remove the inactivity guard from every admin and history
call as well, where it is the only thing that catches a hung upstream. One route has a
ten-minute quiet period as normal behaviour; none of the others do.

### Group C — re-attaching to a live turn (both repos)

**FR-10 — Every data frame the proxy writes carries a monotonic sequence number.**
As an SSE `id:` line, not a field inside the JSON payload — see DEC-3.

**FR-11 — The proxy retains a turn's frames for the life of the turn, plus 60 seconds
after its terminal frame.**
During the turn the log is simply alive — that is the ten-minute case, and it is bounded by
`turnTimeout`, not by this. The 60 seconds is a *different clock*: it covers only
notice-plus-reload-plus-re-attach after the turn has already ended, which is tens of
seconds, not minutes. It is deliberately **not** derived from `RECOVERY_BUDGET_MS` (11 min,
sized to outlast `turnTimeout`); a turn that has written its terminal frame has nothing
left to produce, and holding its bytes for eleven minutes would be retention for its own
sake. The number is stated here rather than left to the implementation because T-09 needs a
value and design test 11 needs a threshold — a guess made at build time would silently
become the contract.

**FR-12 — A re-attach endpoint resumes a running turn from a sequence number.**
It replays the frames after that sequence, then continues live until the turn's terminal
marker. Same frame shapes, same terminal marker: a re-attached client runs the same
`consumeStream` it already has.

**FR-13 — Re-attach is strictly a read.**
It never starts a turn, never re-POSTs, and never registers a turn in `turnRegistry`. A
re-attach to a conversation with no running turn is answered, not created.

**FR-14 — A turn may have more than one reader.**
The original POST stream and a re-attach can be live at once — the client cannot know its
old socket is truly dead, only that it stopped delivering — so the proxy fans out rather
than handing over.

**FR-14a — Appending a frame never blocks on any subscriber, and a subscriber that cannot
keep up is dropped.**
This is the requirement that keeps FR-14 off the turn's critical path, and it is stated
separately because "must not stall the turn" is otherwise an aspiration rather than
something a test can assert. Each subscriber has its own bounded outbound queue. A full
queue means that reader is gone or too slow: it is **dropped**, immediately and without
being awaited. It is never waited on, and its slowness is never observable by the turn, by
the log, or by any other subscriber. A dropped subscriber is not an error — it is a client
that stopped reading, which is the case this whole feature exists for, and it can
re-attach.

**FR-15 — The client re-attaches before it polls; the poll stays as the floor.**
On a cut with no terminal marker, the store tries re-attach first. On success the turn
continues as though nothing broke: progress arrives, `lastEventAt` advances, the band goes
back to being a working band. On failure — buffer expired, endpoint absent, an older proxy
— it falls through to today's `recover()` polling, **unchanged**. The poll needs nothing
from the proxy and is what keeps this feature from being a single point of failure.

**FR-16 — Re-attach is bounded and backs off, and its budget is visibly smaller than
FR-11's retention.**
It is a reconnection, not a second retry ladder: a few attempts with backoff over roughly
**30 seconds**, then the poll takes over. The relation to FR-11 is the point — 30s of
trying against 60s of retention means a re-attach can never fail *because the log expired
while it was still trying*, which would be the confusing failure. `MAX_SEND_ATTEMPTS` (10
attempts, up to 30s apart) is deliberately not reused: that ladder exists for a turn that
was never accepted, and this one is for a turn that certainly was.

**FR-17 — Buffered frames are bounded per turn.**
A long reply plus a tool-heavy turn is a lot of text, and it is held per in-flight turn
per member. Overflow drops the oldest and the buffer says so, so a re-attach that cannot
be served completely is refused and falls to the poll (FR-15) rather than replaying a
transcript with a hole in it.

**FR-18 — A client with no sequence re-attaches from the start of the turn.**
After a reload the sequence is gone with the tab. Replaying from zero is correct and is
what a reloaded client wants: it rebuilds the partial reply and the progress state it
would otherwise have to invent. This is the path `resumeIfActive` takes today, and it
currently lands in `recover()`, which patches `recoveringSince: Date.now()` and can only
wait (`background-turn-dock` DEC-4 records how that lies about elapsed time).

**FR-19 — Recovery copy distinguishes re-attached from waiting.**
A re-attached turn is not "recovering" — it is running, and the member should see the
working band, not the dropped-connection line. The recovery line stays for the poll path,
where it remains the honest description.

### Group D — reacting to the member's actual network (crab-exoskeleton-webapp)

**FR-20 — A wait wakes immediately when the browser comes back online.**
`recover()` polls blind every `RECOVERY_POLL_MS` and nothing listens to `online`. A member
leaving a tunnel waits up to a full interval past the moment their connection returned,
and a re-attach (FR-15) would have failed for the whole outage and be mid-backoff. The
`online` event resets the backoff and fires an attempt at once.

**FR-21 — And when a backgrounded tab becomes visible again.**
`visibilitychange` → visible does the same. Mobile browsers throttle timers in background
tabs, so the poll a member returns to may be minutes stale.

**FR-22 — Offline is named as offline.**
While `navigator.onLine` is false, the band says the device has no connection — not that
we are reconnecting to the agent. They are different problems with different actions for
the member, and today they read identically.

**FR-23 — Both locales, no exceptions.**
Every string added lands in `en` and `pt-BR` in `lib/i18n/chat.ts` (and
`lib/i18n/errors.ts` for any new code). There is a parity test.

## Decisions

**DEC-1 — Prevention is the feature; the rest is contingency.**
Group A is the only part that reduces how often the member is inconvenienced at all.
Groups C and D make the inconvenience shorter and more honest. If only one group ever
ships, it is A — and A is deliberately the one that needs no webapp change and no
submodule pointer bump (FR-2), so it can ship on its own.

**DEC-2 — Group C is in scope by maintainer decision, over the cheaper sequencing
(user-directed).**
Asked to choose, the maintainer chose to include the re-attach path now rather than hold
it as a gated follow-up. The cheaper reading — that Group A prevents most cuts and Group C
would then buy little — is not wrong, and this spec does not pretend otherwise. What it
does instead is put the answer in the build order: **A → B → measure → C** (see
`tasks.md`). The measurement between B and C is what tells us whether C earned its keep,
and it is worth having on record either way.

**DEC-3 — The sequence rides as an SSE `id:` line, not a field in the chunk.**
`id:` is the native SSE mechanism and its counterpart, `Last-Event-ID`, is what a
reconnection is supposed to send. A field inside the OpenAI chunk would work equally well
for our own client and would be one more proprietary extension in a payload the proxy
keeps deliberately generic — the same compatibility argument `sse.go` already makes for
carrying progress as an extra top-level field rather than a named SSE event. The client
does not use `EventSource` (it needs a POST), so it parses `id:` by hand; that is three
lines in `consumeStream` beside the `data:` check that already exists.

**DEC-4 — Re-attach precedes the poll and never replaces it.**
The poll is the floor because it depends on nothing new: it reads the history endpoint
that has existed since `chat-history`, and it works against a proxy that has never heard
of Group C. Making re-attach the only path would tie a shipped, working recovery to a new
endpoint's availability, and would mean a proxy/webapp version skew presents as the
original bug.

**DEC-5 — The frame buffer is in the proxy's memory, and losing it is correct.**
Not Redis, not disk. A proxy restart loses the buffer, and a proxy restart also kills the
turn (`turnCtx` dies with the process) — so there is nothing to re-attach to and nothing
was lost that survived. Adding durable storage would buy re-attach to a turn that no
longer exists.

**DEC-6 — Heartbeats do not touch `lastEventAt`, and that is a contract, not an
implementation detail.** Restated from FR-2 because it is the single thing most likely to
be broken by a later well-meaning change (for instance, "let's give the heartbeat a
timestamp so the client can measure drift"). Any frame the proxy invents on its own
schedule must be invisible to the client's event bookkeeping.

**DEC-7 — Group D is small, client-only, and shipped with B rather than held for C.**
It needs nothing from the proxy and it is the part that most literally answers the
complaint as it was filed ("sensível a flutuações na internet"). Holding it behind the
expensive group would be sequencing by cost rather than by value.

**DEC-8 — picoclaw's transport is not the problem; its framing is.**
The question that started this feature included implementing an HTTP connection in
picoclaw. Recorded here because the answer is useful and non-obvious: **that is the wrong
hop.** proxy ↔ picoclaw is server-to-server inside the Docker network, over a WebSocket
that neither the member's connection nor any edge proxy touches; changing its transport
cannot affect a symptom that originates between the browser and the gateway. The
legitimate picoclaw-side item is a different one, and it is upstream of everything above:
picoclaw answers in **one terminal frame**, which is what creates the 51-second silence
this whole feature works around. See
`picoclaw-incremental-streaming/investigation.md`.

## Alternatives not taken

- **WebSocket between the browser and the BFF**, replacing SSE. It would carry native
  ping/pong and make reconnection a solved problem. Rejected on cost and blast radius: the
  proxy's OpenAI-compatible SSE shape is consumed by more than this client, the BFF would
  become a stateful bridge instead of a byte pipe (`route.ts` is currently `return new
  Response(res.body)`), and Group A gets the same idle-liveness for a ticker and a mutex.
  Worth revisiting only if Groups A and C both prove insufficient.
- **Long-polling instead of a stream.** Would trade one long connection for many short
  ones, which does survive a flaky network — and would discard progressive delivery,
  progress events, and the whole `chat-responsiveness` feature. The band exists because a
  silent turn was the original complaint.
- **A service worker holding the stream outside the page.** Real, and it survives a tab
  close, not merely a reload. Out of proportion here, and `pwa-installability` is
  deliberately unrelated (`background-turn-dock` non-goals, OQ-1).
- **Raising `gatewayTimeout`.** See Non-goals. Rejected three times now.
- **Keeping the turn on `r.Context()`** so a disconnect cancels it cleanly. Actively
  harmful and already tried: `sse.go`'s own comment records that it truncated picoclaw's
  transcript ("initial messages disappear after reload").

## Open questions

**OQ-1 — What actually cuts the stream is still not established.**
Inherited from `long-turn-resilience` OQ-1, and this feature is again built not to need
the answer. It does make it more observable in two new ways: after Group A, a cut on a
stream that was pinging ten seconds ago is a much narrower event than a cut on a stream
silent for a minute; and after Group C, a re-attach reports the sequence it resumed from,
which says how much was lost.

**OQ-2 — Does the BFF impose an inactivity bound on the upstream body at all?**
FR-7 is written as a hypothesis for exactly this reason. `fetchMycelium` passes no
dispatcher, so the answer is the runtime's default, and this spec does not assert what
that default is on `node:24-alpine`. T-04 measures it before anything is changed.

**OQ-4 — Should Group C's frame log be keyed by turn rather than by conversation?**
FR-10/FR-11 key it `memgraph.Scope → sessionID`, like `turnRegistry`, which assumes at most
one turn in flight per conversation. That is true today **only because the webapp queues a
second message client-side** — nothing in the proxy enforces it, and a concurrent POST
would already be folded by picoclaw as a steering message. If steering is ever adopted, a
conversation-keyed log has two writers. Deciding this before T-09 is cheap; retrofitting it
after is not. See `steering-messages/investigation.md` §5.

**OQ-3 — Does every hop forward SSE comment lines untouched?**
The SSE spec says they are legal and ignorable, and this repo already relies on that
convention in the other direction (`multi-harness-support` §10: *"only `data:` lines
matter (`event:`/`id:`/comment lines are skipped)"*). But mycelium's proxying of the body
has never been tested with one. T-03 verifies it end to end before Group A is called done
— if a hop strips them, the fallback shape is a `data:` frame the client is taught to
discard *before* the `lastEventAt` stamp, which costs the webapp change FR-2 was written
to avoid.

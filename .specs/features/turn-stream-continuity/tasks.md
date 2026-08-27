# turn-stream-continuity — Tasks

Read `spec.md`, `context.md` and `design.md` first.

**Gate for every proxy task:** `go vet ./...`, `go test -race ./...` green.
**Gate for every webapp task:** `yarn test` green, `yarn build` clean.

## Build order, and why it is this one

**P-0 → A → B+D → measure → C.**

Group A ships alone, as a proxy-only release with no webapp change and no submodule
pointer bump (spec DEC-1, design "What the webapp does about it"). It is the only group
that reduces how often a member is inconvenienced at all, and it is the cheapest thing
here. Nothing should be sequenced ahead of it.

The measurement between B+D and C is deliberate and is the honest half of DEC-2: the
maintainer chose to include the expensive re-attach path, and the cheap half may make it
unnecessary. T-08 is where that gets decided with data instead of opinion, and it is
worth recording either way.

Commits: one per group. Group C is large enough that its proxy and webapp halves are
separate commits in separate repos, which they must be anyway.

---

## P-0 — the dock, and the baseline (prerequisite, no code)

**P-0a — deploy the dock and verify it. DONE (2026-08-27).**
`background-turn-dock` is deployed and its T-10 run and confirmed by the maintainer; that
feature is finished. Nothing further is required here.

**P-0b — record the pre-heartbeat baseline. STILL OPEN, and it gates T-02.**
- **What:** on the now-deployed, dock-carrying build, count how often the recovery path
  fires before the heartbeat exists. `long-turn-resilience` OQ-1 already gives the
  instrument — *"a recovery that fires is a cut that happened"* — so this is counting it
  over a representative window (a week of ordinary use), not building one.
- **Why it is part of P-0 and not part of T-08:** T-08 is the gate that decides whether
  Group C gets built, and it counts the same thing *after* the heartbeat. Without a
  pre-heartbeat number on the same build, T-08 produces one figure and nothing to compare
  it against, and a real gate degrades back into a judgement call. Once T-02 ships, this
  number can never be taken again.
- **Done when:** the count and the window are written here.

**P-0c — correct the drifted deploy tag. Small, and it is an L-007 trap.**
- **What:** `zombie-crab-project-mkt/deploy/dokploy/.env.example:96` still reads
  `CHAT_WEBAPP_TAG=sha-d8f9aa7`, which predates the dock and is no longer what is
  deployed. Set it to the tag actually running.
- **Why it matters:** L-007 — Dokploy runs `docker compose up -d --build` **without**
  `--pull always`, so a deploy that trusts the stale example can put the host back on a
  cached older image, and the symptom is "the fix stopped working". The example file is
  the thing the next person reads.
- **Blocked on:** knowing the real tag; this repo cannot read Dokploy's env.

---

## Group A — the stream is never silent (`crab-shell-proxy`)

### T-01 — serialize the response writers
- **What:** a function-local `sync.Mutex` in `streamTurn`; `writeChunk`, `writeProgress`,
  `writeError` and `done` all take it around their write+flush.
- **Where:** `internal/httpapi/sse.go`.
- **Why before the ticker:** this is a no-op refactor while there is one writer, and it is
  the thing that makes the next task safe. Landing it separately means a `-race` failure
  in T-02 can only be about the ticker.
- **Tests:** existing `sse_progress_test.go` unchanged and green under `-race`.
- **Covers:** FR-5.

**Status: done** — `crab-shell-proxy#34`, `ccb215b`.

Note for anyone reading the design: its literal wording ("all five write sites take
the mutex") **deadlocks**. `done()` calls `writeChunk` and Go mutexes are not
reentrant. Shipped as `emit*` (unlocked bodies) + `write*` (locking wrappers), with
`done()` taking the lock once across both terminal frames — which is also what keeps
a ping from landing between them.

### T-02 — the heartbeat
- **What:** `const heartbeatInterval = 10 * time.Second` beside `turnTimeout`; a ticker
  goroutine started after the initial role chunk flushes, cancelled before `done()`,
  writing `: ping\n\n` under the T-01 mutex, skipped while `clientCtx.Err() != nil`.
- **Where:** `internal/httpapi/sse.go`.
- **Depends on:** T-01.
- **Done when:** the ticker cannot outlive the turn and cannot write after the terminal
  frames — `defer cancel()` alone is not enough; see design "Lifetime".
- **Tests:** design 1, 2, 3, 4.
- **Covers:** FR-1, FR-2, FR-3, FR-4, FR-6.

**Status: done** — `crab-shell-proxy#34`, `ccb215b`.

`stopHeartbeat()` **waits** for the goroutine to exit rather than only cancelling:
signalling without waiting would let a ping be written after `streamTurn` returns, to
a `ResponseWriter` that is no longer valid. The design said "a `context.WithCancel`
derived from `turnCtx`, cancelled by a `defer`, is enough" — it is not.

The cadence seam is an unexported `Server.heartbeatEvery`, a field rather than a
package var for the same reason `turnRegistry.now` is one: the tests run
`t.Parallel()`.

**Two tests were inert on the first pass and are recorded because the pattern
recurs.** The comment-shape test searched for the word "ping", so reshaping the
heartbeat made it fail with "nothing to assert on" — it detected the mutation while
misidentifying it; it now counts data frames instead. And the recorder locked its own
`Write`, which *substitutes* for `writeMu` rather than isolating it (every frame is
one `Write` call), so removing the mutex produced no race and no failure; the
recorder is now deliberately unsynchronized and that mutation reports `DATA RACE`.

**One property is not covered, by construction.** "No ping between `finish_reason`
and `[DONE]`" cannot be provoked from outside: the window is microseconds, and
widening it with a blocking `Write` does not help because the sleep runs while
`writeMu` is held. Removing both guards still passed five runs of five. The guarantee
is structural and visible in `sse.go`; the test is a smoke test over it.

### T-03 — verify a comment frame survives the whole path (operator, OQ-3)
- **What:** with T-02 deployed, watch real long turns from the browser and confirm the
  `: ping` frames arrive — devtools' EventStream pane, or `curl -N` against the BFF route
  with a real session.
- **Done when:** pings are observed on **at least three separate turns of more than 60
  seconds each, from at least two different networks** (one of them mobile). Written out
  because the cheap version of this check is one lucky observation, and a hop that strips
  comments intermittently — or strips them only on one path — is exactly the failure this
  task exists to catch.
- **Why it cannot be a unit test:** the question is whether **mycelium and Traefik** pass
  comment lines through, and neither is in any test harness here.
- **If it fails:** the fallback is a `data:` frame the client discards *before* the
  `lastEventAt` stamp — which costs the webapp change FR-2 exists to avoid, and turns
  Group A into a two-repo release. Record the outcome in `spec.md` OQ-3 either way.
- **Covers:** OQ-3, and closes Group A.

---

## Group B — the BFF stops cutting its own upstream (`crab-exoskeleton-webapp`)

### T-04 — measure before changing anything (OQ-2)
- **What:** the stub-upstream rig from design "Measure first" — SSE headers, one role
  chunk, then silence — and record what ends the BFF's read of the body, and when.
- **Where:** throwaway rig; the finding goes into `spec.md` OQ-2.
- **Done when:** OQ-2 is answered with a number or with "no such bound", **in writing**.
  A measured absence closes FR-7 with no code, and that is a good outcome, not a wasted
  task.

**Status: done** — **300.8s, `UND_ERR_BODY_TIMEOUT`, on Node v24.18.0.** Full output in
`spec.md` OQ-2. undici's default `bodyTimeout` is 300s; the proxy's `turnTimeout` is
600s. For the five minutes between them our own BFF was aborting turns that were still
running upstream.

Rig: `scratchpad/t04-rig.mjs` — a stub upstream sending SSE headers plus a role chunk
and then nothing, read back through the global `fetch`. Deliberately no Next, no auth,
no mycelium: the BFF's own read of `res.body` is the question, everything else is
noise.

### T-05 — remove the bound, if there is one
- **What:** whichever shape T-04 points at (per-call dispatcher, or `node:http` for this
  route). Scoped to the streaming route only; every other `fetchMycelium` caller keeps
  today's behaviour, with a comment saying why they differ.
- **Where:** `app/api/chat/[instance]/route.ts`, `lib/mycelium.ts`.
- **Depends on:** T-04.
- **Skip if:** T-04 found no bound. Say so here rather than deleting the task.
- **Covers:** FR-7, FR-9.

**Status: done** — `crab-exoskeleton-webapp#49`, `567650e`. `lib/mycelium-stream.ts`,
undici's own `fetch` with `Agent{bodyTimeout: 0, headersTimeout: 0}`.

**Both shapes were measured, as design.md asked, rather than picked.** undici's fetch
and `node:http` with `setTimeout(0)` both ran clean at 310s against the silent stub.
undici wins because it returns a standard `Response`, leaving the route's auth and
error paths untouched; `node:http` would have meant rewriting them by hand. Recorded
because a reviewer objecting to the dependency has a validated alternative here.

**It lives in its own module, and that is not tidiness.** Putting it in
`lib/mycelium.ts` first pulled undici into the BROWSER bundle — that file is imported
by 52 files including `"use client"` components (`app/admin/user-models-panel.tsx`) —
and the build failed with a wall of `UnhandledSchemeError: Reading from "node:assert"`.

**And the control run says it is currently belt-and-braces:** the same rig with a 10s
heartbeat ran the full 330s and ended cleanly, so Group A already makes this bound
unreachable. It ships because the heartbeat MASKS the bound rather than removing it —
a cadence change or a proxy predating the heartbeat brings the 300s cut straight back,
silently, five minutes into a turn nobody is watching.

### T-06 — `X-Accel-Buffering: no`
- **What:** one header on the streaming response, beside `Cache-Control`, with a comment
  naming what it guards against.
- **Where:** `app/api/chat/[instance]/route.ts`.
- **Covers:** FR-8.

**Status: done** — `crab-exoskeleton-webapp`, `a0c232b`.

---

## Group D — reacting to the member's actual network (`crab-exoskeleton-webapp`)

Shipped with Group B (spec DEC-7): client-only, small, and the part that most directly
answers the complaint as it was filed.

### T-07 — wake on `online` and `visibilitychange`, and name offline as offline
- **What:** an interruptible sleep in `recover`'s poll loop; module-scope `online` /
  `visibilitychange` listeners that wake every waiter and reset any backoff; the band
  reads `navigator.onLine` and says the device is offline while it is false.
- **Where:** `app/chat/turn-store.ts`, `app/chat/turn-progress.tsx` (or the band arm in
  `chat-view.tsx`), `lib/i18n/chat.ts` — **both locales**.
- **Done when:** `RECOVERY_BUDGET_MS` is unchanged in effect — waking early takes samples
  sooner, it must not extend the wait.
- **Note:** `navigator.onLine` is used only to soften the message when it is definitely
  false, never to conclude the network is fine (it reports a captive portal as online).
- **Tests:** design 17, 18.
- **Covers:** FR-20, FR-21, FR-22, FR-23.

**Status: done** — `crab-exoskeleton-webapp`, `a0c232b`.

The tests live in their own file with an `@vitest-environment jsdom` pragma, and that
is load-bearing rather than tidiness: the listeners register at module scope behind
`typeof window !== "undefined"`, which is **false at import time** under the suite's
default `node` environment. `vi.stubGlobal("window", …)` cannot stand in — it runs
long after the import — so under `node` the wiring would not exist and the tests
would pass against nothing.

Mutation-checked: reverting the poll to the blind `sleep` fails both wake tests.

---

## T-08 — measure, then decide about Group C (gate, no code)

- **What:** with A, B and D in production for long enough to see real long turns, count
  how often the recovery path still fires. `long-turn-resilience` OQ-1 already noted that
  a recovery that fires **is** a cut that happened; that is the counter.
- **Done when:** the finding is written into `spec.md` OQ-1, and Group C is either started
  or stood down with a reason.
- **This is a real gate.** DEC-2 committed to building C; it did not commit to building it
  blind. If cuts have effectively stopped, the honest outcome is to record that and leave
  C specified and unbuilt — which is a better state for this repo than an unmeasured
  re-attach path.

---

## Group C — re-attaching to a live turn

### Proxy (`crab-shell-proxy`)

#### T-09 — the per-turn frame log
- **What:** `turnStreams`, keyed like `turnRegistry` (`memgraph.Scope → sessionID`),
  holding sequenced frames, live subscribers, and terminal state + terminal time. Byte cap
  with front-drop and a `truncated` marker; **60s** retention after the terminal frame
  (FR-11).
- **Where:** `internal/httpapi/` — a new file beside `turn_registry.go`.
- **Reuses:** `scopeOf(key)` and the registry's keying, deliberately, so the two structures
  cannot disagree about what a turn is. Also its `now func() time.Time` field, for the
  same reason: the retention test must not sleep.
- **Decide first:** key by conversation (like the registry) or by turn? Spec OQ-4 — the
  single-turn assumption holds only because the webapp queues, and steering would break it.
  A field and a lookup now; a migration later.
- **Done when:** `append` performs only non-blocking sends and drops a full subscriber
  (FR-14a). If it selects with a timeout, or waits on anything, it is wrong — that is the
  line between "the delivery path changed" and "the turn's execution changed", and the
  spec's Non-goals now name it explicitly.
- **Tests:** design 5, 6, 9, 11.
- **Covers:** FR-10, FR-11, FR-14, FR-14a, FR-17.

#### T-10 — route `streamTurn`'s writers through the log
- **What:** the four writers append+fan-out instead of writing `w` directly; the POST
  handler becomes the first subscriber. `id: <n>` precedes each data frame, in the same
  write. Heartbeats keep writing per-subscriber and never enter the log.
- **Where:** `internal/httpapi/sse.go`.
- **Depends on:** T-02, T-09.
- **Done when:** the existing SSE tests pass **unchanged** — the bytes one subscriber sees
  are the bytes `streamTurn` used to write, plus `id:` lines.
- **Tests:** design 4 (still), 5.
- **Covers:** FR-10, FR-14, FR-6.
- **Blast radius:** this is the largest edit in the feature, and it is the one place the
  spec's Non-goals were deliberately narrowed to permit it. The *delivery* path changes;
  the turn's *production* must not. If this task starts touching `RunTurn`, the picoclaw
  processor, the completion heuristic, `turnCtx`, or the `clientCtx` guards, stop.
  `background-turn-dock` DEC-1's "reads state, does not produce it" does **not** apply
  here — see the amended Non-goal.

#### T-11 — `GET /v1/turns/stream`
- **What:** the re-attach endpoint. Same authorization as its siblings, `Last-Event-ID`
  optional, replay-then-live, distinct refusal below a truncated floor, and a plain fast
  answer when there is no live log. Does **not** call `turns.Begin`.
- **Where:** `internal/httpapi/handlers.go` (registration beside `:284`/`:288`) and a
  handler beside them.
- **Depends on:** T-09, T-10.
- **Tests:** design 7, 8, 9, 10.
- **Covers:** FR-12, FR-13, FR-18.

### Webapp (`crab-exoskeleton-webapp`)

#### T-12 — `consumeStream` learns sequences
- **What:** parse `id:` lines, report the last one seen, accept a starting sequence.
  Additive only; the `data:`-only filter is untouched.
- **Where:** `app/chat/turn-store.ts`.
- **Tests:** design 12, 13. **Test 12 lands here even though Group A needed no webapp
  change** — it is the regression test for DEC-6, and the webapp is where that contract
  can be broken.
- **Covers:** FR-10.

#### T-13 — the re-attach BFF route
- **What:** a streaming GET mirroring `active/route.ts`'s guards and `route.ts`'s body
  passthrough, forwarding `Last-Event-ID`. Inherits T-05's dispatcher decision and T-06's
  header — it is the same kind of stream.
- **Where:** `app/api/chat/[instance]/stream/route.ts`.
- **Depends on:** T-11.
- **Covers:** FR-12.

#### T-14 — try re-attach before polling
- **What:** in `runTurn`, the cut branch tries `reattach(sid, ctx, lastSeq)` within a
  bounded, backing-off budget of roughly 30s (FR-16 — visibly under FR-11's 60s retention,
  so a re-attach cannot lose a race against expiry while still trying), then falls through
  to `recover(sid, ctx)`. A re-attached turn shows the ordinary working band, not the
  recovery line.
- **Where:** `app/chat/turn-store.ts`, and the band arm in `app/chat/chat-view.tsx`.
- **Depends on:** T-12, T-13.
- **Done when:** `recover` itself is **unmodified** and the whole `long-turn-resilience`
  suite still passes untouched (DEC-4 — the poll is the floor and must not be coupled to
  this).
- **Tests:** design 14, 15, 16.
- **Covers:** FR-15, FR-16, FR-19.

#### T-15 — re-attach on reload
- **What:** `resumeIfActive` re-attaches from the start after confirming with
  `/v1/turns/active`, instead of entering `recover()`. Keep the `active` probe — it is the
  cheap question that says whether to re-attach at all.
- **Where:** `app/chat/turn-store.ts`.
- **Depends on:** T-14.
- **Covers:** FR-18.

---

## T-16 — operator verification (the only end-to-end falsifier)

Neither suite can reach these. Record the outcome here.

- A real cut on a real long turn re-attaches and the reply continues, with no error and no
  blanked conversation.
- A reload mid-turn rebuilds the partial reply, not an empty band.
- `visibilitychange` on a genuinely backgrounded mobile tab.
- Whether the heartbeat reduced observed cuts — the T-08 counter, re-read after C.

## Status

**Group A: done** (T-01, T-02) — `crab-shell-proxy#34`. Ships proxy-only, as designed.
**T-03 (operator): not run.** It is what closes Group A.
**Group B: done** (T-04, T-05, T-06) — `crab-exoskeleton-webapp#49`. T-04 found a real
bound and it was ours: **300.8s, `UND_ERR_BODY_TIMEOUT`**, against the proxy's 600s.
**Group D: done** (T-07).
**Group C: not started, and correctly so** — T-08 gates it, and P-0b's baseline has
not been taken.

The one thing that is now urgent and is not code: **P-0b**. Once T-02 reaches
production the pre-heartbeat count can never be taken again, and without it T-08 —
the gate that decides whether Group C is built at all — produces one figure and
nothing to compare it against.

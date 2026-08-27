# turn-stream-continuity — Context

What was established before this feature was written, and where each fact came from.
None of it is re-derived in `spec.md` or `design.md`; it is recorded so nobody has to
re-derive it either.

## 1. Which of the existing answers are actually running

This is the fact that decided the feature's shape, and it is the one most likely to go
stale — re-check it before trusting the rest of this section.

The live deploy pins `CHAT_WEBAPP_TAG=sha-d8f9aa7`
(`zombie-crab-project-mkt/deploy/dokploy/.env.example:96`), which is the merge of
`crab-exoskeleton-webapp#45`. Against that commit, in the webapp submodule:

| Commit | Feature | In `sha-d8f9aa7`? |
|---|---|---|
| `d03aa2a` | recover a cut turn instead of losing it (`long-turn-resilience`) | **yes** |
| `94387cd` | keep the "reply never arrived" banner long enough to read it | **yes** |
| `696722f` | stop a running turn | **yes** |
| `84359df` | a stop that raced the turn's own ending | **yes** |
| `a46df19` | pick a running turn back up after a reload (`resume-turn-after-reload`) | **yes** |
| `06beb19` | keep background turns visible in a dock (`background-turn-dock`) | **no** |
| `c7a8d03` | any file type, paste and drag-and-drop | **no** |

Reproduce with:

```
git -C crab/crab-exoskeleton-webapp merge-base --is-ancestor <commit> d8f9aa7
```

**AMENDED 2026-08-27 — the dock has since been deployed and its T-10 confirmed.** The
table above is the state at the time this feature was specified, and it is kept because it
is what shaped the feature. The current state is: the dock ships, `background-turn-dock` is
finished, and P-0's deploy half is satisfied.

**What survives the amendment — the finding that decided the feature's shape.**
The member filing this complaint was on a build that **already had** transcript-growth
recovery and reload resume. So the complaint was never "recovery was never built"; it is
that recovery is not enough. That is what makes prevention (Group A) the deliverable rather
than a re-implementation, and it is unaffected by the dock landing.

**What the amendment retires.** The second consequence — that part of the complaint might
have been the dock's absence rather than a cut — is no longer a live confound. It is also
why P-0's *baseline* half still matters: the pre-heartbeat count must be taken on the
dock-carrying build, which now exists, so the T-08 gate has something honest to compare
against.

**Stale in this file, deliberately not "fixed":** `deploy/dokploy/.env.example:96` still
reads `CHAT_WEBAPP_TAG=sha-d8f9aa7`, which is *not* the deployed tag any more. The real
value lives in Dokploy's own env, and `.env.example` has drifted from it. That drift is
exactly the shape of `L-007` (`zombie-crab-project-mkt` commit `a6856e4`): Dokploy runs
`docker compose up -d --build` **without** `--pull always`, so a deploy that trusts a stale
example tag can put the host back on a cached older image. **Worth correcting in
`.env.example` to whatever is actually deployed** — it is not corrected here because this
file must not guess at a tag it has not read.

## 2. picoclaw answers in one frame, and that is where the silence comes from

`chat-responsiveness` spec, OQ-1, **answered by measurement** on 2026-07-28 — a temporary
trace in `processor.handle` over two real turns:

```
01:43:55  typing.start
          …51 seconds of complete silence…
```

then the reply, whole, in one `message.create`. The proxy's `internal/pico/turn.go`
processor is built around this: it finalizes only once real content has arrived **and**
typing has stopped, after a 500ms grace window, because picoclaw wraps every outbound
message in its own typing pair.

**Consequence for us:** the turn-store's reveal driver ("typewriter") is a simulation of
streaming, not streaming — `turn-store.ts`'s own header says so. And the SSE between the
proxy and the browser has nothing to carry for those 51 seconds, because there is nothing
to carry.

## 3. The proxy never writes on its own schedule

`internal/httpapi/sse.go`. Every writer — `writeChunk`, `writeProgress`, `writeError` —
is called from a `turn.Sink` callback, i.e. only when picoclaw emits. The one unprompted
write is the initial role chunk, flushed before `EnsureRunning` so a cold start cannot
trip the gateway (design D9). After that the stream is exactly as talkative as the agent.

There is no ticker, no keep-alive, and no `event:` or comment frame anywhere in the file.

**Consequence for us:** Group A is genuinely new behaviour in this file, not a knob.

## 4. All writes today happen on one goroutine

Same file. `streamTurn` runs on the request goroutine; `RunTurn` is called synchronously
from it and invokes the sinks inline. So the `http.ResponseWriter` has exactly one writer
and needs no lock — which is why there isn't one.

**Consequence for us:** FR-5. A heartbeat ticker is a second goroutine writing the same
`ResponseWriter`, and adding it without serializing is a data race, not a style question.

## 5. The turn survives the client; the view does not

`sse.go:109-117` (as cited by `long-turn-resilience/context.md`) runs the turn on
`context.WithTimeout(context.Background(), turnTimeout)` — deliberately **not**
`r.Context()` — with `turnTimeout = 10 * time.Minute`. The client context only decides
whether to keep *writing*; every sink early-returns on `clientCtx.Err() != nil` while the
turn keeps draining.

The comment there names the bug that made it this way: tying the turn to the request
cancelled the picoclaw WebSocket mid-turn on disconnect, and picoclaw persisted a
truncated transcript.

**Consequence for us:** this is what makes Group C possible at all. There is a live turn
to re-attach *to*, for up to ten minutes after the socket died.

## 6. `x_crab_error` and `x_crab_progress` set the extension convention

Both ride as an extra **top-level** field on an otherwise-normal chunk with an **empty
delta**, and `sse.go` explains why in a comment: a client that knows nothing about them
reads `choices[0].delta.content`, finds nothing, and skips the frame. A named SSE event
(`event: progress`) would instead be *dropped wholesale* by `data:`-only parsers.

**Consequence for us:** DEC-3 deliberately does *not* follow this convention for the
sequence number, and the difference is the point — `id:` is not an extension being
smuggled through a payload, it is the SSE field designed for this, and the frames it
labels are unchanged.

## 7. `lastEventAt` is load-bearing for two separate readouts

`background-turn-dock` DEC-12, verbatim on the intent: the band's "quiet for" and the
dock's chip both derive from `lastEventAt`, so *"a chip and the band it corresponds to can
never disagree"*. It is stamped in `runTurn`'s `onDelta` and `onProgress` callbacks
(`turn-store.ts`), and nowhere else.

`long-turn-resilience` FR-12 is what it serves: *"After the existing silence grace window,
the band shows how long the turn has been running. A number that visibly advances is the
strongest available signal that the chat is not stuck."*

**Consequence for us:** FR-2 / DEC-6. A heartbeat that stamps `lastEventAt` pins that
number at zero and silently deletes the feature. The comment-frame shape avoids it *by
construction*, because `consumeStream` filters non-`data:` lines before any callback runs.

## 8. The BFF is a byte pipe, with one unexamined default

`app/api/chat/[instance]/route.ts` POSTs to mycelium through `fetchMycelium` and then
returns `new Response(res.body)` — the upstream SSE bytes, unmodified. It sets
`Content-Type`, `Cache-Control: no-cache` and `Connection: keep-alive`.

`fetchMycelium` (`lib/mycelium.ts:79`) is `await fetch(url, init)` with no dispatcher and
no options beyond what the caller passes. The runtime is `node:24-alpine`
(webapp `Dockerfile`), Next `^15.5.21`, and `undici` is **not** a direct dependency.

**Consequence for us:** whatever inactivity behaviour the runtime's default HTTP client
has, the streaming route inherits it — including on a body that is legitimately silent for
minutes. This spec does **not** assert what that default is (OQ-2); T-04 measures it. The
same call is used by every other route, where an inactivity bound is a *feature*, which is
FR-9.

## 9. The edge, as far as it is known

`zombie-crab-project-mkt/deploy/dokploy/docker-compose.yaml`: Traefik fronts the webapp
(`traefik.http.services.zombie-chat.loadbalancer.server.port=3000`) and the landing.
`crab-shell-proxy` is deliberately **not** behind Traefik — *"quem publica os agentes é o
mycelium"* — so the browser's path is:

```
browser → Traefik → Next BFF (3000) → mycelium-gateway (8080) → crab-shell-proxy
```

No idle/read/write timeout is configured on any of these in the compose file. That is not
the same as there being none: Traefik, the Go server, mycelium's client and the browser
all have defaults, and the member's own network has no defaults at all. Group A is written
to be indifferent to which one bites.

## 10. Where the pieces already are

**Proxy (`crab-shell-proxy`)**
- `internal/httpapi/sse.go` — `streamTurn`, all four writers, `done()`, `turnTimeout`.
- `internal/httpapi/turn_registry.go` — `Begin`/`Active`/`List`/`Current`, keyed
  `memgraph.Scope → sessionID → {count, since}`. Registered at `handlers.go:657`,
  `defer s.turns.Begin(scopeOf(key), req.SessionID)()`, before either branch.
- `internal/httpapi/handlers.go:284,288` — `GET /v1/turns/active`, `GET /v1/turns/running`.
  The pattern a re-attach route follows.
- `internal/pico/turn.go` — the picoclaw WebSocket and the completion state machine.
  **Group C does not touch it.**

**Webapp (`crab-exoskeleton-webapp`)**
- `app/chat/turn-store.ts` — module-scope state, the send ladder, the queue, the reveal
  driver, `consumeStream`, `recover`, `resumeIfActive`, `RECOVERY_POLL_MS`,
  `RECOVERY_BUDGET_MS`.
- `app/chat/fragment.ts:252` — `historyQuery(workspace, sessionId, project)`, the query
  builder `recover` already reuses.
- `app/api/chat/[instance]/{route,active,running,history,cancel}.ts` — the BFF surface; a
  re-attach route joins it.
- `app/chat/turn-progress.tsx` — the pre-reply band, `SILENCE_GRACE_MS`, `useElapsed`.
- `lib/i18n/chat.ts`, `lib/i18n/errors.ts` — both locales, with a parity test.

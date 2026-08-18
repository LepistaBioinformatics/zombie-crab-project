# resume-turn-after-reload — Spec

**Status:** Implemented on both sides — verified 2026-08-18 while speccing
`background-turn-dock`: `handlers.go:284` + `handleTurnsActive`, `turn_registry.go:113`
(`Active`), `app/api/chat/[instance]/active/route.ts`, and `chat-view.tsx:424`
(`resumeIfActive`). This header read "Specified. Not implemented." long after the fact.
**Spans:** `crab-shell-proxy` (new endpoint) + `crab-exoskeleton-webapp` (resume on mount).
**Date:** 2026-08-13.

## Problem

Reloading the page during a running turn loses the view of it. The reply is
never lost — the proxy detaches the turn from the request and picoclaw persists
it — but the chat stops representing work that is still happening, and the reply
only appears if the member reloads *again*, later, by guesswork.

## Why `long-turn-resilience` does not already cover this

`crab-exoskeleton-webapp#38` recovers a **cut stream while the page stays open**:
`runTurn` notices the stream ended with no terminal marker and polls the
transcript. Its state lives in `turn-store.ts`'s module-level `Map`s, which a
reload wipes, and its spec lists surviving a reload as an explicit non-goal.

So the polling machinery already exists and is reused wholesale. The only thing
missing is a way to know, **on mount**, that a turn is in flight.

## Decision — the proxy is the source of truth (DEC-1)

`crab-shell-proxy` already tracks in-flight turns: `turnRegistry` keys
`scope -> sessionID -> count`, registered at `handlers.go:613` — deliberately
*"after authorization, before either the streaming or the synchronous branch — so
one registration covers both"*, with `streamTurn` called ten lines later. The
data exists; it is simply not exposed.

Alternatives considered and rejected by the maintainer: a `localStorage` marker
written at send time (webapp-only, but same-browser only), and inferring from the
transcript (stateless, but cannot tell "in flight" from "failed and abandoned").
The server-authoritative option was chosen for working across tabs and devices
and for carrying no client state that can go stale.

## Requirements

### Proxy

- **FR-1** `GET /v1/turns/active` answers whether a turn is running for one
  conversation, under the same auth and agent resolution as the other `/v1`
  routes.
- **FR-2** It matches on the **RAW** `session_id`, which is what `Begin` records
  and what the webapp navigates by — *not* the `sessionKey` hash that
  `handleSessionsHistory` works from. Following the history handler's pattern
  here would compare the wrong string and never match.
- **FR-3 — It takes NO `project` parameter, and that is deliberate.**
  *(Corrected during implementation; the first draft of this requirement said the
  opposite.)* The reflex from the recurring `project`-drops-by-layer defect is to
  thread `project` through every layer, but here it would be dead weight that
  reads like a guarantee. `scopeOf(key)` carries tenant/subs/role/user and **not**
  the workspace segment, so a project chat registers under exactly the same scope
  as a main one — verified at `handlers.go:581`, where the key passed to
  `Begin` is built before any project resolution. Conversations are told apart by
  session id alone.
- **FR-4** A new `turnRegistry.Active(scope, sessionID) bool` accessor (count >
  0). It must **not** route through `Current`, whose "exactly one in flight" rule
  exists for MCP attribution and would answer false for two concurrent
  conversations on one workspace.
- **FR-5** The response carries no turn content. The member's own message stays
  visible in the transcript across a reload (confirmed by observation), so
  nothing needs restoring — the shape stays `{active, since}` so content could be
  added later without breaking it.

### Webapp

- **FR-6** On mounting a conversation with no running turn in the store, the app
  asks whether one is in flight and, if so, resumes tracking it.
- **FR-7 — Read the transcript baseline BEFORE asking whether a turn is active.**
  This ordering is load-bearing and inverts the obvious one. `recover()` waits for
  the transcript to *grow* past a baseline it reads when it starts; the resume
  path adds a round-trip before that read, so a turn that completes during the
  round-trip would be baselined with its reply already present, never grow, and
  report `turn_lost` after eleven minutes — a success shown as a failure.
  Baseline first: then `active:false` means "already landed, just render", and
  `active:true` means the baseline predates the reply.
- **FR-8 — Resume must reproduce `runTurn`'s envelope, not call `recover()`
  bare.** `recover()`'s own comment records why it sits inside `runTurn`'s `try`,
  before its `finally`: that is what holds `running` true and `arrivalDone` false
  for the whole wait, so `finishIfDrained` cannot end the turn early and the
  completion painter cannot reload a transcript that lacks the reply and then let
  `clearCompleted` drop the bands — the blanked-conversation defect recorded in
  `chat-view.tsx`. A resume entry point must establish the same invariants and
  unwind them the same way.
- **FR-9** A resumed turn reuses the existing UI. It is a recovery: `TurnRecovery`
  already says the connection dropped and the agent is still working, which is
  exactly true here.
- **FR-10** The resume decision is a **pure function** of `{active, baseline,
  ...}` so it can be tested. The suite runs `environment: "node"` where effects
  never fire, so the mount `useEffect` that calls it cannot be covered — the test
  file must say so rather than let the coverage be inferred.

## Non-goals

- **Never re-POST the turn.** Unchanged from `long-turn-resilience`: once the
  stream opened, the turn is committed server-side.
- No cancel control for a resumed wait.
- Not persisting anything client-side. That was the rejected alternative.

## Known limitations (accepted)

- **LIM-1 — A proxy restart clears the registry.** picoclaw keeps working and
  persists the reply, but `active` answers false and the member sees it only on a
  later reload. Accepted by the maintainer: proxy restarts mid-turn are rare and
  no data is lost. A heuristic fallback was offered and declined, to avoid
  reintroducing the "failed vs in flight" false positive.
- **LIM-2 — Bounded by the same 11-minute recovery budget** as `#38`, which sits
  just past the proxy's 10-minute total turn bound.

## Decisions taken during implementation

- **DEC-2 — The probe fires on every conversation open, not only after a reload,
  and is deliberately NOT filtered.** The obvious filter — "only probe when the
  transcript's last message is the member's" — was considered and rejected:
  narration ("step") rows land in the transcript during a turn, so the last row
  mid-turn is not reliably the user's, and the filter would silently disable the
  feature exactly when it is needed. One cheap GET per conversation open is the
  accepted cost. Revisit only with evidence about what actually lands mid-turn.
- **DEC-3 — `fetchActive` builds its own query instead of reusing
  `historyQuery`.** That helper also sends `project`, which this endpoint does not
  read (FR-3); putting it on the wire would read as a guarantee nobody makes.
- **DEC-4 — The resume honours the caller's cancellation flag.** Found in review,
  not by the gates: without it, switching conversations during the `/active`
  round-trip left a phantom running turn on a chat nobody was watching, whose
  eventual `finishIfDrained` fired the painter for a `sid` `activeSidRef` no
  longer matched — the blanked-conversation family. `cancelled` is re-checked
  *after* the probe, which is when the switch actually happens.

## Correction owed to a neighbouring doc

`long-turn-resilience/context.md` states the transcript is *"frozen for the whole
duration of a turn and then grows by the whole turn at once."* Direct observation
contradicts it: the member's own message stays visible across a reload mid-turn,
so it is already in the transcript. `recover()`'s growth probe still works — the
baseline simply includes the user message and growth still means the reply landed
— but the stated rationale is wrong and now load-bearing for two features. Worth
fixing there.

## Open questions

- **OQ-1** Does `scopeOf(key)` need the project segment resolved the same way
  `handleSessionsHistory` does it (`workspaceSegmentFor`), or is the simpler
  `checkProject` path enough for a read-only probe? Settle while implementing.
- **OQ-2** Should the endpoint be rate-limited? It is called once per mount, but
  a reload loop would poll it. Probably not worth it; note if it proves wrong.

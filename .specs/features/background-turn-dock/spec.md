# background-turn-dock — Spec

**Status:** **FINISHED.** Implemented 2026-08-18 (T-01..T-09); T-10, the operator
verification against a live stack, run and confirmed by the maintainer 2026-08-27. The
feature is deployed. Four non-blocking improvements are listed at the end of `tasks.md`.
One deviation, recorded in `tasks.md`: the mobile dock sits BELOW the composer, not above
it (DEC-11 / FR-U8), because the composer lives inside the component the dock must
outlive. FR-U1a amends the segment styling after first use (lane colours from the tree).
**Spans:** `crab-shell-proxy` (one new read endpoint) + `crab-exoskeleton-webapp` (store
selector, restore path, dock UI).
**Date:** 2026-08-18.
**Successor to:** `resume-turn-after-reload` (project-level), `long-turn-resilience`
(webapp). Read both before this one — most of the machinery this feature needs already
exists and this spec is largely a read-out over it.

## Problem

A member sends a message, leaves for another conversation, and loses every signal about
the work they started. To find out whether it landed they navigate back and guess, or
reload and guess again.

**The turn itself is not at risk, and that framing must not survive into the design.**
The original request behind this feature assumed the client disconnects from the backend
on navigation and the reply is lost. It is not:

- `turn-store.ts` lives at module scope *for exactly this reason*. Its header comment
  names "a reply that arrived after you navigated away was lost" among the three
  symptoms it was written to fix, and `parkFlush` exists so a debounce burst survives a
  chat switch.
- `long-turn-resilience` FR-10 is explicit: recovery runs in the module-scope store, so
  "switching conversation or workspace mid-recovery does not abandon it".
- The proxy runs turns on a background context precisely so a disconnected client cannot
  cut them, and picoclaw persists the reply either way.
- `resume-turn-after-reload` is **already implemented end to end** — `handlers.go:284`
  (`GET /v1/turns/active`), `turn_registry.go:113` (`Active`),
  `app/api/chat/[instance]/active/route.ts`, `chat-view.tsx:424` (`resumeIfActive`) —
  despite its own spec still reading "Not implemented". A reload already re-attaches to
  a running turn, **for the one conversation the member opens**.

So what is missing is **visibility, not persistence**. Two concrete gaps:

1. **In-session:** nothing enumerates the store. There is `useTurn(sid)` and nothing
   that answers "what else is running right now?". The state is all there and unread.
2. **Across a reload:** `resumeIfActive` resumes the conversation you *mount*. A member
   who reloads with three turns in flight re-attaches to at most one, and the other two
   become invisible again until visited by hand.

## Goals

- Work the member started stays visible, wherever they navigate, without polling the
  screen by hand.
- A reply that lands while they are elsewhere announces itself.
- A full page reload restores that view, not just the open conversation's.

## Non-goals

- **No change to how turns execute.** No re-POST, no second stream, no keep-alive, no
  change to `runTurn`/`recover`/`consumeStream`. This feature reads state; it does not
  produce it.
- **No `stopTurn` from the dock.** See DEC-7 — it is a data problem, not a scope cut.
- No OS notifications, service-worker background sync, or tab-title badging. The PWA
  work (`pwa-installability`) is unrelated and stays that way. See OQ-1.
- No new persistence in the webapp. Nothing is written to `localStorage`; the server is
  the source of truth across a reload, as `resume-turn-after-reload` DEC-1 already
  settled for the single-conversation case.
- Not making a *failed* turn survive a page reload. That remains
  `turn-failure-visible`'s limitation: picoclaw does not persist errors, so a reload has
  nothing to restore a failure from. The dock inherits the limitation, it does not fix it.

## Decisions

### DEC-1 — Nothing about turn execution changes; the store is already the engine

Every requirement below is either a selector over `turns`/`contexts`, a component, or one
read endpoint. If an implementation task starts editing `runTurn`, `recover`,
`consumeStream`, or the retry ladder, the task is wrong.

### DEC-2 — Reload survival is in scope, and it is the only expensive part (user-directed)

Asked directly whether the dock must survive F5, the maintainer chose **yes**. That is
what pulls `crab-shell-proxy` into the feature: `/v1/turns/active` takes exactly one
`session_id`, so it can confirm a conversation but cannot discover one.

Cost accepted knowingly: a second submodule, and a fan-out of one probe per workspace on
shell mount.

### DEC-3 — A new route, not an optional `session_id` on `/v1/turns/active`

Making `session_id` optional would keep one route at the price of two response shapes
behind one path, and would turn a required-parameter 400 into a silent mode switch — a
typo'd parameter name would stop asking about a conversation and start listing the whole
scope, with a 200. `GET /v1/turns/running` is a separate question with a separate answer.
`/v1/turns/active` is untouched, and its single-conversation contract keeps working for
`resumeIfActive`.

### DEC-4 — The registry learns a start time

`turnRegistry` today stores counts only. A restored chip has no local start time — the
tab that sent the message is gone — so without a server-side timestamp the elapsed
readout `long-turn-resilience` FR-12 established would restart from zero at every reload,
which is the exact lie that requirement was written to remove.

Verified, and it is worse than "no start time": `resumeIfActive` enters `recover()`, which
patches `recoveringSince: Date.now()` (`turn-store.ts:549`). A restored entry that read its
clock from the store would therefore not merely lack a duration — it would confidently
display a fresh one. The server's `since` is the only honest source for a restored chip.

The timestamp is **first-seen, not last-seen**: `Begin` is re-entrant by design (a retry,
or a `resolve` alongside a turn, increments the same key), and resetting on the second
`Begin` would make a nine-minute turn report as fresh.

### DEC-12 — Two clocks, both already honest; no new store field

`TurnState` has **no turn-start field**, and DEC-1 forbids adding one in `runTurn`. It does
not need one, because `long-turn-resilience` FR-12's readout was never a total duration:
`TurnProgress` measures *time since the last event* from `lastEventAt`
(`turn-progress.tsx`, `useElapsed(lastEventAt)`), and `TurnRecovery` measures the recovery
wait from `recoveringSince`. The dock reuses exactly those two:

- **In-session** — quiet-for, from `lastEventAt`, the same number the band shows. A chip
  and the band it corresponds to can never disagree.
- **Restored** — total duration, from the server's `since` (DEC-4). `lastEventAt` is `0`
  for a resumed turn (only `runTurn:603` and `consumeStream` ever write it), so there is
  nothing else to read.

The two mean different things, so the copy differs (FR-U4). Reusing `formatElapsed` and
`useElapsed` from `turn-progress.tsx` — the latter needs exporting, which is not a DEC-1
violation: DEC-1 protects turn *execution*, not a presentational helper.

### DEC-13 — A parked, unsent burst is docked, as its own state

`parkFlush` (`turn-store.ts:286`) clears the debounce timer and nothing else, and the only
thing that re-arms it is `bumpFlush` on typing. So a member who hits send and navigates
away inside `SEND_DEBOUNCE_MS` leaves a message in `pending` that **will not be POSTed
until they come back and type again**. That is the most valuable chip this feature can
show, and it is emphatically not "working" — the agent has not been asked anything yet. It
gets its own state rather than being folded into the others or filtered out.

### DEC-5 — Only conversations the member left appear

The open conversation renders its own bands; docking it too would put the same state on
screen twice and make the dock's meaning ("work that is elsewhere") negotiable. This is a
caller-side exclusion — the store selector stays honest and returns everything active, and
the dock filters by the current fragment `sid`.

### DEC-6 — A finished chip waits to be opened

A landed reply holds its chip in a terminal "ready" state until the member opens the
conversation. Auto-dismissal would delete the only notification the feature produces, for
the case it exists to serve: the member was distracted.

The retirement trigger falls out of existing code rather than needing new plumbing —
`chat-view.tsx:411` already calls `clearCompleted(sessionId)` when a conversation mounts,
which blanks the bands. See DEC-9 for the one case that does not cover.

### DEC-7 — No stop control on a chip, and the reason is `stopTurn`'s return value

`stopTurn(sid)` returns the text that will never be answered, because picoclaw's abort
rolls session history back past the member's own message and dropping it would mean Stop
silently destroys what they typed. From the dock there is no composer for that
conversation to put the text back into, and holding it in memory for a conversation the
member may never reopen re-creates the loss the return value exists to prevent. Stop
stays where the composer is.

### DEC-8 — The activity predicate is a field test, never Map membership

`turns` is **never pruned**: `clearCompleted` blanks fields and leaves the entry, and
nothing deletes. `turns.keys()` is therefore a list of every conversation touched this
page-load, not a list of live ones. A dock built on membership fills with corpses.

### DEC-9 — No second painter; the dock observes the store

`setPainter` is a documented single global slot, registered by the mounted `ChatView`,
and it early-returns when `activeSidRef.current !== sid`. A background completion already
no-ops safely there and is picked up from the store by the next mount. Registering a
parallel hook would fight that guard and race the history reload. The dock subscribes
like any other reader.

Consequence to handle explicitly: because `clearCompleted` *deliberately preserves*
`error`/`errorDetail` — that banner is a harness failure's only surviving trace — a failed
chip is not retired by opening the conversation. The dock therefore keeps its own
acknowledged-sid set (see FR-S5); it must **not** clear `error`, which would delete
`turn-failure-visible`'s banner before the member reads it.

### DEC-10 — The label is joined, not stored

The store holds `progress`, `lastEventAt`, `activeUserMessage`, and `contexts`
(workspace + project). It does not know a conversation's alias or title — those live in
`lib/chatSession`'s `ConversationSummary`, which already carries
`id/role/tenantId/subsAccId/title/alias/project`: everything a chip needs. The dock joins
against that list. Teaching the turn store about display names would give it a second
source of truth for conversation metadata and a staleness problem on rename.

### DEC-11 — Mobile gets a compact strip, not the desktop bar (user-directed)

A fixed full-bleed bottom bar lands exactly where the composer and the soft keyboard
live. On mobile the dock is a thin chip strip anchored above the composer, with no
message preview, hidden while the virtual keyboard is open. Desktop-only was considered
and rejected: mobile is where a member is most likely to leave a turn running.

## Requirements

### Group P — proxy: discovering in-flight turns

**FR-P1** `GET /v1/turns/running` answers which conversations have a turn in flight for
the caller's scope, under the same auth and agent resolution as `/v1/turns/active`.

**FR-P2** It reproduces `handleTurnsActive`'s guards exactly: `resolveAgent`, the
`identity.ProfileHeader` resolve, `tenant_id` and `subs_acc_id` required and parsed as
UUIDs, and the account-switching guard (`ident.Profile.AccID == subsAccID` → 403).
Divergence here would make one of two sibling routes enforce less than the other.

**FR-P3** It takes **no** `session_id` and **no** `project`. The scope
(`scopeOf(key)`) carries tenant/subs/role/user and not the workspace segment, so project
conversations are already in the answer, told apart by session id — the same reasoning
`resume-turn-after-reload` FR-3 records.

**FR-P4** The session ids returned are the **RAW** ids `Begin` recorded, not
`identity.SessionKey` hashes. This is the defect `handleTurnsActive`'s comment warns about
for anyone copying from `handleSessionsHistory`; a listing route that hashed would return
ids the webapp cannot navigate to.

**FR-P5** A new `turnRegistry.List(scope)` accessor returns every session with count > 0.
It must **not** route through `Current`, whose "exactly one in flight" rule exists for
memory-graph attribution and would return nothing in precisely the multi-conversation case
this feature is about.

**FR-P6** The registry records a first-seen timestamp per session (DEC-4). A re-entrant
`Begin` on a session already present does not reset it. The timestamp is dropped when the
count reaches zero, with the entry.

**FR-P7** The handler has no container side effects. It resolves config and reads memory;
it must not provision, wake, or health-wait a workspace. A dock restore fans out across
every workspace a member has, and a provisioning read would turn a page reload into a
fleet start.

**FR-P8** The response is `{"turns": [{"session_id": ..., "since": ...}]}`, with an empty
array — never `null` — when nothing is running. `since` is an RFC 3339 timestamp.

**FR-P9** Existing behaviour of `/v1/turns/active`, `turnRegistry.Active`, and
`turnRegistry.Current` is unchanged, and their tests still pass untouched.

### Group S — webapp store: enumerating turns

**FR-S1** A `useActiveTurns()` selector over the existing `subscribe`/`emit` returns every
conversation with live turn state, as `{ sid, state, ctx }`. It reuses
`useSyncExternalStore` and the existing listener set; no second subscription mechanism.

**FR-S2** Membership is decided by a field predicate, never by `turns` membership
(DEC-8), and **every docked entry must map to exactly one of FR-U5's states** — a predicate
that admits an entry the dock cannot label is a bug, not a spare case. The mapping is:

| Docked because | State (FR-U5) |
|---|---|
| `pending.length > 0` and not `running` | *unsent* (DEC-13) |
| `running`, or `retrying !== null`, or `queue.length > 0`, or `settling`, or `stopping` | *working* |
| `recovering` | *reconnecting* |
| `error !== null` | *failed* |
| not `running` and `revealed`/`activeUserMessage` non-empty | *ready* |

Precedence runs bottom-up for the ambiguous overlaps: `error` outranks *ready*,
`recovering` outranks *working* (`running` stays true throughout a recovery by
`long-turn-resilience` FR-4), and *working* outranks *unsent* (a burst can be queued behind
a running turn).

**FR-S3** Snapshot stability. `useSyncExternalStore` re-renders on reference change, and
`emit()` fires on every reveal tick. The selector must return a referentially stable
array while the docked set and each entry's rendered fields are unchanged, or the dock
re-renders ~60 times per reply.

**FR-S4** The current conversation's exclusion is the dock's, not the selector's (DEC-5).

**FR-S5** A module-scope acknowledged-sid set retires terminal chips: a sid is
acknowledged when the member navigates to it, and un-acknowledged when a turn starts
running on it again. It must not mutate `error`/`errorDetail` (DEC-9).

**FR-S6** No new painter, hook slot, or global callback (DEC-9).

### Group R — webapp: restoring the dock after a reload

**FR-R1** On shell mount, once the workspace list the sidebar already loads is known, the
app probes `/v1/turns/running` once per workspace, in parallel, and unions the results.

**FR-R2** Each discovered session id is joined against `listConversations(workspace)` to
produce a label and the conversation's `project`, and from that a `RunContext`
(`workspace` + `project` + `onUnauthorized`) equivalent to the one submit time would have
captured. A session id with no matching conversation record is **skipped**, not docked
with a placeholder label — it is a conversation this client cannot navigate to.

**FR-R3 — Restoration must NOT short-circuit `resumeIfActive`'s own `/active` probe, and
this is the load-bearing requirement of the group.** The obvious optimisation is to pass
`active: () => true` since the listing just said so. That inverts the ordering
`resume-turn-after-reload` FR-7 established: the listing probe happens *before* the
transcript baseline read, so a turn landing in between would be baselined with its own
reply already counted, never grow, and report `turn_lost` after eleven minutes — a
success displayed as a failure. The listing is **candidate discovery only**; each
candidate then goes through `resumeIfActive` unchanged, which reads its baseline first and
re-probes `/active` after.

**FR-R4** Restoration runs at most once per page load and is idempotent. `resumeIfActive`
already refuses a conversation with a live turn in the store, so a second pass cannot
double-recover, but the fan-out itself must not repeat on every re-render or workspace
refresh.

**FR-R5** A restored entry's elapsed readout comes from the server's `since` (DEC-4), not
from the moment of restoration.

**FR-R6** A failed or unreachable probe is not "nothing is running". It docks nothing and
surfaces no error: the member is no worse off than today, and a connectivity banner for a
background convenience would be noise. This mirrors `fetchActive`'s existing `catch`.

**FR-R7** A restored turn is per-user server state, so a member who reloads on a
different device sees the same dock. This is a consequence of DEC-2, not an extra
requirement — but it must not be broken by caching the fan-out per browser.

### Group U — the dock

**FR-U1** A full-bleed bar pinned to the bottom of the chat area in the project's accent
blue (`--accent` / `--accent-soft`, the infra cyan; `--brand` is the violet and is not
this). It is absent — not empty, and reserving no layout height — when nothing is docked.

**FR-U2** The bar divides into equal segments as conversations are added, each segment one
conversation.

**FR-U3** Segments are capped, with the remainder behind a `+N` control that opens the
full list. Splitting without a floor makes every segment unreadable at four or five
entries, which is a realistic count for this feature's own audience. Cap: **4** on
desktop, **3** on mobile. **Oldest first** — matching `List`'s server-side sort (FR-P5), so
the segments do not reshuffle between a probe and a store update, and the entry most at
risk of being forgotten is the one that stays visible.

**FR-U3a — Amended twice, 2026-08-18. Mobile does not divide the bar at all.**

| | up to 4 | past 4 |
|---|---|---|
| desktop | `fit` — segments divide the bar | `overflow` — extras behind `+N` |
| mobile | `collapsed` — ONE box, at every count | `collapsed` |

Two earlier attempts both divided the phone-width bar — first capping at three segments with a
`+N`, then scrolling a strip of them sideways — and both produced the same reported symptom: the
title, state, qualifier and alias each got a fraction of the width and truncated into each other.
The problem was never how many segments fit; it was that a phone has no room for even one
segmented row.

So mobile shows a single box carrying the conversation count and `summaryState` — the one state
worth reporting for the whole list, ranked `failed > ready > reconnecting > unsent > working`.
`ready` has to be in that ranking: the collapsed box is the only thing a mobile member sees, so a
box that cannot say a reply landed has lost the notification this feature exists to deliver. The
box's rail takes the colour of the conversation it is reporting on, so tapping through lands on
the row it was talking about.

Tapping expands the list **upward** — the same panel `+N` opens on desktop — with one full-width
row per conversation. That is the point of collapsing: a row gets the whole width for its lines
instead of a quarter of it.

Mobile collapses at ONE conversation too, not only past a threshold. Predictable beats clever:
the bar does not change shape as work accumulates.

**FR-U4a — Amended 2026-08-18: one line per kind of text, not one row.** The chip's texts are
stacked in a column. Packed into a row — title, a separator, the state, then the qualifier — four
independent strings competed for one segment's width and truncated into each other, which reads
as scrambled rather than as abbreviated. In a column each gets the segment's full width and
truncates on its own terms.

The state and its elapsed time share a line deliberately: they are one fact ("what it is doing,
and for how long"), both short, and splitting them would add a line that says nothing new. Order:
title, state + elapsed, qualifier, alias.

**FR-U4** Each segment shows: the conversation's label (`alias ?? title`), its state, and
an elapsed readout. When the conversation belongs to a different workspace or project than
the one on screen, that is named too — a bare chat title is ambiguous across agents.

The readout has **two distinct meanings** (DEC-12) and the copy must say which: in-session
it is time-since-last-event from `lastEventAt`, shown only past `SILENCE_GRACE_MS` as
`TurnProgress` does; for a restored entry it is total duration from the server's `since`,
shown immediately. An *unsent* chip has no clock — it is not waiting on anything.

**FR-U5** Five visually distinct states, mapped to store fields already in `TurnState`
per FR-S2's table: *unsent*, *working*, *reconnecting*, *ready*, *failed*. `errorDetail`,
when present, is the harness's own sentence and is never translated. *unsent* must not
borrow *working*'s visual language: nothing is running, and the action it implies is the
member's.

**FR-U6** Clicking a segment navigates to that conversation — setting the fragment's
workspace, project, and `sid` together, since a docked entry may live in a workspace the
shell is not currently on — and retires the chip (FR-S5).

**FR-U7** All motion is neutralized under `prefers-reduced-motion`, through the guard
`globals.css` already applies. The elapsed counter is not motion and stays, as
`long-turn-resilience` FR-13 settled.

**FR-U8** Mobile is the compact strip of DEC-11: above the composer, no preview text,
hidden while the virtual keyboard is open (the shell already tracks this — see
`mobile-keyboard-viewport.test.ts`).

**FR-U9** The dock's own bar does not overlap the composer or `RestartBanner`, at any
breakpoint, with either sidebar open or collapsed. Stacking order is stated once, in one place,
not discovered per component.

**FR-U9a — Amended 2026-08-18. The expanded PANEL does overlap the composer, and must paint
above it.** The two are different claims and conflating them shipped a bug: the bar sits in
normal flow below the composer and never overlaps it, but the panel opens *upward* into exactly
the band where `ChatView`'s composer floats at `z-20`. Document order does not settle that — the
composer carries an explicit z-index and the dock container carried none, so `auto` lost and the
expanded list rendered **behind the message box**. On mobile that is fatal rather than ugly: the
list is the only way to reach a docked conversation there.

The dock container is `z-30`. Asserted **across both files** in
`turn-dock-layout.test.ts` — comparing the dock's layer to the composer's, rather than checking
the dock for a literal `z-30` — so raising the composer's layer later fails the test instead of
silently re-burying the list.

**FR-U9b — The mobile control is a 44px touch target.** It inherited `py-2 text-xs` from the
desktop chips and came out around 32px, which was reported as hard to hit. `min-h-11` matches the
`h-11` this codebase already uses for touch targets. It is the only control on the mobile bar, so
it can afford the height — and if it is hard to hit, every background conversation is unreachable
on that breakpoint.

**FR-U10** Both locales, no exceptions — every string through `lib/i18n/chat.ts`'s `en`
and `pt` dicts, per `long-turn-resilience` FR-14.

## Verification

- Proxy: `go build ./... && go vet ./...`; new `turnRegistry` tests for `List`,
  first-seen-not-reset, and drop-at-zero; a handler test alongside
  `handlers_test.go:1346` covering 200 with entries, 200 with `[]`, 400 on a missing
  tenant, 403 on the account-switch guard, and 401 without the profile header.
- Webapp: `next build`, `tsc`, `vitest`. Unit tests for the activity predicate (including
  a post-`clearCompleted` entry NOT being docked), snapshot stability across a reveal
  tick, the acknowledged-set lifecycle, and the restore path's ordering — specifically a
  test that fails if `resumeIfActive`'s `/active` probe is skipped.
- Operator-gated, and it is the only check that can actually falsify the feature: send in
  three conversations across two workspaces, navigate away, confirm three segments;
  reload mid-flight and confirm all three come back with correct elapsed times; let one
  fail and confirm the chip reads failed and the banner still appears on open.

## Open questions

- **OQ-1** Should a landing background reply also badge the tab title or favicon? Cheap,
  and the strongest signal for a member on another tab entirely — but it is a different
  surface with its own permission and PWA questions. Deferred, not rejected.
- **OQ-2** At how many workspaces does the FR-R1 fan-out need a cap or a
  recently-used ordering? Each probe is an in-memory registry read with no container
  side effect (FR-P7), so the ceiling is HTTP overhead rather than cost per call. Measure
  before capping.
- **OQ-3** `turns` is never pruned (DEC-8) and this feature makes that observable for the
  first time. Should acknowledged terminal entries be deleted rather than left blank?
  Out of scope here; worth its own decision.

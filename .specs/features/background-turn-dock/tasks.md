# background-turn-dock — Tasks

Read `spec.md` and `design.md` first. `[P]` = no dependency on another unfinished task,
safe to run in parallel.

**Gates.**
Proxy (`crab/crab-shell-proxy`): `go build ./... && go vet ./... && go test ./...`
Webapp (`crab/crab-exoskeleton-webapp`): `yarn test && npx tsc --noEmit && yarn build`

---

## T-01 [P] — `turnRegistry` records a first-seen timestamp and can list a scope

**Status: done.** `turn_registry.go`: `turnEntry{count, since}`, injectable `now`, `List(scope)` sorted oldest-first with a session-id tiebreak. 7 new tests; `go build`/`go vet` clean, `go test -race ./internal/httpapi/` green (the whole package, not a filtered subset).

**What.** Replace the `int` value with `turnEntry{count int; since time.Time}`. `Begin`
sets `since` only when creating the entry; the `end` closure deletes at zero as it does
now. Add `List(scope)` returning entries with `count > 0`, sorted by `since` ascending.
**Where.** `crab-shell-proxy/internal/httpapi/turn_registry.go`.
**Reuses.** The existing lock, the existing `Begin`/`end` contract, `memgraph.Scope`.
**Done when.** `Active` and `Current` are behaviourally unchanged and their existing tests
pass untouched (FR-P9); `List` does not route through `Current` and says why in a comment
(FR-P5); the don't-reset-`since` rule is documented where the re-entrancy comment already
lives (FR-P6).
**Tests.** `List` returns every session with count > 0, not just an unambiguous one; a
second `Begin` on the same session does not move `since`; decrementing to zero drops the
entry and its timestamp; an empty scope returns an empty slice.
**Gate.** Proxy gate.
**Watch for.** Needs a clock for the timestamp tests. Check for an existing injectable one
on `Server`/`turnRegistry` before adding a field; a package-level `now = time.Now`
overridden in tests is the fallback.

## T-02 — `GET /v1/turns/running`

**Status: done.** `handlers.go`: route at the `active` registration, `handleTurnsRunning` beside `handleTurnsActive`. 6 new handler tests. Not added to `openapi.json` — `/v1/turns/active` is not there either, so the route family's precedent is followed.

**What.** Register the route beside the `active` one and add `handleTurnsRunning`.
**Where.** `crab-shell-proxy/internal/httpapi/handlers.go` (route at ~line 284, handler
beside `handleTurnsActive` at ~1581).
**Depends on.** T-01.
**Reuses.** `handleTurnsActive` wholesale, minus the `session_id` read: `resolveAgent`,
`Resolver.Resolve(identity.ProfileHeader)`, the `tenant_id`/`subs_acc_id` UUID parses, the
`ident.Profile.AccID == subsAccID` 403, `docker.WorkspaceKey` + `scopeOf`, the
`s.turns != nil` guard, `writeJSON`/`errBody`.
**Done when.** Response is `{"turns":[{"session_id","since"}]}` with an initialised slice
so empty marshals to `[]` not `null` (FR-P8); raw session ids, no hashing (FR-P4); no
`session_id` and no `project` parameter, with the reason stated (FR-P3); no call into
`internal/docker` from this path (FR-P7).
**Tests.** Beside `handlers_test.go:1346` — 200 with entries; 200 with `[]`; 400 on
missing/invalid `tenant_id`; 403 on the account-switch guard; 401 without the profile
header; 404 without the service-name header.
**Gate.** Proxy gate.

## T-03 [P] — i18n copy, both locales

**Status: done.** `lib/i18n/chat.ts`: a `dock` namespace in `en` and `pt`, 13 keys each. Locale-parity test passes with no new SHARED entries.

**What.** Add the dock's strings to `en` and `pt`: five state labels (unsent, working,
reconnecting, ready, failed), the `+N` overflow label, the workspace/project qualifier, the
**two** elapsed phrasings (quiet-for in-session vs total-duration restored — DEC-12), and
the dock's accessible label.
**Where.** `crab-exoskeleton-webapp/lib/i18n/chat.ts`.
**Reuses.** The existing `recovering` string as the tonal reference — say what is
happening and that the agent is still working.
**Done when.** Both dicts have every key and the existing locale-parity test passes
(FR-U10). No string reaches a component as a literal.
**Gate.** Webapp gate.

## T-04 [P] — `setWorkspace` can carry a project

**Status: done.** `fragment.ts`: optional third parameter; the deliberate `params.delete("p")` kept as the else branch. 3 new tests, existing fragment suite untouched and green.

**What.** Optional third parameter `project?: string | null`. When given, set `p`; when
absent, keep today's deliberate `params.delete("p")` as the else branch, comment intact.
**Where.** `crab-exoskeleton-webapp/app/chat/fragment.ts` (~line 204).
**Done when.** Every existing caller is unchanged in behaviour; one hash write lands
workspace + project + sid together (design's project-navigation hazard).
**Tests.** Existing `setWorkspace` tests still pass; a new one asserts `p` is present with
a project and absent without, in a single hash write.
**Gate.** Webapp gate.

## T-05 [P] — store: `isDocked`, `useActiveTurns`, acknowledged set

**Status: done.** `turn-store.ts`, additions only: `dockStateOf` (named for the design's one-decision rule, not `isDocked`), `dockedTurns` memoized on a signature that buckets `lastEventAt` to the second, `useActiveTurns`, `acknowledgeTurn` with lazy un-acknowledge. `__reset` extended to clear both. 24 new tests.

**What.** Export `dockStateOf(state)` returning FR-S2's discriminator or `null`; add
`useActiveTurns()` over the existing `subscribe`/`emit`; add a module-scope acknowledged-sid
set with `acknowledgeTurn(sid)`, un-acknowledged when a turn goes `running` again.
**Where.** `crab-exoskeleton-webapp/app/chat/turn-store.ts` — additions only.
**Reuses.** `subscribe`, `emit`, `getTurn`, `contexts`, `useSyncExternalStore`.
**Done when.** No existing function in the file is edited (DEC-1); no new painter or global
callback slot (DEC-9/FR-S6); the snapshot is referentially stable across a reveal tick
(FR-S3); `error`/`errorDetail` are never mutated (DEC-9).
**Tests.** The negative predicate case is the one that matters: an entry that has been
through `clearCompleted` — blank bands, `running: false` — is **not** docked, because
`turns` is never pruned (DEC-8). Plus: every row of FR-S2's table maps to its state and
**nothing docks with a `null` discriminator**; each precedence pair resolves the stated way
(`error` over *ready*, `recovering` over *working*, *working* over *unsent*); a parked
`pending` burst with `running: false` docks as *unsent* (DEC-13); an acknowledged entry does
not dock; a new run un-acknowledges; the snapshot reference is unchanged across a `revealed`
mutation and changes when the discriminator does.
**Gate.** Webapp gate.

## T-06 — BFF route `/api/chat/[instance]/running`

**Status: done, UNTESTED.** `app/api/chat/[instance]/running/route.ts`, modelled on
`active/route.ts`. Present in `next build`'s route table. The task said to cover it through
T-07 — **that does not hold**: T-07 stubs `fetch` wholesale and never executes this file, so
the row filter, the 502 `connectivity` mapping and the 401 → `clearSession` path have no test
at all. Defensible only because the repo has no route-test harness; do not read "T-07 covers
it" anywhere.

**What.** Pass-through to the proxy route, returning the `turns` array.
**Where.** `crab-exoskeleton-webapp/app/api/chat/[instance]/running/route.ts` (new).
**Depends on.** T-02 for the wire contract — the file can be written in parallel from the
spec, but its integration is only verified after T-02 exists.
**Reuses.** `active/route.ts` verbatim otherwise: `isInstance`, `getSession`, the 401 →
`clearSession`, `MyceliumConnectivityError` → 502, `upstreamError`, and the comment
explaining why `project` is not forwarded.
**Done when.** `session_id` is not in the required set; `tenant_id`/`subs_acc_id` still
are; the response is a mapped array, never `null`.
**Tests.** Follow whatever pattern the existing chat API routes use; if none are unit
tested, cover it through T-07's tests instead of inventing a harness here.
**Gate.** Webapp gate.

## T-07 — `turn-restore.ts`: rebuild the dock after a reload

**Status: done.** `turn-restore.ts`: per-workspace fan-out, join on `ConversationSummary`, `restoredSince`, module-scope once-flag. 10 new tests, including the one that fails if `resumeIfActive`'s `/active` probe is short-circuited.

**What.** For each workspace, in parallel: probe `/api/chat/{r}/running`, `listConversations`,
join on id, build a `RunContext`, and run `resumeIfActive` per match.
**Where.** `crab-exoskeleton-webapp/app/chat/turn-restore.ts` (new).
**Depends on.** T-06.
**Reuses.** `resumeIfActive` **unchanged**, `listConversations`, `ConversationSummary`
(which already carries `id/role/tenantId/subsAccId/title/alias/project`), the
`probes.cancelled` hook that already exists for unmount.
**Done when.**
- `active: () => true` is **not** passed. This is FR-R3 and the single most important line
  in this task: the listing probe precedes the transcript baseline, so short-circuiting
  restores the ordering defect `resume-turn-after-reload` FR-7 was written to remove — a
  turn that lands during the probe would be baselined with its own reply, never grow, and
  report `turn_lost` after eleven minutes.
- Session ids with no matching conversation record are skipped, not docked with a
  placeholder (FR-R2).
- Idempotent via a module-scope flag, not a React ref (FR-R4).
- A failed probe docks nothing and shows no error (FR-R6).
- Nothing is written to `localStorage` (FR-R7).
**Tests.** A test that **fails if the `/active` probe is skipped** — assert the probe was
called, and that the baseline read precedes it. Plus: unmatched ids skipped; a rejected
probe yields no docked entries and no throw; a second invocation performs no fetches.
**Gate.** Webapp gate.

## T-08 — `turn-dock.tsx`

**Status: done.** Split in two, following the repo's own habit (`split-boxes.ts`, `sidebar-tree.ts`): `dock-segments.ts` holds the ordering, cap, two-clock readout, qualifier and keyboard predicate (22 tests, node env); `turn-dock.tsx` renders (17 tests, jsdom). `useElapsed` was NOT exported after all — the bar runs one interval for every chip instead of one per chip.

**What.** The bar: equal segments, capped with `+N` overflow, four states, elapsed
readout, click-to-navigate.
**Where.** `crab-exoskeleton-webapp/app/chat/turn-dock.tsx` (new).
**Depends on.** T-03, T-04, T-05.
**Reuses.** `useActiveTurns`, `acknowledgeTurn`, `setWorkspace(ws, sid, project)`,
`SILENCE_GRACE_MS`, and from `turn-progress.tsx`: the reduced-motion pattern,
`formatElapsed`, and `useElapsed` (**needs exporting** — currently module-private).
`--accent` / `--accent-soft` / `--accent-fg`.
**Done when.** Absent and reserving no height when empty (FR-U1); cap 4 desktop / 3 mobile,
oldest first (FR-U3); label is `alias ?? title` plus a workspace/project qualifier when it
differs from the view (FR-U4); the current conversation is excluded here, not in the store
(DEC-5); clicking navigates in one hash write and acknowledges (FR-U6); motion neutralized
under `prefers-reduced-motion`, elapsed counter kept (FR-U7); `errorDetail` rendered
untranslated (FR-U5); `--brand` is not used. Elapsed reads `lastEventAt` in-session and the
server's `since` when restored, and **never** `recoveringSince` (DEC-12) — that field is
stamped by `recover()` at resume time and would show a restored nine-minute turn as fresh.
The label comes from `dockStateOf`'s discriminator, not a second `switch` (design).
**Tests.** Empty → renders nothing; N entries → N segments; over the cap → cap segments
plus `+N`, oldest kept; each of the five states renders its own copy in both locales; an
*unsent* chip shows no spinner and no clock; a restored entry's readout comes from `since`
and is unaffected by `recoveringSince`; a click calls `setWorkspace` with the project and
acknowledges the sid; the current sid is absent from the segments.
**Gate.** Webapp gate.

## T-09 — shell integration, layout and mobile

**Status: done.** `chat-shell.tsx`: `<TurnDock>` as the last child of `<main>`, restore effect gated on `groups`. 5 source-reading layout tests. **Carries a SPEC_DEVIATION** — see below.

**What.** Mount the dock in `chat-shell.tsx` as a sibling of `ChatView`, kick off T-07's
restore once the workspace groups resolve, and settle the stacking.
**Where.** `crab-exoskeleton-webapp/app/chat/chat-shell.tsx`.
**Depends on.** T-07, T-08.
**Reuses.** The shell's existing `desktop` state from `matchMedia("(min-width: 768px)")` —
passed down, not a second listener; `useWorkspaceGroups`; `useFragment` for the current
sid.
**Done when.** The dock is a sibling of `ChatView`, never a child — `ChatView` is keyed on
`${t}|${s}|${r}` (`chat-shell.tsx:303`) and unmounts on a workspace switch, which the dock
must outlive; no overlap with the composer or `RestartBanner` at any breakpoint, with
either sidebar open or collapsed (FR-U9); on mobile the dock is above the composer in
document order and hidden while the virtual keyboard is open (FR-U8/DEC-11); z-index
declared in one place.
**Tests.** A layout test asserting the no-overlap and mobile-keyboard cases —
`mobile-keyboard-viewport.test.ts` is the precedent; restore is invoked once when groups
resolve and not on subsequent re-renders.
**Gate.** Webapp gate.

## T-10 — operator verification (gated on a live stack)

**Status: NOT RUN.** Needs the deployed stack; cannot be executed from a dev checkout.

**What.** The only check that can falsify the feature.
**Depends on.** T-01..T-09.
**Steps.**
1. Send in three conversations across two workspaces (at least one a project chat),
   navigate away from each → three segments, correct labels and qualifiers.
2. Reload mid-flight → all three return, with elapsed times continuing from the server's
   `since`, not from zero.
3. Let one land while elsewhere → its chip goes *ready* and stays until opened; opening it
   shows the reply and retires the chip.
4. Force one to fail → chip reads *failed*, and `turn-failure-visible`'s banner still
   appears when the conversation is opened (the dock must not have cleared `error`).
5. Hit send and navigate away inside 500ms → chip reads *unsent*; returning and typing
   flushes the burst (DEC-13).
6. Confirm no container was provisioned by the restore fan-out (FR-P7) — check the proxy
   log for the reload.
**Done when.** All six recorded in this spec directory with the observed output.

---

## Not tasks

- Pruning `turns` (spec OQ-3) — a separate decision.
- Tab-title/favicon badging (OQ-1).
- A stop control on a chip — ruled out by DEC-7, not deferred.
- Correcting `resume-turn-after-reload/spec.md`'s stale "Not implemented" status — done
  out of band while writing this spec, since it was verified in passing.

---

## SPEC_DEVIATION — T-09, mobile dock placement

**Spec DEC-11 / FR-U8 put the mobile dock ABOVE the composer. It is below it, on both
breakpoints.**

Reason: the composer lives inside `ChatView`, and `ChatView` is keyed on
`${t}|${s}|${r}` and unmounts on a workspace switch. "Above the composer" therefore means
"inside the component the dock must outlive" — the two requirements are in direct
contradiction, and outliving `ChatView` is the one the whole feature rests on.

DEC-11's actual goal was no collision with the composer or the soft keyboard, and that is
met by two other means: the bar is the last child of the chat column, so it cannot cover
what precedes it (the shell is `h-dvh` with `interactiveWidget: "resizes-content"`, so the
keyboard shrinks the layout viewport rather than overlaying it); and on mobile the bar hides
while a text field has focus — `dock-segments.hidesForKeyboard`, which is also the only
honest keyboard signal available, since no browser API reports the soft keyboard directly.

Marked in `chat-shell.tsx` at the mount site.

## Deviations that are not deviations, but are worth recording

- `isDocked` is named `dockStateOf` and returns the state discriminator or `null`, per
  `design.md`'s "membership and label are ONE decision". The task text still said
  `isDocked`; the design is the later word and was followed.
- `qualifier` shipped with a hole and was fixed before hand-off: it compared "does the
  segment have a project" rather than project identity, so a conversation at the AGENT ROOT
  seen from inside one of that agent's projects came back unqualified — reading as if it
  belonged to the project on screen, when a project is a picoclaw agent with its own
  workspace directory. Two tests added for it.
- `turn-dock.tsx`'s label cache was reworked for the same reason. Keying "already fetched"
  by workspace, permanently, meant a conversation created AFTER that workspace's list loaded
  could never be named — and that is the ORDINARY in-session case, since a chat docks the
  moment you send in it and navigate away. Now: `inFlight` clears on settle, and the refetch
  loop is closed from the other end by a `searched` set of ids the workspace did not return.
  Four tests added, one of which was confirmed to fail against the old behaviour.
- `useElapsed` was to be exported from `turn-progress.tsx` (T-08 Reuses). It was not: the
  dock runs ONE interval for the whole bar rather than one per chip, because the store
  snapshot deliberately excludes sub-second time. `formatElapsed` is reused as planned.
- The proxy's `internal/docker` suite fails in this environment on `lchown: operation not
  permitted` (it needs root). Pre-existing and untouched by this work; `internal/httpapi`
  is green.
- `npx tsc --noEmit` reports 5 errors, all in pre-existing test files
  (`conversation-bursts`, `history-cache`, `scheduled-tasks`). Verified identical before and
  after this work by stashing. `next build` is clean.

## Follow-up — FR-U1a, lane colours (done 2026-08-18)

Reported after using the bar: the segments were hard to tell apart. The dividers were
`border-r border-accent/30` — the same faint tint on both sides of every one.

Fixed by adopting the tree's colour rule rather than inventing one: `laneColorFor` from
`conversation-bursts.ts`, which the tree spine and the Canvas timeline already share. Each
segment gets a 4px rail and its name in the conversation's lane colour.

`turn-dock.tsx`'s cache now holds the whole `ConversationSummary` instead of just
`alias ?? title` — `laneColorFor` prefers the conversation's first tag colour and needs the
tags to find it. The colour does not wait on that fetch: `laneColorFor(undefined, sid)` is the
id hash, so a chip is correctly coloured from its first frame.

No background tint — an inline `backgroundColor` would outrank `hover:bg-accent/30` and kill
the hover state.

The rail is on EVERY segment, including the first, where it sits flush against the bar's edge.
That inverts the old `last:border-r-0` logic on purpose: the rail is the chip's identity marker,
not a divider between two chips, so a leading chip with no colour would be the only one in the
bar unidentifiable by hue. Locked by a test.

`__seedDockLabel` became `__seedDockRecord` and takes a whole `ConversationSummary` instead of a
label plus an `as` cast. The cast fabricated a record missing seven fields; the component reads
only three today, so the moment a chip started reading `record.project` every seeded test would
have silently got `undefined` rather than failing to compile.

Tests: 5 added (rails differ per segment and none is empty; the rail equals `laneColorFor`
exactly, so the dock and the tree cannot drift; a tag colour wins; an unresolved record is still
coloured; the state tone survives alongside the identity colour). **Four of the five were
confirmed to fail against a hardcoded constant colour** — they discriminate rather than merely
pass. Webapp gate green — 92 files / 1223 tests, `next build` clean, `tsc` at the 5-error
baseline.

## Follow-up round 2 — FR-U1a corrected after looking at the built bar (2026-08-18)

Round 1 was not enough, and the report was specific: the colour was on one border and on the
text, and against the bar's background it was not legible.

Three changes:

1. **Rail moved from the left edge to the TOP edge.** Under `flex-1` the top rails butt against
   each other into one contiguous multi-coloured strip, so the boundary between segments is a
   colour change. The left rail marked only where a chip began; the bodies below still merged.
2. **The bar left the accent.** `bg-accent-soft/60` + `border-accent` → `bg-surface` +
   `border-brand/30`, the pair the shell's chrome already uses. `text-accent-fg` went too — it is
   the ink for an accent FILL, so on a neutral surface it was just wrong. Hover moved from
   `hover:bg-accent/30` to `hover:bg-elevated`.
3. **The name is no longer painted in the lane colour.** `laneColor` is `hsl(hue 65% 55%)` — a
   mid-tone, which is precisely why it reads as a 4px rail on both themes and fails as text. The
   state tone also came off the whole chip and now applies only to the state icon and the state
   label, so a `failed` chip reds its state, not the conversation's name.

Dark mode checked, not assumed: `--surface`, `--fg`, `--fg-muted`, `--brand`, `--blocked` and
`--notice` are all redefined under `prefers-color-scheme: dark` in `globals.css`.

Tests: 3 added (the name never carries the lane colour; the state tone never reaches the name;
the bar carries no `accent` class at all). The first was confirmed to fail when the lane colour
is put back on the name — it catches the reported regression, not a paraphrase of it. 25 tests in
the dock file, 1236 in the suite, `next build` clean.

**Correction to an earlier claim in this file:** the `tsc` count was reported as "the 5-error
baseline" using a `grep -c '^[a-z]'` that also counted multi-line error continuations. The real
figures: **HEAD has 8 errors, the working tree has 5**, and none of the 5 sits in a file this
feature touched. Count with `grep -c 'error TS'`.

### Round 2, second correction — the rail's own contrast

The round-2 note above claimed the lane colour "reads as a 4px rail on both themes". That was
asserted, not measured, and it was **wrong**. Measured across the hue wheel against
`--surface`:

| | worst | where |
|---|---|---|
| light `#f7f9fa` | **1.46:1** | hue 60 |
| dark `#1b1f23` | **2.35:1** | hue 240 |

Every hue from 45 to 195 is under 2.5:1 on light — half the wheel, so a conversation whose id
hashed to yellow-green drew an invisible rail. The reported bug, back at random.

Fixed with `railColor` in `dock-segments.ts`: hue and saturation kept, lightness re-solved for a
fixed relative luminance of 0.258 — the only band satisfying light at 3:1 (L ≤ 0.2662) and dark
at 4.5:1 (L ≥ 0.2497) simultaneously, which is why one value per conversation serves both themes.
Sampled output: every hue at ~3.2:1 light / ~4.9:1 dark, hue unchanged.

The `"matches laneColorFor exactly"` test became `"keeps laneColorFor's hue"` — exact match is no
longer the invariant, and asserting it would have blocked the fix. Hue is what identity rides on.

Guarded by a **property test over the whole wheel** (72 hues × 2 surfaces), not by one sampled
colour: the failure depended on which conversation hashed to which hue, so a single-colour
assertion could never have caught it. That is the test that was missing both previous rounds.

The container's `border-t border-brand/30` was also dropped — the rails now form the bar's top
edge themselves.

29 tests in `dock-segments`, 25 in `turn-dock`, 1253 in the suite. `next build` clean, `tsc` at
5 (HEAD is 8).

**STILL UNSEEN IN A BROWSER.** Every check in both rounds is a unit test over class names,
inline styles and computed contrast ratios. Nothing here has been rendered, because the webapp
container cannot reach the gateway and the chat never gets past `ConnectivityError` — the
networking fault diagnosed earlier in this session is unresolved and blocks the only
verification that can settle a legibility complaint.

## Follow-up round 3 — alias and tags on the chips (2026-08-18)

Asked for: when a chat has an alias or tags, show them in the dock too, in the same styles the
conversations use.

The conversations' hierarchy is `history-sidebar.tsx:588-601` — derived TITLE primary, member's
ALIAS beneath it in smaller muted type, `TagCluster` as a sibling. The chip now follows it.

**A requirement was superseded, not weakened.** The chip showed `alias ?? title`, which threw
away whichever one it did not pick — and the alias is the name the member chose, so that was the
worse half of the trade. It now shows both, and the test that asserted the old behaviour
(`"prefers the alias over the title"`) was rewritten rather than deleted. `aria-label` carries
the alias when there is one, because it REPLACES button content for a screen reader.

**`TagCluster` gained an `open` prop**, defaulting to `"down"` so the tree and the list are
untouched. Its popover is `absolute top-full` — and the dock is pinned to the bottom of the
viewport, so the default opens entirely off-screen. `"up"` swaps to `bottom-full pb-1`. Reusing
the component rather than restyling tags a second time is the point: the collapsed icon, the
count and the popover chips cannot drift from the sidebar's.

Chips use `items-start` against the container's `items-stretch`, so a chip that grew a second
line makes the whole row as tall as it and the bar's top edge stays straight.

Tests: 5 added/rewritten (title and alias both shown, with the muted secondary; aria-label named
by the alias; no second line without an alias; the cluster appears with tags and not without;
the popover opens upward). 30 in the dock file, 1272 in the suite.

Still unseen in a browser, for the same reason as rounds 1 and 2.

## Follow-up round 4 — mobile scrolls instead of hiding (2026-08-18)

Asked for: on mobile, past three tasks, allow horizontal overflow.

`dockLayout(count, desktop)` in `dock-segments.ts` now returns `fit | scroll | overflow`, and it
is the only place that decision is made. Desktop is untouched (`+N` popover); mobile past the cap
keeps every segment and scrolls the strip.

**A requirement was superseded, not weakened.** FR-U3 had mobile hiding its extras behind the
same `+N` control as desktop; the test asserting that (`"fits fewer segments on mobile"`) was
rewritten, not deleted. Recorded as FR-U3a.

The one trap: a scrolling segment must not be `flex-1`. A growing, zero-basis flex child shrinks
to fit its container instead of overflowing it, so `overflow-x-auto` would exist over content
that always fits and nothing would ever scroll. Scrolling segments get `w-[72%] shrink-0`; the
72% leaves the next chip half-visible as the scroll affordance. `overflow-x-auto` is applied only
in `scroll` mode — on a fitting bar it would be a scroll container that never scrolls.

Tests: 5 added (mobile keeps all five chips with no `+N`; the strip gets `overflow-x-auto`; chips
carry `shrink-0` and not `flex-1`; three or fewer still divide the bar with `flex-1`; desktop's
`+N` is unaffected), plus 3 on `dockLayout`'s boundaries. **All 5 were confirmed to fail against
a `dockLayout` hardcoded to `"scroll"`** — they discriminate. 34 in the dock file, 32 in
dock-segments, 1282 in the suite; `next build` clean, `tsc` at 5.

Note on the suite: an unrelated failure in `app/admin/breadcrumb.test.tsx` was present mid-round
and resolved by whoever is working on the admin shell in this same checkout concurrently. It was
never part of this feature.

Still unseen in a browser — including, now, whether 72% is the right fraction on a real phone and
whether the strip wants scroll-snap. Neither is something a class assertion can answer.

## Follow-up round 5 — text scrambling, on both breakpoints (2026-08-18)

Reported: the texts scramble on mobile AND on desktop; adopt a different mobile strategy — one
box that expands upward into a list; and prioritise stacking the chip's texts in a column.

**Desktop — the chip is a column now (FR-U4a).** Title, then state + elapsed, then qualifier,
then alias, each `truncate`-ing on its own line. Packed in a row, four independent strings fought
over one segment's width. The state keeps its elapsed time on the same line on purpose: one fact,
both halves short.

**Mobile — one box (FR-U3a, amended a second time).** `dockLayout` returns `collapsed` for mobile
at every count, and `"scroll"` is gone from the type. This is the third mobile strategy in three
rounds, and the first two failed for the same reason: both divided a phone-width bar. The lesson
worth keeping is that the count was never the variable — a phone has no room for one segmented
row, let alone three.

New: `summaryState(segments)`, ranking `failed > ready > reconnecting > unsent > working`. `ready`
must be in it — the collapsed box is the ONLY thing a mobile member sees, so a box that cannot
report a landed reply has lost the notification the feature exists for. The box's rail takes the
colour of the conversation it reports on, so tapping through lands on the right row.

`dockCap(desktop)` became the constant `DESKTOP_CAP`: with mobile collapsing unconditionally, the
breakpoint parameter was a value nothing read.

**A mistake worth recording.** Rewriting the mobile tests, I replaced a slice between two string
markers and it swallowed nine unrelated blocks — 18 tests, including the whole `resolving names`
and `lane colours` suites. The count went 34 → 16 and the suite still passed green, which is
exactly how that kind of loss hides. Caught by comparing the count, restored, then verified: 36
tests, no duplicates. `turn-dock.test.tsx` is untracked, so there was no git baseline to recover
from — the reconstruction was by hand.

Suite: 1288 passing, `tsc` at 5, `next build` clean.

Still unseen in a browser. New questions for when the stack is up: whether four stacked lines make
the desktop bar too tall, and whether the collapsed box needs a dismiss gesture beyond re-tapping
it.

## Follow-up round 6 — the panel was behind the composer; the mobile control was too small

Both reported from a phone.

**1. The expanded list rendered behind the message box.** FR-U9 said the dock must not overlap
the composer, and that was read as settled — but it conflates two things. The *bar* sits in normal
flow below the composer and never overlaps it. The *panel* opens upward into exactly the band
where the composer floats at `z-20`, and the dock container had no z-index at all, so `auto` lost.
Document order does not decide it when one side declares a layer and the other does not.

Fixed with `z-30` on the dock container. The test compares the dock's layer against the
composer's **across both files**, rather than asserting the dock contains `z-30`, so raising the
composer later fails here instead of silently re-burying the list.

Worth noting: this was flagged as an untested risk two rounds earlier — "TagCluster's popover
stacking ... should win, but it's untested and unviewed" — and shipped anyway because the reasoning
looked sound. It was not sound; `z-20` beats `auto` regardless of DOM order.

**2. The mobile summary box was ~32px.** It inherited `py-2 text-xs` from the desktop chips.
Now `min-h-11 py-3 px-4 text-sm` with 18px icons — 44px, matching the `h-11` this codebase already
uses for touch targets. It is the ONLY control on the mobile bar, so a miss costs access to every
background conversation.

Both tests were confirmed to fail against the previous code. Suite: 1293 passing, `tsc` at 5,
`next build` clean.

# canvas-timeline-view Tasks

Webapp-only (`crab/crab-exoskeleton-webapp`); **no proxy/Go change** —
`created_at` already surfaced by [[conversation-tree-view]]. Gate: `yarn build`
(Next type-check) + `yarn test` (vitest). Runtime: log in via magic-link, create
an "A → B → A → C" usage pattern, toggle Traditional → Canvas. `[P]` =
parallelizable.

---

## T01 — extract the shared burst model — CANV-04, DEC-CANV-05
- **What:** create `app/chat/conversation-bursts.ts` and move, unchanged, from
  `conversation-tree.tsx`: `laneColor`, `tagColorOf`, `withAlpha`, `laneColorFor`,
  `interface TreeEvent`, `interface Burst`, plus `buildEvents(lists)` (flatten +
  `created_at` parse + `updatedAt+seq` fallback + desc sort) and
  `aggregateBursts(events)` (consecutive-run collapse). Re-import them in
  `conversation-tree.tsx` with no behavior change.
- **Reuses:** existing logic in `conversation-tree.tsx`.
- **Done when:** `conversation-tree.tsx` uses the extracted module; `yarn build`
  green; **manual check** — open the tree view and confirm it renders identically
  (no existing tree unit test to guard the extraction).
- **Depends on:** —

## T02 — burst-model unit tests — CANV-04, NFR-3 [P after T01]
- **What:** unit-test `conversation-bursts.ts`: `buildEvents` sorts by parsed
  instant and falls back to `updatedAt+seq` for missing/unparseable `created_at`;
  `aggregateBursts` collapses only consecutive same-conversation runs.
- **Done when:** `yarn test` green with the new cases.
- **Depends on:** T01

## T03 — fragment `view` key + setView — CANV-01
- **What:** in `app/chat/fragment.ts` add `view?: string` to `FragmentState`,
  read it in `readFragment`; add `setView(view: "chat" | "canvas")` (set
  `view=canvas` else delete; assign `location.hash`; preserve `t/s/r/sid/hv`,
  drop `msg`) — mirror `setHistoryView`.
- **Done when:** `useFragment().view` reflects the hash; navigating doesn't lose
  `hv`/`sid`; `yarn build` green.
- **Depends on:** —

## T04 — CanvasTimeline: data + shell wiring — CANV-02, CANV-10, NFR-3
- **What:** create `app/chat/canvas-timeline.tsx` that takes `{ workspace }`,
  loads `listConversations` + subscribes to `onConversationsUpdated`, N-fetches
  via `getHistory` (force only active), builds events+bursts (T01), with the
  tree's workspace-change spinner guard. Branch `chat-shell.tsx` on
  `fragment.view === "canvas"`: skip the HistorySidebar pane, render
  `<CanvasTimeline>` in `<main>`.
- **Done when:** toggling `view=canvas` (via URL) shows a full-width canvas with
  no history sidebar and a loaded burst model; Traditional path unchanged.
- **Depends on:** T01, T03

## T05 — timeline render (axis + lanes + dots) — CANV-03, CANV-04, NFR-2
- **What:** horizontal SVG stage in `canvas-timeline.tsx`: `xOf` time-map, 4–5
  axis ticks, one lane per conversation (asc by `firstT`) with a lifespan line +
  a burst dot each (size by count, recency emphasis), leaf label, colors via
  `laneColorFor`. Lanes are **stable** (one per conversation, always drawn);
  paging = horizontal scroll of the stage, NOT a window filter. Bound total lanes
  with a `MAX_LANES` cap + graceful overflow; fetch stays O(all) via the cache —
  the cap bounds drawing only.
- **Done when:** lanes/dots render time-ordered, colors match the tree, lanes
  stay put while scrolling, and a many-conversation workspace stays responsive.
- **Depends on:** T04

## T06 — agent-pulse strip — CANV-05 [P after T05]
- **What:** bucket burst counts over `[tMin,tMax]` into `NBUCKETS`; render an
  area+line path (accent gradient) above the lanes sharing `xOf`.
- **Done when:** the pulse reflects aggregate volume and aligns to the axis.
- **Depends on:** T05

## T07 — interaction: hover-dim, preview, solo, handoff — CANV-06, CANV-07
- **What:** hover a lane → dim others; click → inline preview panel (title,
  count/bursts/last-ago, last 2 bursts' user/agent lines) with **Solo**
  (`soloId` → render one lane; "show all" clears) and **Full transcript**
  (`setFragmentSid(id)` + `setView("chat")`).
- **Done when:** preview/solo/handoff work; Full-transcript lands the traditional
  chat on the right conversation.
- **Depends on:** T05

## T08 — header toggle + time band + pagination — CANV-01, CANV-08
- **What:** `Traditional | Canvas` segmented control (`cva`, like the sidebar's
  `viewToggle`) in **both** the canvas header and the `chat-view.tsx` header, both
  calling `setView`. Time band with visible-range text + `‹ ›` paging and
  horizontal scroll shifting the window.
- **Done when:** entering from chat and leaving from canvas both work and persist
  (`view=canvas` on reload); paging updates the visible range.
- **Depends on:** T03, T05

## T09 — pixel-art background + motion/a11y polish — CANV-09, NFR-4
- **What:** theme-aware `repeating-linear-gradient` grid (fine + every-Nth) on the
  stage; lifespan/pulse draw-in gated on `prefers-reduced-motion`; focusable lanes
  with visible focus; light/dark parity.
- **Done when:** grid reads in both themes, animations off under reduced-motion,
  keyboard focus visible; `yarn build` green.
- **Depends on:** T05, T06

## T10 — empty/loading/edge states — CANV-03, edges
- **What:** empty workspace → `"No conversations yet."`; loading spinner without
  refetch flash; single-burst lane renders a dot; missing-`created_at` lane orders
  by `updatedAt` without crashing.
- **Done when:** all edge cases render gracefully.
- **Depends on:** T05

---

## Verification (feature-level)
- `yarn build` + `yarn test` green.
- Manual runtime script (design.md Test/gate) passes end-to-end.

---

## Progress (2026-07-20)

Implemented T01–T10 in one pass (webapp-only). Files:
- NEW `app/chat/conversation-bursts.ts` — shared model (T01).
- NEW `app/chat/conversation-bursts.test.ts` — 9 unit tests (T02).
- NEW `app/chat/view-mode-toggle.tsx` — shared Chat|Canvas control (T08).
- NEW `app/chat/canvas-timeline.tsx` — the Canvas view: data + shell wiring
  (T04), timeline render (T05), agent pulse (T06), hover-dim/preview/solo/
  handoff (T07), header toggle + time band + `‹ ›` paging (T08), pixel-art bg +
  reduced-motion + focus a11y (T09), empty/loading/single-burst/fallback (T10).
- EDIT `app/chat/conversation-tree.tsx` — imports the extracted model (T01).
- EDIT `app/chat/fragment.ts` — `view?` key + `setView` (T03).
- EDIT `app/chat/chat-shell.tsx` — branch on `view==="canvas"` (desktop-only;
  mobile ignores it), hide history sidebar, render CanvasTimeline (T04).
- EDIT `app/chat/chat-view.tsx` — `ViewModeToggle` in the header (T08).

**Gate:** `npx tsc --noEmit` clean; `yarn test` 47 passed. `yarn build` could NOT
run — `.next/` holds root-owned files from a prior docker build (EACCES on
unlink); used `tsc --noEmit` as the type-check gate instead. `next lint` is not
configured (interactive prompt), so it was skipped.

**PENDING — manual runtime verification** (needs the running stack: magic-link
login, create an A→B→A→C pattern, toggle Chat→Canvas): confirm axis/lanes/dots/
pulse render, colors match the tree, hover-dim, click-preview, Solo, Full-
transcript handoff, `‹ ›`/scroll paging, reload persistence (`view=canvas`),
return to Chat intact, empty state, reduced-motion. Not yet done.

**Not committed** (per user's global rule: never commit unless asked).

# canvas-timeline-view — Design & Contract

Decisions (see [[context.md]]): **DEC-CANV-01** timeline only. **DEC-CANV-02**
workspace-level `view` toggle, replaces sidebar+chat. **DEC-CANV-03** data from
`created_at` via `getHistory`, capped window. **DEC-CANV-04** preview + handoff.
**DEC-CANV-05** reuse tree burst model + `laneColorFor`. **DEC-CANV-06** agent
pulse. **DEC-CANV-07** pixel-art grid.

Webapp-only. **No proxy/BFF/Go change** — `created_at` is already surfaced by
[[conversation-tree-view]].

## Architecture overview

```
chat-shell.tsx  ─ reads fragment.view ("chat" | "canvas")
  ├─ NavSidebar                         (always)
  ├─ view==="chat":  HistorySidebar + <main> ChatView   (unchanged)
  └─ view==="canvas": <main> CanvasTimeline (full width, no history sidebar)
```

New/changed files:
- `app/chat/fragment.ts` — add `view?: string`; `setView("chat" | "canvas")`.
- `app/chat/conversation-bursts.ts` *(new)* — extract the shared model from
  `conversation-tree.tsx`: `TreeEvent`/`Burst` types, `buildEvents`,
  `aggregateBursts`, and `laneColorFor`/`laneColor`/`tagColorOf`/`withAlpha`.
- `app/chat/conversation-tree.tsx` — import the extracted helpers (no behavior
  change; keeps tree & canvas identical by construction — CANV-04).
- `app/chat/canvas-timeline.tsx` *(new)* — the Canvas view (header toggle,
  pulse, timeline SVG, preview, solo, pagination, pixel-art bg).
- `app/chat/chat-shell.tsx` — branch on `view`.
- `app/chat/chat-view.tsx` — add the `Traditional | Canvas` control to its header.

## Fragment: the `view` key (CANV-01)

- Extend `FragmentState` with `view?: string`; `readFragment` reads `view`.
- `setView(view)`: `params.set("view","canvas")` for canvas, else delete (default
  clean), then assign `location.hash` — same native-`hashchange` mechanism as
  `setHistoryView`/`setFragmentSid`; preserves `t/s/r/sid/hv`, drops transient
  `msg`.
- `chat-shell.tsx`: `const canvas = fragment?.view === "canvas" && !!workspace`.
  When `canvas`, do **not** render the HistorySidebar `ResizablePane`; render
  `<CanvasTimeline workspace={workspace} />` in `<main>` instead of `<ChatView>`.
  Mobile: canvas may fall back to chat (out of scope for polish).

## Shared model extraction (CANV-04, DEC-CANV-05)

Move from `conversation-tree.tsx` into `conversation-bursts.ts`, unchanged:
- `laneColor(id, alpha?)`, `tagColorOf(conv)`, `withAlpha(hex, alpha)`,
  `laneColorFor(conv, id, alpha?)`.
- `interface TreeEvent`, `interface Burst`.
- `buildEvents(lists: {c, messages}[]): TreeEvent[]` — the flatten + `created_at`
  parse + `updatedAt+seq` fallback + descending sort (NFR-3).
- `aggregateBursts(events): Burst[]` — the consecutive-run collapse.

`conversation-tree.tsx` imports these; its render/FLIP/lane-packing stay in place.
This guarantees the canvas's dots/colors equal the tree's (CANV-04) rather than
re-implementing them.

## CanvasTimeline component (`canvas-timeline.tsx`)

### Data (CANV-10, NFR-2, NFR-3)
- `conversations` from `listConversations(workspace)`; subscribe to
  `onConversationsUpdated` (same as sidebar/tree).
- On mount / conversations-change: `Promise.all(conversations.map(c =>
  getHistory(workspace, c, c.id === active)))` (reuses the cache; force only the
  active one). Build events with `buildEvents`, then `aggregateBursts`.
- Spinner only on workspace change (mirror the tree's `prevWsKey` guard) so
  refetches don't flash.
- **Fetch vs. render (NFR-2):** fetch is O(all conversations) through the cached
  `getHistory` (same as the tree; ships fine at "dozens") — the cap below bounds
  *drawing*, not the network. Do NOT lazy-fetch per window.
- **Stable-lane cap (NFR-2):** one lane per conversation, sorted by `firstT`,
  drawn on a stage as wide as the time range. Lanes **stay put**; paging is
  horizontal scroll (CANV-08), not a window filter. Bound total lanes with a
  `MAX_LANES` cap (same spirit as the tree's `MAX_LANE_COLUMNS`) and handle
  overflow gracefully (e.g. collapse the least-active beyond the cap) — lanes do
  not pop in/out as the user scrolls.

### Layout (CANV-03)
- Horizontal SVG stage, `min-width: max-content`, inside a scroll container.
- `xOf(t) = padL + ((t - tMin) / (tMax - tMin)) * innerW`.
- One lane per conversation, ordered by `firstT` asc; laneY = `padTop + i*laneH`.
- Per lane: a lifespan `<line>` (firstT→lastT) + a `<circle>` per burst at
  `xOf(burst.ts)`, `r = base + min(count,5)*k`, recent bursts scaled up slightly
  (CANV-04). Leaf `<text>` label (alias||title) at the lane tip.
- Axis: 4–5 ticks across `innerW` with `fmtDate` labels; faint dashed guides.
- Colors via `laneColorFor(convById.get(id), id)`.

### Agent pulse (CANV-05)
- Bucket every burst's `count` into `NBUCKETS` over `[tMin,tMax]`; area+line path
  (`<linearGradient>` accent fill), sharing `xOf`. A small strip above the lanes.

### Interaction (CANV-06, CANV-07)
- Hover a lane group → add `dimmed` to the others (CSS opacity), same idea as the
  tree's focus/dim.
- Click a lane → inline **preview** panel (title, `total msgs · bursts · last
  Nd ago`, last 2 bursts' user/agent lines). Actions:
  - **Solo**: `soloId` state → render only that lane; a "show all" clears it.
  - **Full transcript**: `setFragmentSid(id)` + `setView("chat")` → hands off to
    the traditional chat at that conversation.

### Header + time band + pagination (CANV-08)
- Header bar (mirrors chat-view's header height/border): `agent {r}` + the
  `Traditional | Canvas` segmented control (leaving Canvas here).
- Time band: visible range text + `‹ ›` buttons that `scrollBy`/shift the window;
  horizontal scroll enabled.

### Pixel-art background (CANV-09)
- CSS `repeating-linear-gradient` fine grid + stronger every-Nth cell on the
  stage container, using a brand-tinted low-alpha token so it reads in both
  themes (see the prototype's `--grid`/`--grid-strong`). Not an external image.

### Motion / a11y (NFR-4)
- Lifespan-line + pulse draw-in via `stroke-dasharray/offset` animation, gated on
  `@media (prefers-reduced-motion: no-preference)`; burst dots fade/scale in.
- Lanes are focusable buttons with visible focus; toggle is a real segmented
  control with `aria-pressed`.

## Toggle placement (CANV-01)
- **Enter Canvas** from `chat-view.tsx` header (add a `Traditional | Canvas`
  segmented control next to the secret/files icons — `cva` styled like the
  sidebar's `viewToggle`).
- **Leave Canvas** from `canvas-timeline.tsx` header (same control).
- Both call `setView(...)`. Keeping the control in each view's own header matches
  how `List | Tree` is owned by the sidebar.

## States / edges
- Empty workspace → empty state (`"No conversations yet."`).
- Loading → spinner (no flash on refetch).
- Missing/unparseable `created_at` → `updatedAt` fallback ordering (NFR-3).
- `prefers-reduced-motion` → animations off.

## Contract summary
- **Fragment:** adds optional `view` (`"canvas"`; absent = traditional). No other
  schema change. Shareable/reloadable.
- **No network/proxy/BFF contract change.** Reuses `GET /api/chat/[instance]/
  history` exactly as the tree does.

## Test / gate
- Webapp: `yarn build` (Next type-check) clean; `yarn test` (vitest) for any
  extracted-helper unit tests.
- Unit: `conversation-bursts.ts` — `buildEvents` ordering + `updatedAt` fallback;
  `aggregateBursts` run-collapse (move/extend coverage from existing tree logic).
- Manual: log in via magic-link; create an "A → B → A → C" pattern; toggle
  `Traditional → Canvas`; verify axis/lanes/dots/pulse, colors match the tree,
  hover-dim, click-preview, Solo, Full-transcript handoff, `‹ ›`/scroll paging,
  reload persistence (`view=canvas`), return to Traditional intact, empty state,
  and reduced-motion.

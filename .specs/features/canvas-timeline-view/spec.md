# canvas-timeline-view — Specification

## Summary

An alternative, graphics-forward presentation of a workspace's conversations: a
**Canvas** mode whose sole view is a left→right **Timeline**. Instead of reading
one chat top-down, the user sees every conversation as a horizontal lane on a
shared time axis, with activity **bursts** as dots (the same "pontinhos" and
per-conversation colors as the tree), an aggregate **agent-pulse** strip above,
and a pixel-art grid backdrop. The goal is to convey the agent's intelligence
**evolving over time**. Canvas is a workspace-level toggle that replaces the
history sidebar and the chat view; the user can return to the traditional chat
at any time. Pure visualization — no new relationships are stored.

## Grounding (verified in source, do not re-derive)

- Per-message `created_at` is **already surfaced end-to-end** (proxy `Message`,
  BFF `/api/chat/[instance]/history`) by [[conversation-tree-view]]; `getHistory`
  (`app/chat/history-cache.ts`) returns `HistoryMessage { role, content,
  created_at? }` and caches per conversation id (invalidated on `updatedAt`).
  ⇒ **No proxy/Go change is needed here.**
- The burst model already exists in `app/chat/conversation-tree.tsx`: flatten
  histories to time-sorted events, collapse consecutive same-conversation runs
  into visits/bursts; lane color via `laneColorFor` (tag color when set, else a
  golden-angle hash of the id). This is currently private to that file.
- Active conversation + workspace + view state live **only in the URL fragment**
  (`app/chat/fragment.ts`): `t/s/r/sid`, transient `msg` scroll anchor, and
  `hv` (history sidebar `list|tree`). `setFragmentSid(id, msg?)` navigates and
  can land the chat on a specific message.
- Layout shell (`app/chat/chat-shell.tsx`) mounts NavSidebar + (HistorySidebar +
  `<main>`) only when the fragment carries a workspace; sidebars are
  resizable/collapsible (persisted `"chat-sidebars"`).
- The traditional chat view (`app/chat/chat-view.tsx`) owns its own header bar
  (`agent {r}` + secret/files icons).
- `listConversations(workspace)` + `onConversationsUpdated` drive the live list;
  the sidebar already does an N-fetch of histories for content search
  (`history-sidebar.tsx`), so an N-fetch pattern is established and cached.

## Functional requirements

- **CANV-01** A workspace-level `Traditional | Canvas` toggle. Default is
  `Traditional` (unchanged behavior). The choice persists in the URL fragment
  (`view=canvas`), so reload / shared link keeps it, and is reachable from both
  modes (enter from the chat header; leave from the canvas header).
- **CANV-02** In Canvas mode the history sidebar **and** the chat view are
  replaced by a single full-width canvas in `<main>`; NavSidebar (workspace
  picker) stays. Switching back restores the sidebar + chat exactly as before.
- **CANV-03** The canvas renders a left→right **timeline**: a horizontal time
  axis (oldest left, newest right) with tick labels, and **one lane per
  conversation** (ordered by first activity). Each lane draws a lifespan line
  from its first to last burst and a **dot per burst** positioned at the burst's
  time; dot size scales with the burst's message count.
- **CANV-04** Bursts and per-conversation colors match the tree exactly — reuse
  the burst aggregation and `laneColorFor` (tag color when set, else golden-angle
  hash). Recent bursts read slightly larger/brighter (recency emphasis).
- **CANV-05** An **agent-pulse** strip above the lanes shows aggregate message
  volume bucketed over the same time range (an area chart), conveying activity
  accumulating over time. It shares the timeline's x-mapping.
- **CANV-06** Clicking a lane opens an inline **preview** (title, message count,
  last N messages — no full transcript inline) with two actions: **Solo**
  (isolate that single lane in the timeline) and **Full transcript** (leave
  Canvas → traditional chat opened at that conversation via `setFragmentSid`,
  setting `view` back to traditional).
- **CANV-07** Hovering a lane isolates it (others dim). "Solo" persists a single
  lane until cleared; an explicit "show all" clears it.
- **CANV-08** A **time band** header shows the range and offers `‹ ›` buttons
  plus horizontal scroll to page through time. Paging = horizontal scroll of a
  stable stage (matching the approved prototype); lanes do **not** appear/
  disappear as you scroll — one stable lane per conversation stays put (see
  NFR-2).
- **CANV-09** A **pixel-art quadriculado** background (fine grid + stronger
  every-Nth cell), theme-aware, sits behind the canvas.
- **CANV-10** Data is fetched only when Canvas is active (reuse the cached
  `getHistory` N-fetch) and refreshes on `chat-conversations-updated` (so an
  update from elsewhere reflects); entering Canvas triggers the fetch, Traditional
  mode adds no cost. Note: Canvas is **read-only** (no composer) — nothing
  generates new activity while it is open, so the live-refresh is a
  correctness/consistency guarantee, not a "live dashboard" claim.

## Non-functional requirements

- **NFR-1** Additive / backward-compatible: the traditional chat, the
  `List | Tree` sidebar toggle, and the fragment schema are unchanged except for
  an added optional `view` key. No proxy/Go/BFF change.
- **NFR-2** Bounded render, **stable lanes**: there is one lane per conversation
  (sorted by first activity), and lanes stay put — paging is horizontal scroll
  across the time axis (the approved prototype's model), NOT a window filter that
  makes lanes pop in/out. Render is bounded by a total `MAX_LANES` cap with
  graceful overflow (à la the tree's `MAX_LANE_COLUMNS`), and time-scroll only
  draws the stable stage. **Fetch vs. render:** history fetch is O(all
  conversations) via the cached `getHistory` N-fetch (same as the tree, ships at
  "dozens"); the cap bounds what is *drawn*, not the network. Must stay
  responsive with dozens of conversations.
- **NFR-3** Robust ordering: `created_at` is parsed to a comparable instant
  before sorting (never raw-string compared); missing/unparseable timestamps fall
  back to `updatedAt` ordering (as the tree does) and never crash the render.
- **NFR-4** Motion is `prefers-reduced-motion`-aware (lifespan-draw + pulse-draw
  disabled when reduced); keyboard focus visible; theme parity (light/dark).

## Out of scope

| Feature | Reason |
| --- | --- |
| Deck and Tree-by-metric canvas metaphors | Explored in the prototype; user chose Timeline only (DEC-CANV-01). |
| Full transcript rendered inside a lane/card | Preview only; full read hands off to the traditional chat (DEC-CANV-04). |
| Explicit forking / `parent_id` ancestry | Visualization only, same as [[conversation-tree-view]]. |
| Rename / delete / alias-tag editing inside Canvas | Stay in List mode (first cut). |
| Any proxy/picoclaw/transcript-write change | `created_at` already surfaced; webapp-only. |
| Mobile-optimized canvas | First cut targets desktop; mobile keeps traditional (canvas may be read-only/degraded). |

## User Stories

### P1: See conversations evolve on a timeline ⭐ MVP

**User Story**: As a user of a workspace, I want to switch to a Canvas timeline
that lays my conversations out over time, so I get a sense of how the agent's
work has evolved rather than reading one chat at a time.

**Why P1**: This is the whole feature — the alternative visualization and the
"intelligence evolving" impression.

**Acceptance Criteria**:
1. WHEN I toggle `Canvas` in a workspace THEN the system SHALL replace the
   history sidebar + chat view with a full-width timeline and set `view=canvas`
   in the URL.
2. WHEN the timeline renders THEN the system SHALL show a left→right time axis,
   one lane per conversation with a lifespan line and burst dots colored per
   conversation (same colors as the tree), and an agent-pulse strip above.
3. WHEN I reload or share the URL THEN the system SHALL restore Canvas mode.
4. WHEN I toggle `Traditional` THEN the system SHALL restore the sidebar + chat
   unchanged.
5. WHEN a conversation has no/unparseable `created_at` THEN the system SHALL
   order it by `updatedAt` and still render (no crash).

**Independent Test**: Log in, open a workspace with a few conversations, toggle
Canvas → see lanes/dots/pulse; reload → still Canvas; toggle back → chat intact.

### P2: Preview and drill into a single conversation

**User Story**: As a user, I want to click a lane to preview it and optionally
isolate or open it, so the timeline is a way in, not just a picture.

**Acceptance Criteria**:
1. WHEN I click a lane THEN the system SHALL show an inline preview (title, count,
   last N messages) with Solo and Full-transcript actions.
2. WHEN I choose Solo THEN the system SHALL show only that lane until I clear it.
3. WHEN I choose Full transcript THEN the system SHALL leave Canvas and open the
   traditional chat at that conversation (`setFragmentSid`).

**Independent Test**: Click a lane → preview; Solo → one lane; Full transcript →
traditional chat on that conversation.

### P3: Page through time without overloading

**User Story**: As a user with many conversations, I want the canvas to stay
responsive, paging through time rather than rendering everything.

**Acceptance Criteria**:
1. WHEN a workspace has more activity than the visible window THEN the system
   SHALL bound what is rendered and reveal more via `‹ ›`/scroll.
2. WHEN I page/scroll THEN the time band SHALL reflect the visible range.

**Independent Test**: With dozens of conversations, the canvas stays smooth and
paging reveals older activity.

## Edge Cases

- WHEN a workspace has zero conversations THEN the canvas SHALL show an empty
  state (reuse the `"No conversations yet."` pattern).
- WHEN a conversation has one burst THEN its lane SHALL render a single dot (a
  minimal lifespan line).
- WHEN histories are still loading THEN the canvas SHALL show a spinner without a
  layout flash on refetch (mirror the tree's spinner-only-on-workspace-change).
- WHEN `prefers-reduced-motion` is set THEN draw/pulse animations SHALL be off.
- WHEN a shared `view=canvas` URL is opened on mobile THEN the system SHALL
  ignore the `view` key and render the Traditional chat (canvas is desktop-only
  first cut) — never a broken/garbage canvas.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| CANV-01 | P1 | T03/T08 | Implementing (runtime unverified) |
| CANV-02 | P1 | T04 | Implementing (runtime unverified) |
| CANV-03 | P1 | T05 | Implementing (runtime unverified) |
| CANV-04 | P1 | T01/T05 | Implementing (runtime unverified) |
| CANV-05 | P1 | T06 | Implementing (runtime unverified) |
| CANV-06 | P2 | T07 | Implementing (runtime unverified) |
| CANV-07 | P2 | T07 | Implementing (runtime unverified) |
| CANV-08 | P3 | T08 | Implementing (runtime unverified) |
| CANV-09 | P1 | T09 | Implementing (runtime unverified) |
| CANV-10 | P1/P3 | T04 | Implementing (runtime unverified) |

**ID format:** `CANV-NN`. **Status:** Pending → In Design → In Tasks →
Implementing → Verified.

## Success Criteria

- [ ] A user can enter Canvas, read the timeline, and return to chat in one click.
- [ ] Burst dots and colors are visually identical to the tree view.
- [ ] Canvas mode adds zero fetch/render cost while in Traditional mode.
- [ ] The canvas stays responsive with dozens of conversations (bounded window).
- [ ] Light/dark parity and reduced-motion honored.

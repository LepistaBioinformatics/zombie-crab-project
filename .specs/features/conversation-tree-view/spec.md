# conversation-tree-view — Specification

## Summary

An optional **Tree view** for the chat conversation sidebar. Alongside the
default recency-ordered list, the user can switch to a vertical timeline where
each conversation is a colored lane and each *visit* (a burst of consecutive
same-conversation messages) is a node, ordered by time (most recent on top =
HEAD). It surfaces the interleaving pattern of real usage
(start a chat, start another, return to the first) as a git-graph-like spine —
reconciling the agent's continuous per-session transcript with the web's
recency-first list. Pure visualization; no new relationships are stored.

## Grounding (verified in source, do not re-derive)

- Conversations are **flat and recency-ordered** — `listConversationsForWorkspace`
  returns `ORDER BY c.updated_at DESC` (`webapp/lib/db.ts`). There is **no**
  `parent_id`, `created_at`, or any conversation-to-conversation linkage column.
- Each conversation maps 1:1 to an append-only `durable/<sessionKey>.jsonl`
  (`crab-shell-proxy/internal/history/history.go`). Lines carry `role`,
  `content`, and `created_at` (`dedupKey`, `CONTEXT_RECOVERY.md`). `readMessages`
  currently returns only `role`/`content` (`created_at` is dropped).
- History reaches the front via `GET /api/chat/[instance]/history` → mycelium →
  proxy `handleSessionsHistory` → `history.Read`. The BFF route returns
  `data.messages` verbatim (extra fields survive at runtime).
- The sidebar (`webapp/app/chat/history-sidebar.tsx`) already does an N-fetch
  over all conversations' histories for full-content search. Active-conversation
  selection lives in the URL fragment via `setFragmentSid` (`app/chat/fragment.ts`).
- View-mode persistence pattern exists: booleans hydrated from `localStorage`
  (`"chat-sidebars"`, `"chat-files-open"`).

## Functional requirements

- **FR-1** The sidebar exposes a `List | Tree` toggle in its header. Default is
  `List` (current behavior). The chosen mode persists across reloads
  (localStorage), per the existing view-state pattern.
- **FR-2** In `Tree` mode the conversation list is replaced by a single vertical
  spine: one node per **visit** (a run of consecutive same-conversation messages
  with no other conversation's message between them in time) across all
  conversations in the current workspace, ordered by the visit's most-recent
  `created_at` descending (most recent on top). Each node shows the **message
  exchanged at that point** (the visit's most-recent message content), time, and
  message count; the conversation identity is carried by the lane color/rail
  (title stays as the row tooltip).
- **FR-3** Each conversation has a **stable color** (derived from its id) used for
  its dots and a thin left rail, so a conversation's messages are visually
  trackable down the spine (the lane/git-graph effect).
- **FR-4** The single most-recent message overall is marked as **HEAD** (matching
  the approved preview). Each dot shows the conversation's alias/title and the
  message time.
- **FR-5** Clicking a node opens that conversation via `setFragmentSid` — the same
  navigation the list mode uses. The main chat view switches accordingly.
- **FR-5b** Clicking a node also **scrolls the chat to that exact message** (the
  one shown on the node), not to the end — via a transient `msg` fragment anchor
  (the message's `created_at`) that the chat view consumes once and strips.
  Ordinary List-mode navigation (no anchor) still lands on the most recent
  message.
- **FR-6** Turn timestamps are surfaced end-to-end: the proxy's history response
  includes `created_at` per message; the BFF passes it through.
- **FR-7** Data for the spine is fetched only when Tree mode is active (reusing
  the existing per-conversation history fetch), cached per workspace, and
  refreshed on `chat-conversations-updated`.

## Non-functional requirements

- **NFR-1** Additive and backward-compatible: adding `created_at` to the proxy
  `Message` and the BFF type breaks no existing consumer; the List mode is
  unchanged.
- **NFR-2** Robust ordering: `created_at` is parsed to a comparable instant
  before sorting; unparseable/empty values do not crash the render (their dots
  are skipped, or the conversation falls back to file order).
- **NFR-3** Rendering fits the current sidebar width — a compact spine with a
  bounded number of visible lane rails; it is not a full DAG canvas.
- **NFR-4** No extra cost in List mode: the N-fetch only runs on entering Tree
  mode, and is cached.

## Out of scope

- Explicit forking / "continue from here as a new conversation" and any
  `parent_id` ancestry (a genuine tree topology) — deferred; this is
  visualization only (CTX-CTV-01).
- Search, rename, delete, and alias/tag editing inside Tree mode — those stay in
  List mode for the first cut (Tree hides the search box).
- A wide dedicated canvas / multi-column gitk-style panel (CTX-CTV-02).
- Deep-linking to a specific message/turn within a conversation (a dot opens the
  conversation, not a scroll position).
- Any change to how transcripts are written or to picoclaw itself.

# conversation-tree-view — Design & Contract

Decisions: **CTX-CTV-01** visualization only (no parent_id/fork). **CTX-CTV-02**
inside sidebar, single vertical spine. **CTX-CTV-03** one node per visit (burst).
**CTX-CTV-04** premise gate on `created_at` (fallback: one node per conversation).
**CTX-CTV-05** reuse the existing history N-fetch.

## Data source — surface `created_at` end-to-end

### Proxy (`crab-shell-proxy/internal/history/history.go`)
- Add `CreatedAt string \`json:"created_at"\`` to `Message` (~line 13) and to
  `jsonlEntry` (~line 31).
- In `readMessages` (~line 184), populate `CreatedAt` from the parsed line.
  Additive: pre-existing lines without `created_at` yield "" — the front treats
  "" as "no timestamp" and skips that dot.
- `handleSessionsHistory` (`internal/httpapi/handlers.go`) serializes
  `history.Message` directly, so the field flows through with no further change.
- Update `internal/history/history_test.go` to assert `CreatedAt` round-trips.

### BFF (`webapp/app/api/chat/[instance]/history/route.ts`)
- Extend `HistoryResponse` to `{ role: string; content: string; created_at?: string }`.
  The route already returns `data.messages` verbatim; only the type needs to
  follow so front consumers see the field.

## Front (`webapp/app/chat/history-sidebar.tsx`)

### View toggle + persistence
- New state `view: "list" | "tree"`, hydrated once from `localStorage`
  (`"chat-history-view"`) and re-persisted on change — same pattern as
  `filesOpen`/`"chat-files-open"` (`chat-view.tsx`) and `"chat-sidebars"`
  (`chat-shell.tsx`).
- Segmented `List | Tree` control in the sidebar header (`List` / `GitBranch`
  icons from `lucide-react`), styled with `cva` per the existing convention
  (`conversationRow`, `scope-tree.tsx` `nodeButton`).

### Turn collection (only when `view === "tree"`)
- Reuse the full-content-search N-fetch pattern (`history-sidebar.tsx` lines
  ~91–132): `listConversations(workspace)` then, per conversation,
  `fetch(/api/chat/${role}/history?${historyQuery(workspace, id)})`.
- Trigger only when Tree mode is active; cache in memory per workspace; react to
  `onConversationsUpdated`.
- Flatten to message events `{ conversationId, label, ts, seq }` (one per
  `user`/`assistant` line). Parse `createdAt` to a comparable instant (do NOT
  sort raw strings unless confirmed uniform ISO-8601/UTC) and sort **descending**.
  Cross-conversation ordering is the whole point — mixed formats would silently
  corrupt it.
- **Aggregate into visits (bursts):** collapse maximal runs of consecutive
  same-conversation events (adjacent in the sorted list ⇒ no other conversation
  between them in time) into one node `{ conversationId, label, ts, count }`,
  `ts` = the run's most-recent event. The rendered unit is the burst, not the
  message (CTX-CTV-03) — keeps the interleaving without a dot per message.

### Spine render
- Single vertical column at the current sidebar width. Reuse the indented-tree
  aesthetic from `app/admin/scope-tree.tsx` (`ml-[15px] border-l border-brand/25
  pl-2`) and the semantic tokens (`bg-surface`, `text-fg`, `text-fg-muted`,
  `bg-accent`).
- Stable per-conversation color (hash of `id` → small palette) on the dot and a
  thin left rail so a conversation's lane is trackable down the spine.
- Each node: conversation alias/title + time + message count (`·N` when > 1);
  the single most-recent visit overall marked `HEAD`. Click →
  `setFragmentSid(conversationId)`.
- Multi-lane rails kept compact and bounded (e.g. up to ~4–5 visible rail
  columns; conversations beyond that share a rail by color rather than a
  dedicated column) so it fits the narrow width — the goal is readability, not a
  full DAG.

### States / edges
- Conversation with no resolved transcript / no `created_at` → no dots (silently
  skipped).
- Malformed / missing `created_at` line → skip that dot.
- Empty spine → empty-state message (reuse the `"No conversations yet."` pattern).
- Tree mode hides the search box; `ConversationEditor`/rename/delete stay in List
  mode only (first cut).

## Fallback (if T0 shows `created_at` is not a comparable instant)
- Degrade to **one node per conversation** positioned by `updated_at` (already in
  `ConversationSummary`), with a birth marker if a per-conversation creation time
  is obtainable. No N-fetch, no proxy change required. Same toggle, spine, colors,
  and click-to-open.

## Contract summary
- Proxy history message JSON: `{ "role": string, "content": string,
  "created_at": string }` (`""` when absent).
- BFF `/api/chat/[instance]/history` response: `{ "messages": Message[] }` with
  `Message` gaining optional `created_at`.

## Test / gate
- **T0 (before build):** inspect a real `durable/<key>.jsonl` from the running
  stack — confirm `created_at` is present on `user`/`assistant` lines and is a
  comparable wall-clock instant across sessions. If not → take the fallback.
- Proxy: `go test ./internal/history/...`; `go build ./...`.
- Webapp: `yarn build` (Next type-check) — no type errors in the history route or
  the sidebar.
- Manual: log in via magic-link; create conversations in an "A → B → A → C"
  pattern; toggle `List → Tree`; verify time-ordered dots, HEAD marking,
  per-conversation color/rail, click-to-open, return to List, persistence across
  reload, and that missing-transcript/missing-`created_at` cases don't break the
  render.

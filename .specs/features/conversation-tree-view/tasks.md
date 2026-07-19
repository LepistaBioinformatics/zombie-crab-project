# conversation-tree-view Tasks

Cross-submodule (proxy Go + webapp Next). Gates: proxy `go test ./internal/history/...`
+ `go build ./...`; webapp `yarn build`. Runtime: log in via magic-link, create an
"A → B → A → C" usage pattern, toggle List → Tree. `[P]` = parallelizable.

---

## T0 — Premise gate (before any build) — CTX-CTV-04
- **What:** bring up the stack (docker-compose), exchange a few messages across
  2–3 conversations, then inspect a real
  `.../workspace/sessions/durable/<sessionKey>.jsonl` on disk / in the container.
- **Done when:** confirmed that `user`/`assistant` lines carry a `created_at`
  that is a comparable wall-clock instant across sessions. If NOT → switch to the
  fallback (one node per conversation by `updated_at`; skip T01/T02).
- **Depends on:** —

## Proxy (Go — `crab/crab-shell-proxy`)

### T01 — surface `created_at` in history — FR-6
- **What:** add `CreatedAt string \`json:"created_at"\`` to `history.Message` and
  `jsonlEntry`; populate it in `readMessages`. Additive/back-compat ("" when
  absent).
- **Done when:** `history.Read`/`readMessages` return `created_at`; existing
  role/content filtering unchanged. **Depends on:** T0

### T02 — history test coverage — FR-6 [P after T01]
- **What:** extend `internal/history/history_test.go` to assert `CreatedAt`
  round-trips from the durable and live files.
- **Done when:** `go test ./internal/history/...` green; `go build ./...` green.
  **Depends on:** T01

## Webapp (Next — `crab/crab-exoskeleton-webapp`)

### T03 — BFF type passthrough — FR-6 [P after T01]
- **What:** extend `HistoryResponse` in `app/api/chat/[instance]/history/route.ts`
  to `{ role, content, created_at? }`. Route already returns `data.messages`
  verbatim.
- **Done when:** front consumers see `created_at`; `yarn build` green.
  **Depends on:** T01

### T04 — view toggle + persistence — FR-1
- **What:** `view: "list" | "tree"` state in `history-sidebar.tsx`, hydrated from
  `localStorage` (`"chat-history-view"`), re-persisted on change; segmented
  `List | Tree` control in the header (`List`/`GitBranch` icons, `cva`).
- **Done when:** toggle flips the sidebar body; choice survives reload; List mode
  unchanged. **Depends on:** —

### T05 — event collection + burst aggregation + cache — FR-7, NFR-2, NFR-4
- **What:** on entering Tree mode, N-fetch histories (reuse the search pattern),
  flatten to message events, parse `createdAt` to a comparable instant, sort
  desc, then collapse consecutive same-conversation runs into visit nodes
  (`{ conversationId, label, ts, count }`); cache per workspace; refresh on
  `chat-conversations-updated`.
- **Done when:** entering Tree builds a correct time-ordered burst list; List mode
  triggers no fetch; unparseable/empty timestamps are skipped without crashing.
  **Depends on:** T03, T04

### T06 — spine render + navigation — FR-2..FR-5, NFR-3
- **What:** vertical spine (reuse `scope-tree.tsx` indentation + semantic tokens);
  stable per-conversation color on node + thin left rail (bounded lane count);
  alias/title + time + `·N` count per node; single HEAD on the most-recent visit;
  click → `setFragmentSid`. Hide the search box in Tree mode; keep rename/delete/
  editor in List mode.
- **Done when:** visit nodes interleave by time with HEAD on top, lanes are
  trackable by color, click opens the right conversation, empty state renders.
  **Depends on:** T05

---

## Fallback path (only if T0 fails)
- Skip T01/T02/T03. In T05, build one event per conversation from the existing
  `ConversationSummary.updatedAt`; T06 renders one node per conversation. Same
  toggle/colors/click-to-open.

# conversation-tree-view — Context & Decisions

## Why

picoclaw agents (instances `alpha`/`beta`) run in `mode: "continuous"` and
perceive **one append-only transcript per session** (`durable/<sessionKey>.jsonl`)
that never reorders. The web app presents each session as a separate conversation
and orders the sidebar list by **recency** (`conversations.updated_at DESC`). Two
mismatched views of the same reality.

This feature adds an **optional "Tree" view mode** in the conversation sidebar
that reconciles both: a vertical timeline where each conversation is a colored
"lane" and each message is a dot. The git-branch-tree *look* comes from activity
hopping between lanes over time (start A → go to B → return to A → C), not from
any real ancestry.

## Decisions

- **CTX-CTV-01 — Visualization only.** No `parent_id`, no "branch/fork" action,
  no change to agent behavior. The tree topology is derived purely from the
  per-message timestamps that already exist in the transcripts. There are **no
  real divergence points** — parallel tracks over a shared time axis. (User
  choice: "raias por tempo" over "explicit fork".)
- **CTX-CTV-02 — Inside the sidebar.** Rendered as a single vertical spine inside
  the existing `history-sidebar.tsx`, toggled by a `List | Tree` control in the
  header. NOT a wide dedicated canvas/modal. (User choice.)
- **CTX-CTV-03 — One node per visit (burst).** A node is a *visit*: a run of
  consecutive same-conversation messages with no other conversation's message
  between them in time. Returning to a conversation makes a NEW node, so the
  interleaving (A → B → A) stays visible without a dot per message. Node shows
  title + time + message count. (Superseded the initial "one dot per message",
  which the user found too verbose; per-message timestamps are still the data
  source — the burst is a front-side aggregation, no pipeline change.)
- **CTX-CTV-04 — Premise gate (created_at).** The per-message mode depends on
  picoclaw's jsonl carrying a **comparable wall-clock `created_at`** per line.
  Field existence is confirmed in source (`history.go` `dedupKey` reads it;
  `docker/managed/memory/CONTEXT_RECOVERY.md` documents `role`/`content`/
  `created_at` per line). The exact format (ISO-8601/UTC vs opaque) is picoclaw
  upstream (`sipeed/picoclaw`, not in this repo) and MUST be verified against a
  real transcript before building (see tasks T0). **Fallback** if the value is
  absent/sparse/unparseable: degrade to **one node per conversation** positioned
  by `updated_at` (already available), which needs no per-turn timestamps.
- **CTX-CTV-05 — Reuse the existing history fetch.** Turn timestamps are gathered
  by the same N-fetch pattern the full-content search already uses
  (`history-sidebar.tsx`): `listConversations` + per-conversation
  `GET /api/chat/<role>/history`. Fetch only when Tree mode is active; cache per
  workspace; refresh on `chat-conversations-updated`.

- **CTX-CTV-06 — Nodes show the message, not the chat name.** Each node renders
  the content of the visit's most-recent message; the conversation identity is
  carried by the lane color/rail (title in the tooltip). (User request.)
- **CTX-CTV-07 — Click scrolls to the message.** Clicking a node scrolls the chat
  to that exact message via a transient `msg` fragment anchor (the message's
  `created_at`), consumed once and stripped, instead of jumping to the end.
  (User request.) Lane packing recycles columns (git-graph style) with
  golden-angle per-conversation colors so many conversations don't exhaust lanes
  or collide on color (replaced the initial fixed 4-lane / 8-color cap).
- **CTX-CTV-08 — Composer owns the draft text (perf).** The chat input state was
  lifted in `chat-view.tsx`, so every keystroke re-rendered the whole message
  list (markdown per message). Moved the draft state into `composer.tsx`;
  `onSend(text)` returns whether the send was accepted so the composer clears
  itself. `sendMessage` now runs its guard + optimistic UI synchronously and the
  network turn in a detached async IIFE. Typing no longer re-renders ChatView.

- **CTX-CTV-09 — Live update on send.** `touchConversation` already fires the
  `chat-conversations-updated` event at send time (recency bump), but a turn
  *completing* doesn't advance `updated_at`, so the tree's updatedAt-keyed cache
  wouldn't refetch the final reply. `chat-view.tsx` now calls
  `notifyConversationsUpdated()` after the turn completes, and the tree bumps a
  `tick` on that event and **force-refetches the active conversation** (bypassing
  the updatedAt cache). Refetches keep the current spine visible (no spinner
  flash); only a workspace change resets to the spinner.
- **CTX-CTV-10 — Animated nodes.** New nodes fade/slide in and reordered rows
  slide to their new positions via a FLIP pass (Web Animations API in a
  `useLayoutEffect`, measuring `offsetTop` before/after), honoring
  `prefers-reduced-motion`. Nodes are keyed by conversation + the visit's oldest
  message (`startAnchor`) so a growing visit updates in place instead of
  remounting; the initial populated render doesn't animate.

- **CTX-CTV-11 — Alias/tags everywhere + tag color in the tree.** `TagChip` and
  the alias/tag editor (`ConversationEditor`) were extracted to
  `app/chat/conversation-enrichment.tsx` and are now used by both the list and
  the tree. Display: an alias shows as the primary name with the auto title
  below it in smaller muted type (list); in the tree the node keeps the **message
  as primary** with `alias · title` as the muted identity line beneath, then tag
  chips (user chose message-primary for the tree). A conversation's **tag color**
  becomes its **lane/dot/rail color** in the tree (falling back to the
  golden-angle hash when no tag color). Alias + tags are editable from the tree
  via the same editor (a per-node Tags action), propagated through an `onApply`
  prop wired to the sidebar's `applyToLists`.

## Scope note

"openclaw" and "hermes" do not exist in this repo — only picoclaw. "hermes" is
the name of the stateless/scale-to-zero architecture pattern, not an agent here.
This feature targets picoclaw only.

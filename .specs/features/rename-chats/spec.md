# rename-chats Specification

**Scope: Medium** (chat-webapp only). Brief spec — design/tasks implicit.

## Problem Statement

Conversations get an auto-title from their first message (`upsertConversationRow`
sets `title`); the user cannot change it. The conversations sidebar
(`app/chat/history-sidebar.tsx`) shows those titles read-only. Users want to
rename a chat to something meaningful.

## Goal

- [ ] Let a user rename one of their own conversations from the conversations
      sidebar; the new title persists and shows everywhere the title is used.

## Out of Scope
| Item | Reason |
| --- | --- |
| Renaming the picoclaw session / affecting history | Title is chat-webapp metadata only |
| Renaming another user's conversation | Owner-scoped (by session email) |
| Auto-title changes | The first-message auto-title behavior stays |

---

## Requirements (traceable)

| ID | Requirement |
| --- | --- |
| RC-01 | A rename action per conversation in `history-sidebar.tsx` (e.g. inline edit / menu → rename) with an editable title field. |
| RC-02 | A dedicated rename API — distinct from the existing "message-sent" `PATCH` (which upserts + sets the first-message title). Either a `title`-only branch or a new method/route; it MUST NOT be conflatable with the recency-bump path. |
| RC-03 | A db helper `renameConversation(id, email, title)` that UPDATEs the title **owner-scoped by `email`** (a user can only rename their own; a non-owner id is a no-op / 404, never renames another's). |
| RC-04 | Title validation: non-empty after trim, reasonable max length; reject empty/whitespace (`400`), don't persist blanks. |
| RC-05 | On success the sidebar reflects the new title immediately (optimistic or refetch); on failure show the real error and keep the old title. |
| RC-06 | `className` via class-variance-authority variants (project convention). |

## Acceptance / Success Criteria
- [ ] A user renames a conversation; the new title shows in the sidebar and
      survives reload.
- [ ] Renaming does not disturb the conversation's messages/session or recency.
- [ ] An empty title is rejected; another user's conversation cannot be renamed.
- [ ] `next build` green.

## Notes
- Reuse the `email`-scoped ownership already used by `listConversationsForWorkspace`
  / `upsertConversationRow`. `history-sidebar.tsx` is recent front work (another
  agent) — coordinate on implementation.

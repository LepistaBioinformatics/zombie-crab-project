# conversation-enrichment — Specification

## Summary

Enrich chat-webapp conversations at the postgres level and tighten the link
between the front (postgres conversation rows) and the proxy (on-disk picoclaw
session files):

1. **Alias** — a user-set alternative display name per conversation.
2. **Tags** — a list per conversation; each tag has a name, an optional value,
   and a JSON `metadata` blob (colors, descriptions, arbitrary front hints).
3. **Session linkage** — the proxy exports the session identifiers behind a
   conversation (the deterministic `sessionKey` and picoclaw's on-disk file
   basename); both are stored in postgres so a conversation row points at the
   exact proxy/picoclaw transcript.

All three are stored in postgres and surfaced so the sidebar renders enriched
conversations (alias over title, colored tag chips).

## Grounding (verified in source, do not re-derive)
- The proxy passes `sessionKey = sha256(accId + "::" + session_id)[:32]`
  (`identity.SessionKey`) to picoclaw as the session id. picoclaw writes its own
  opaque file basename and a `<basename>.meta.json` whose `scope.values.chat` =
  `direct:pico:<sessionKey>` (`internal/history/history.go` `findMeta`). So the
  literal "id in the file name" is that **basename**, resolvable from the
  `sessionKey` marker; the `sessionKey` itself is deterministic and known
  immediately.
- Conversations table today: `id, email, instance, tenant_id, subs_acc_id,
  title, updated_at` (`webapp/lib/db.ts`). Rows are owner-scoped by `email`.

## Functional requirements

### Alias
- **FR-1** A user can set/clear an **alias** on their own conversation. Empty
  alias clears it. Owner-scoped (an alias write on another account's id changes
  nothing). Alias does not disturb recency ordering (like rename).
- **FR-2** The sidebar shows `alias` when set, else `title`.

### Tags
- **FR-3** A user can add/update/remove **tags** on their own conversation. A
  tag = `{ name, value?, metadata }` where `metadata` is arbitrary JSON
  (e.g. `{ "color": "#e11", "description": "..." }`). Tag name is unique per
  conversation (upsert by name). Owner-scoped.
- **FR-4** Tags are stored in a normalized `conversation_tags` table (decision
  CTX-CE-01), cascade-deleted with the conversation.
- **FR-5** The sidebar renders each conversation's tags as chips, colored from
  `metadata.color` when present, with `metadata.description`/`value` available
  to the front.

### Session linkage
- **FR-6** The proxy exposes an endpoint that resolves, for a conversation the
  caller owns, `{ sessionKey, sessionFile }` — `sessionKey` always present,
  `sessionFile` the picoclaw basename or empty if not written yet.
- **FR-7** The webapp stores both on the conversation row (`session_key`,
  `session_file`); `session_file` is updated once it becomes available. Storing
  is owner-scoped.
- **FR-8** The enriched conversation payload (list) includes `alias`, `tags`,
  `sessionKey`, `sessionFile` so the front has everything in one fetch.

## Non-functional requirements
- **NFR-1** Every write (alias, tags, session refs) is **owner-scoped** by the
  session email — mirroring the existing `renameConversation`/`deleteConversationRow`
  guards; a non-owner id affects zero rows.
- **NFR-2** Schema changes are additive (`ADD COLUMN IF NOT EXISTS`, `CREATE
  TABLE IF NOT EXISTS`) so pre-existing rows survive, consistent with the
  current migration style.
- **NFR-3** The proxy resolve endpoint enforces the same account-switching guard
  as `/v1/sessions/history` and never exposes another user's session.

## Out of scope
- Deleting/reading picoclaw transcripts (the proxy still exposes no
  session-delete; resolve is read-only metadata).
- Tag taxonomies shared across conversations / tag autocomplete from other rows
  (tags are per-conversation in v1).
- Filtering/searching conversations by tag (storage is normalized to allow it
  later, but no query endpoint in v1).

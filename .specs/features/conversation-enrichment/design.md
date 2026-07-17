# conversation-enrichment — Design & Contract

Decision **CTX-CE-01**: tags in a normalized `conversation_tags` table (user
choice). **CTX-CE-02**: export BOTH session ids. **CTX-CE-03**: full-stack incl.
front UI (coordinate with concurrent front agents — prefer additive edits).

## Postgres (`webapp/lib/db.ts`)

Additive migration in `ensureSchema()`:
```sql
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS alias TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_key TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_file TEXT;
CREATE TABLE IF NOT EXISTS conversation_tags (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (conversation_id, name)
);
CREATE INDEX IF NOT EXISTS conversation_tags_conv_idx ON conversation_tags (conversation_id);
```

Types + functions:
```ts
interface Tag { name: string; value: string | null; metadata: Record<string, unknown>; }
// ConversationRow gains: alias: string | null; tags: Tag[]; sessionKey: string | null; sessionFile: string | null;

setAlias(id, email, alias: string | null): Promise<boolean>        // '' → NULL; owner-scoped
upsertTag(id, email, tag: Tag): Promise<boolean>                   // owner-scoped via EXISTS(conversations WHERE id AND email)
deleteTag(id, email, name): Promise<boolean>                        // owner-scoped
setSessionRefs(id, email, sessionKey, sessionFile: string | null): Promise<boolean>
```
`listConversationsForWorkspace` returns the enriched rows: LEFT JOIN + aggregate
tags (e.g. `json_agg`) so one query yields alias/tags/session refs. Keep the
existing `title <> 'New chat'` filter and recency order.

Owner-scoping for tags (table has no email): gate every tag write on
`WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id = $1 AND c.email = $2)`.

## Proxy (`crab-shell-proxy`)

New `GET /v1/sessions/resolve` in `internal/httpapi/handlers.go`, modeled on
`handleSessionsHistory` (same resolveAgent + profile + account-switching guard +
`tenant_id`/`subs_acc_id`/`session_id` params):
- `sessionKey := identity.SessionKey(ident.AccID, session_id)`
- `sessionFile := history.FindSessionFile(sessionsDir, sessionKey)` — export the
  existing `findMeta` logic as `history.FindSessionFile(sessionsDir, sessionKey) string`
  (basename without extension, or "").
- Response: `{ "sessionKey": "...", "sessionFile": "..."|"" }`.
- Register in `Handler()` and add the route to `mycelium/config.standalone.toml`
  mirroring the existing `/v1/sessions/history` block for each agent.

## Webapp BFF (`webapp/app/api`)

- `PUT /api/conversations/[id]/alias` — body `{ alias: string }` → `setAlias`.
  (Empty string clears.) 400 on missing body; 404 if not owner.
- `GET|POST|DELETE /api/conversations/[id]/tags`
  - `GET` → `{ tags: Tag[] }`
  - `POST` body `{ name, value?, metadata? }` → upsert; 400 if no `name`.
  - `DELETE ?name=` → remove; 400 if no `name`; 404 if not owner.
- `POST /api/conversations/[id]/session` — body `{ tenant_id, subs_acc_id, role,
  session_id }`. BFF calls the proxy `GET /v1/sessions/resolve` (session JWT,
  through a `picoclaw-<role>` service like the existing chat/history BFF), then
  `setSessionRefs`, returns `{ sessionKey, sessionFile }`. Owner-scoped store.

All routes: session cookie required (401 `session_expired`), owner-scoped writes
(404 `not_found` when zero rows), mirror the existing `[id]/route.ts` style.

## Front (`webapp/app/chat`)

- `lib/chatSession.ts`: `ConversationSummary` gains `alias`, `tags: Tag[]`,
  `sessionKey`, `sessionFile`; `fromApiRow` maps them. New client fns:
  `setAlias(id, alias)`, `upsertTag(id, tag)`, `deleteTag(id, name)`,
  `syncSessionRefs(workspace, id)` (POSTs `/session`).
- `chat-view.tsx`: after a turn's stream completes, call `syncSessionRefs` so the
  proxy session ids land in postgres (best-effort, swallow errors).
- `history-sidebar.tsx`: show `alias || title`; render tag chips colored from
  `metadata.color`; extend the existing per-row menu (near rename) with an
  **alias editor** and a **tag manager** (add name/value/color, remove). Reuse
  `Input`/`Button`/`IconButton`/`Badge`/`ConfirmDialog`; `className` via cva.
  Keep edits additive — other agents are in these files.

## Contract summary (both streams honor exactly)
- `Tag` JSON: `{ "name": string, "value": string|null, "metadata": object }`.
- Enriched conversation row JSON (list + fromApiRow): existing fields +
  `"alias": string|null, "tags": Tag[], "sessionKey": string|null,
  "sessionFile": string|null`.
- Proxy resolve: `{ "sessionKey": string, "sessionFile": string }` (file "" when
  not yet written).

## Test / gate
- Proxy: extend `history` tests for `FindSessionFile`; `docker build --network=host`.
- Webapp: `next build` (or `yarn tsc --noEmit` if another agent's WIP breaks the
  full build on files this feature didn't touch).

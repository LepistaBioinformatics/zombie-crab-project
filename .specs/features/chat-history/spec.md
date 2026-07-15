# Chat History Specification

**Scope**: Medium -- clear feature, ~6 steps across 3 components, no open research questions
(session file format was verified directly on disk before writing this spec). Design captured
inline here rather than a separate design.md.

## Problem Statement

`chat-webapp`'s conversation view always starts empty -- reloading the page or reopening an
instance loses everything, even though picoclaw already persists the full transcript to disk
(`data/<instance>/workspace/sessions/sk_v1_<hash>.jsonl`). There's no way for the browser to see
that history; it isn't exposed through the OpenAI-compatible surface at all.

## Verified Facts (read directly off a real session, not assumed)

- `picoclaw-openai-proxy`'s container already has the picoclaw data directory mounted
  (`${PICOCLAW_ALPHA_DATA_DIR}:/root/.picoclaw:ro`), so it can read session files directly --
  no new picoclaw-side API needed.
- The proxy's own `sessionIdFor(email, session_id)` (32-hex sha256 slice) is NOT the session
  file's on-disk name -- picoclaw re-hashes it into a 64-hex `sk_v1_<hash>` filename. The
  *link* between the two is `<hash>.meta.json`'s `scope.values.chat` field, which literally
  contains `"direct:pico:<our-32-hex-sessionIdFor-output>"` (confirmed by reading a real
  `.meta.json`). So: locate the file by scanning `.meta.json`s for that value, not by
  recomputing picoclaw's filename hash.
- `.jsonl` lines are already `{"role": "user"|"assistant", "content": "...", ...}` -- a direct
  match for the chat UI's `ChatMessage` shape, no transformation needed beyond picking two
  fields per line.
- `chat-webapp`'s conversation page currently generates a **fresh** `session_id` on every mount
  (`crypto.randomUUID()` in a `useEffect` keyed on `instance`) -- for history to ever be
  non-empty, the session_id must persist across reloads. This spec includes that persistence;
  without it, the history endpoint would always return an empty conversation.

## User Stories

### P1: See prior messages when reopening a conversation

**As a** signed-in user, **I want** to see my previous messages when I come back to an
instance's chat, **so that** the conversation doesn't reset every time I reload the page.

**Acceptance Criteria**:
1. WHEN the user opens `/chat/{instance}` and a `session_id` for that instance was already
   used before (persisted client-side) THEN the system SHALL fetch and render that session's
   full history before the input becomes usable.
2. WHEN no prior `session_id` exists for that instance (first visit, or after "New chat") THEN
   the system SHALL generate one and show an empty conversation, same as today.
3. WHEN the history fetch fails (network, 401/403/404) THEN the system SHALL fall back to an
   empty conversation, not block the page or crash.

### P1: New conversation, explicitly

**As a** signed-in user, **I want** a way to start a fresh conversation, **so that** I'm not
stuck forever appending to one growing history.

**Acceptance Criteria**:
1. WHEN the user clicks "New chat" THEN the system SHALL generate a fresh `session_id`,
   persist it (replacing the old one for that instance), and clear the visible message list.

## Out of Scope

| Feature | Reason |
|---|---|
| Listing/switching between multiple past conversations per instance | Only "the last one" is persisted client-side; a full session list/picker is a bigger feature, not asked for here. |
| Cross-device history sync | Persistence is client-side (localStorage) only, matching this stack's existing "client owns session_id" model. |
| Editing/deleting history | Read-only surface. |

## Design (inline)

### New proxy endpoint

`GET /v1/sessions/history?session_id=<client-session-id>` on `picoclaw-openai-proxy`:
- Same auth as `/v1/chat/completions`: `checkAuth` (PROXY_API_KEY) + `emailFromRequest`
  (`x-mycelium-email`, gateway-injected).
- Computes `key = sessionIdFor(email, session_id)`, scans
  `<PICOCLAW_DATA_DIR>/workspace/sessions/*.meta.json` for one whose
  `scope.values.chat === "direct:pico:" + key`, reads the paired `.jsonl`.
- Returns `{ messages: [{ role, content }, ...] }` (200), or `{ messages: [] }` if no session
  file exists yet (not an error -- a session with no messages sent is a normal state, same as a
  brand new conversation).
- `PICOCLAW_DATA_DIR` -- new env var, `/root/.picoclaw` (the same mount already used for
  `.security.yml`), since the proxy needs the *base* data dir now, not just the security file
  path.

### New gateway route

`mycelium/config.standalone.toml`: one new `[[picoclaw-*.path]]` block per instance, `path =
"/v1/sessions/history"`, `group = "authenticated"`, same secret as the existing paths, `methods
= ["GET"]`.

### New chat-webapp BFF route

`GET /api/chat/[instance]/history?session_id=...` -- reads the session cookie, forwards to the
new proxy route via the gateway, same error-mapping posture as `/api/chat/[instance]` (401 ->
clear cookie, 403 -> role_required, network -> connectivity).

### Client-side session_id persistence

`localStorage["chat-session:<instance>"]` -- read on mount instead of always generating a new
UUID; write whenever a fresh one is generated (first visit or "New chat"). This is the minimal
persistence mechanism consistent with the existing "session_id is entirely client-owned, never
server-assigned" design (see design.md in `mycelium-chat-webapp` for why).

## Success Criteria

- [ ] Sending "hi", reloading the page, still shows "hi" and the reply -- no re-ask needed.
- [ ] "New chat" produces a visibly empty conversation and a different `session_id` on the next
      send (verifiable via the resulting `.meta.json`'s `scope.values.chat`).
- [ ] History fetch failure never blocks the chat input from becoming usable.

# Chat UI Redesign Specification

**Scope**: Large -- multi-component (routing restructure, client-side data model, new BFF
streaming behavior, new UI shell), several real architecture decisions. Full spec + inline
design (see Design section) + task breakdown; no external research needed (SSE format and
session-file mechanics were already verified on disk in the chat-history feature).

## Problem Statement

The current chat UI is two disconnected pages (`/chat` picker, `/chat/[instance]` single
conversation) with no memory of past conversations beyond "the last one per instance," no way
to search anything, and calls the two PicoClaw deployments "instances" -- internal
infrastructure language that means nothing to someone using the product. This feature turns it
into a single persistent shell (sidebar + conversation view) matching how modern chat products
(ChatGPT, Claude) are laid out, calls alpha/beta "agents" throughout the UI, adds a
multi-conversation history with full-content search, streams replies token-by-token instead of
waiting for the whole answer, and adds the project's own logo/branding.

## User Decisions (from /tlc-spec-driven discuss)

- **Sidebar structure**: one unified conversation list mixing both agents' conversations
  (sorted by recency), each item tagged with which agent it belongs to -- not a
  per-agent-tab-then-list structure.
- **Search scope**: full message content, not just conversation titles. Titles alone would be
  free (client-side only); content search means fetching each conversation's history to filter
  it, accepted as a deliberate tradeoff for better results over instant results.

## User Stories

### P1: Agents, not instances

**Acceptance Criteria**:
1. WHEN any UI copy currently says "instance" THEN it SHALL say "agent" instead (headings,
   labels, error messages, page titles).
2. Internal route segments/identifiers (`/chat/alpha`, `Instance` TS type, `isInstance()`) stay
   as-is -- this is a user-facing copy change, not a rename of the underlying `alpha`/`beta`
   gateway-routing concept covered elsewhere in this project's docs.

### P1: Persistent sidebar shell

**Acceptance Criteria**:
1. WHEN the user is anywhere under `/chat` THEN a sidebar SHALL be visible showing: the project
   logo, a "New chat" action, a search box, the conversation list, and a user menu (email +
   logout) at the bottom.
2. WHEN the user clicks "New chat" THEN the system SHALL let them pick which agent to start
   with (only two agents exist -- a compact picker, not a full page), then open a fresh,
   empty conversation for that agent.
3. WHEN the user clicks a conversation in the list THEN the system SHALL open that exact
   conversation (not just "the most recent one") -- this requires the session id to be part of
   the URL, unlike the current single-conversation-per-agent design.

### P1: Multi-conversation history per agent

**Acceptance Criteria**:
1. WHEN a message is sent in a conversation that isn't in the sidebar list yet THEN the system
   SHALL add it, with a title derived from the first user message (truncated).
2. WHEN a conversation receives a new message THEN its list entry SHALL move to the top
   (most-recently-active ordering), matching modern chat products.
3. This index is client-side only (localStorage), consistent with this project's existing
   "session_id is entirely client-owned" design -- it does not sync across browsers/devices.

### P1: Full-content search

**Acceptance Criteria**:
1. WHEN the user types in the search box THEN, after a short debounce, the system SHALL fetch
   each listed conversation's history and show only those whose messages contain the query
   (case-insensitive substring match).
2. WHEN the search box is empty THEN the system SHALL show the full list ordered by recency,
   with no extra fetches (title-based rendering only).
3. WHEN a search is in flight THEN the system SHALL show a loading affordance rather than an
   empty/stale list.

### P1: Streamed replies

**Acceptance Criteria**:
1. WHEN the user sends a message THEN the assistant's reply SHALL appear incrementally
   (token-by-token) as the proxy's own SSE stream (`stream: true`, already implemented
   proxy-side) delivers it, not all at once after the full response completes.
2. WHEN the stream errors mid-flight THEN the system SHALL keep whatever partial content
   already arrived and show a connectivity error, not discard it.
3. Auth/role errors (401/403) SHALL still be detected before any streaming begins (checked on
   the initial HTTP response, same as the non-streaming behavior being replaced).

### P2: Project logo

**Acceptance Criteria**:
1. WHEN the sidebar and the signin page render THEN they SHALL show the project's zombie-crab
   logo (image provided by the user) instead of plain text-only branding.

## Out of Scope

| Feature | Reason |
|---|---|
| Renaming a conversation, deleting a conversation | Not asked for; the list is read/append-only for now. |
| Cross-device sync of the conversation index | Client-side localStorage only, matching existing architecture. |
| Frontend role-based filtering of which agents are chatable | Already deferred in an earlier feature (M3 in ROADMAP.md); unrelated to this UI work. |
| Search relevance ranking / highlighting matched text | Substring filter is enough for this stage. |

## Design (inline)

### Routing restructure

- `app/chat/layout.tsx` (new) -- persistent sidebar shell wrapping everything under `/chat`.
- `app/chat/[instance]/[sessionId]/page.tsx` (moved from `app/chat/[instance]/page.tsx`) --
  session id is now part of the URL so a sidebar item can deep-link to a specific conversation.
- `app/chat/page.tsx` -- becomes a lightweight "no conversation selected" state (shown at
  `/chat` itself, e.g. right after login before picking anything), not the old agent-card
  picker (that picker's job moves into the sidebar's "New chat" flow).

### Client-side conversation index (`webapp/lib/chatSession.ts`, rewritten)

```typescript
interface ConversationSummary {
  id: string;        // == session_id
  instance: Instance; // "alpha" | "beta"
  title: string;      // first user message, truncated
  updatedAt: number;  // epoch ms, bumped on every message sent
}
```
Stored as one JSON array under `localStorage["chat-conversations"]`. Replaces the old
per-instance `chat-session:<instance>` single-id scheme entirely (T17 of the chat-history
feature is superseded by this).

### Search

No new backend endpoint -- reuses the existing `/api/chat/[instance]/history` route per
conversation being searched, fired in parallel (`Promise.all`) once the debounced query is
non-empty, filtering conversations whose messages contain the query substring.

### Streaming

`app/api/chat/[instance]/route.ts` (BFF): sends `stream: true` to the proxy, reads the upstream
`Response.status` first (still returns JSON error bodies for 401/403/connectivity, unchanged),
then on success pipes the upstream SSE body straight through as the route handler's own
streamed response (`Response` with a `ReadableStream` body) -- no re-parsing needed
server-side, the browser does that.

Client-side: `fetch` (not `EventSource`, since this is a POST) + manual `ReadableStream`
reading, parsing `data: {...}\n\n` frames, appending `choices[0].delta.content` to the
in-progress assistant message as chunks arrive.

### Logo

`webapp/public/logo.png` (the provided zombie-crab image) -- used in the sidebar header and
the `/signin` page, replacing the current text-only "zombie-crab chat" heading treatment (kept
as accompanying text next to the mark, not replaced entirely).

## Success Criteria

- [ ] Sidebar visible on every `/chat/*` route, listing conversations from both agents mixed
      together, tagged.
- [ ] Clicking a past conversation opens that exact conversation's history.
- [ ] Typing a word that only appears in one old conversation's *body* (not its title) surfaces
      that conversation in the filtered list.
- [ ] Sending a message visibly streams the reply in rather than popping in all at once.
- [ ] No UI copy says "instance" anymore.
- [ ] Logo renders in the sidebar and on the signin page.

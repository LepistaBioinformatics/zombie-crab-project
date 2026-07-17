# workspace-selection Specification

Frontend (chat-webapp) + thin proxy/gateway wiring to let a user pick a
tenant-scoped workspace and chat in it, completing the `tenant-scoped-workspaces`
flow from the client side. Depends on the proxy feature
(`crab-shell-proxy/.specs/features/tenant-scoped-workspaces`).

## Problem Statement

`crab-shell-proxy`'s `/v1/chat/completions` now REQUIRES `tenant_id` +
`subs_acc_id` and authorizes via the profile filter chain. But chat-webapp still
posts the old body (`{session_id, messages}`) against a hardcoded `alpha`/`beta`
instance picker, so every send gets a `400` from the proxy — which the BFF masks
as `{"error":"connectivity"}`. There is no way for a user to see or choose the
subscription accounts / tenants they are licensed into.

## Goals

- [ ] A pre-chat **selection screen** listing the workspaces the caller may use
      (one card per `(tenant, subscription, agent)` the profile is licensed for),
      driven by the proxy's `GET /v1/subscriptions` discovery.
- [ ] The chosen workspace + session are held **entirely in the URL fragment**
      as a single `#` followed by `&`-separated `key=value` pairs
      (`#t=<uuid>&s=<uuid>&r=<role>&sid=<session>`), parsed/serialized with
      `URLSearchParams(location.hash.slice(1))` — the standard fragment-as-query
      convention (OAuth implicit flow etc.), not multiple `#`. Client-only state
      the browser never sends to any server; survives reload/bookmark.
- [ ] Chat sends `tenant_id` + `subs_acc_id` (read from the fragment) so the turn
      is authorized and routed to the user's isolated workspace.
- [ ] Real error surfacing: a proxy `4xx` shows its actual reason, not
      "connectivity" (which is reserved for genuine network failures).
- [ ] Human-friendly labels: cards show the account **name**, not a bare UUID.

## Out of Scope

| Item | Reason |
| --- | --- |
| Creating subscriptions / accounts from the UI | Provisioning is the mycelium `subscriptionAccount.created` webhook → `POST /v1/accounts`; select-only here |
| Role/guest-role assignment UI | mycelium admin concern (manual, AD-002) |
| History filtering redesign | Path already moved server-side; deferred there |
| Changing the proxy authorization contract | Consumed as-is |

---

## Decisions (from discuss, 2026-07-16)

- **DEC-1 — pre-chat selection screen:** `/chat` renders a workspace picker
  (cards); choosing one enters the chat for that workspace. (Chosen over a single
  dropdown or separate tenant/subscription/instance dropdowns.)
- **DEC-2 — state in the URL fragment, not path/query/cookie:** the selected
  `(tenant, subscription, role, session)` live in the hash as a single `#` +
  `&`-separated `key=value` pairs (`#t=..&s=..&r=..&sid=..`), parsed/serialized
  with `URLSearchParams(location.hash.slice(1))`. **Format confirmed by web
  research (2026-07-16):** the conventional way to hold multiple params in a
  fragment is the query-string form after one `#` (as in the OAuth 2.0 implicit
  grant and general SPA hash-state), NOT multiple `#` separators. The fragment is
  **not transmitted to the server** (browsers omit it from HTTP requests), so the
  workspace ids never appear in server/gateway logs or the BFF request line; the
  client reads `location.hash` and passes the ids explicitly in the chat POST
  body. It also persists chat state across reloads. Supersedes the old
  `/chat/[instance]` path-segment model.
- **DEC-3 — labels from `accName`:** the proxy discovery response is enriched
  with the account name (already present in `licensed_resources`).
- **DEC-4 — select-only:** no account/subscription creation in the UI.

---

## User Stories

### P1: See my workspaces ⭐ MVP
**Story**: As a signed-in user, I open `/chat` and see the workspaces I can use.

**Acceptance Criteria**:
1. WHEN `/chat` loads THEN it SHALL fetch discovery and render one card per
   licensed `(tenant, subscription, agent)` showing the account name + agent role
   (+ tenant, verified/perm as secondary detail).
2. WHEN the user has no licensed workspaces THEN it SHALL show an empty state
   (no cards), not an error.
3. WHEN discovery fails (network/auth) THEN it SHALL show a real error, not a
   blank list.

### P1: Enter and chat in a workspace ⭐ MVP
**Story**: As a user, I pick a workspace card and chat in it.

**Acceptance Criteria**:
1. WHEN a card is chosen THEN the app SHALL set the fragment
   `#t=<tenant>&s=<subs>&r=<role>&sid=<session>` and open the chat view for it
   (route path stays workspace-agnostic; state is only in the fragment).
2. WHEN a message is sent THEN the client SHALL POST `message` + `session_id` +
   `tenant_id` + `subs_acc_id` (from the fragment) to the BFF, which forwards
   them to `/picoclaw-<role>/v1/chat/completions`.
3. WHEN the fragment is missing/incomplete (e.g. direct nav to the chat view)
   THEN the app SHALL redirect back to the selection screen.
4. WHEN reloading a chat URL with a valid fragment THEN the same workspace +
   session SHALL be restored (no re-selection).

### P1: Honest errors ⭐ MVP
**Story**: As a user, when a send fails I see why.

**Acceptance Criteria**:
1. WHEN the proxy returns `4xx` (e.g. 403 not licensed, 409 not scaffolded, 400
   bad request) THEN the BFF SHALL surface that status + message, distinct from
   the `connectivity` (network-failure) case.
2. `connectivity` SHALL be used only for an actual fetch/transport failure.

---

## Requirement Traceability

| ID | Story | Component | Status |
| --- | --- | --- | --- |
| WS-01 | Discovery enriched with `accName` | crab-shell-proxy `GET /v1/subscriptions` | Pending |
| WS-02 | `/v1/subscriptions` reachable through the gateway | mycelium `config.standalone.toml` (parent) | Pending |
| WS-03 | BFF discovery proxy route | webapp `GET /api/subscriptions` | Pending |
| WS-04 | Selection screen (cards, empty, error states) | webapp `/chat` page | Pending |
| WS-05 | Fragment state model (`#t/#s/#r/#sid`), parse/serialize + guard/redirect | webapp chat view (client) | Pending |
| WS-06 | Chat send includes tenant_id/subs_acc_id; route by role | webapp chat page + `POST /api/chat/...` | Pending |
| WS-07 | Real error surfacing (drop the connectivity mask on 4xx) | webapp BFF `route.ts` | Pending |
| WS-08 | Routing rework: retire `/chat/[instance]` path segment | webapp routes/sidebar | Pending |

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

---

## Resolved design points (2026-07-16)

- **Fragment format:** single `#` + `&`-separated `key=value`
  (`#t=..&s=..&r=..&sid=..`), `URLSearchParams`-parsed — web-confirmed convention
  (DEC-2). Not multiple `#`.
- **Conversations are per workspace:** the sidebar conversation list is scoped to
  the currently-selected workspace (tenant+subscription+role). Switching
  workspace shows that workspace's conversations; `sid` in the fragment selects
  one. (Impacts how `/api/conversations` is keyed — by workspace, not just user.)
- **Roles offered = configured agents only:** the selection screen SHALL only
  render cards whose `role` maps to a configured agent (`alpha`/`beta`); a
  licensed resource with a role that is not a known agent is omitted (chatting it
  would 403 per the role contract, CTX-TSW-07).

---

## Success Criteria

- [ ] A user with ≥1 licensed subscription sees named cards at `/chat`.
- [ ] Picking a card + sending a message returns a real assistant reply, routed
      to the user's isolated workspace; the workspace ids appear only in the
      fragment (verified: absent from the BFF/gateway request logs).
- [ ] A 403/409/400 shows its real reason in the UI, not "connectivity".
- [ ] Reload restores the workspace + session from the fragment.

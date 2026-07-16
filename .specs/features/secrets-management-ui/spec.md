# secrets-management-ui Specification

Builds on `context.md` (CTX-SM-01..04). The chat-webapp UI for the proxy's
`/v1/secrets` (agent-customization). Frontend built by a separate agent — this
is the requirement set + contract.

## Problem Statement

The proxy now accepts per-`(user, agent)` secret injection via `/v1/secrets`
(four formats, write-only, restart-on-write), but there is no way for a user to
use it — the only current path to give the agent a credential is typing it into
the chat, which is insecure and doesn't persist. Users need a secure UI, beside
the chat, to set/list/clear secrets for the current workspace's agent.

## Goals

- [ ] A drawer beside the chat to manage the current workspace agent's secrets.
- [ ] Inject a secret in any of the four formats (`dotenv`, `json`, `file`,
      `native`), format-guided; never send `channel_list`.
- [ ] List the set secret **names** (grouped by format), never values, with
      per-secret delete.
- [ ] Surface: write-only, restart-on-apply, and per-`(user, agent)` scope.
- [ ] BFF routes proxy to `/v1/secrets` with honest error surfacing.

## Out of Scope

| Item | Reason |
| --- | --- |
| Editing agent templates (AGENT.md/skills) | Operator-config, not user UI |
| `channel_list` secret injection | Blocked by the proxy (pico-token protection) |
| Changes to the proxy `/v1/secrets` contract | Consumed as-is |
| Showing/retrieving secret values | Write-only by design |

---

## User Stories

### P1: Open the secrets drawer ⭐ MVP
**Story**: In a chat, I open a drawer to manage this agent's secrets.
**Acceptance Criteria**:
1. WHEN a workspace chat is open THEN a control (icon/button) SHALL open a
   drawer scoped to the current workspace's agent (tenant/subscription/role from
   the fragment).
2. WHEN no workspace is selected (no fragment) THEN the control SHALL be
   unavailable (nothing to scope to).

### P1: Inject a secret ⭐ MVP
**Story**: I set a secret for this agent, picking the format.
**Acceptance Criteria**:
1. WHEN the drawer form is submitted with a `format`, `name`/slot, and `value`
   THEN the client SHALL `POST /api/secrets` with `{tenant_id, subs_acc_id,
   format, name, value}` (ids from the fragment) and, on `200`, clear the value
   field and refresh the list.
2. WHEN `format=native` THEN the form SHALL present the slot as **dropdowns**
   (web provider from the fixed set; model for `model_list.<model>.api_keys`),
   NOT a raw string, and SHALL NOT offer `channel_list`.
3. WHEN `format` ∈ `dotenv|json|file` THEN the form SHALL present a free-text
   `name` field (validated to a safe charset before submit for a fast fail).
4. WHEN the proxy returns `400` (bad name / unknown slot) or `403` (unlicensed)
   THEN the UI SHALL show that real reason (not "connectivity").
5. WHEN applying THEN the UI SHALL indicate the agent **restarts** (a live turn
   is briefly interrupted).

### P1: List & clear secrets ⭐ MVP
**Story**: I see which secrets are set and can remove one.
**Acceptance Criteria**:
1. WHEN the drawer opens THEN it SHALL `GET /api/secrets` and render the set
   **names grouped by format** — never a value (none is returned).
2. WHEN a secret's delete is confirmed THEN the client SHALL `DELETE
   /api/secrets?format&name` and refresh; the UI notes the agent restarts.
3. WHEN the list is empty THEN an empty state SHALL show (not an error).

### P2: Scope clarity
**Story**: I understand a secret applies to this agent across my subscriptions.
**Acceptance Criteria**:
1. The drawer SHALL state the secret persists for **(me, this agent)** — future
   sessions and other subscriptions of the same agent — not per-conversation.

---

## Requirement Traceability

| ID | Story | Component | Status |
| --- | --- | --- | --- |
| SM-01 | Secrets drawer, scoped to the current workspace agent | `app/chat/secrets-drawer.tsx` + toggle in `chat-view.tsx` | Verified (UI/build) |
| SM-02 | Guided inject form (format selector; native dropdowns; no channel_list) | `secrets-drawer.tsx` | Verified (UI/build) |
| SM-03 | List names grouped by format (no values) + per-secret delete | `secrets-drawer.tsx` | Verified (UI/build) |
| SM-04 | `POST/GET/DELETE /api/secrets` BFF proxy + honest errors | `app/api/secrets/route.ts` + `lib/secrets.ts` | Verified (UI/build) |
| SM-05 | Surface write-only + restart + per-(user,agent) scope | `secrets-drawer.tsx` copy | Verified (UI/build) |
| SM-06 | `className` via cva variants (project convention) | all new components | Verified (UI/build) |

**Note:** UI + `next build` + headless render verified (drawer opens scoped to the agent,
`dotenv/json/file/native` forms, native provider dropdown, `channel_list` absent from the DOM, list
grouped by format with names-only + delete, restart/scope copy). The live inject→restart path is
operator-gated (needs the gateway rebuilt to route `/v1/secrets` + a licensed workspace).

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

---

## Success Criteria
- [ ] From a chat, a user opens the drawer, injects a `dotenv` secret, sees its
      name appear (no value), and the agent restarts.
- [ ] A `native` web-search key is set via the provider dropdown; `channel_list`
      is never offered.
- [ ] A `400`/`403` from the proxy shows its real message.
- [ ] Deleting a secret removes its name and restarts the agent.
- [ ] `next build` (typecheck + compile) is green.

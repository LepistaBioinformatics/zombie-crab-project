# secrets-management-ui — Discussion Context (gray-area decisions)

The webapp (chat-webapp) side of the proxy's **agent-customization** feature:
a secure UI, beside the chat, to inject/list/clear the caller's per-`(user,
agent)` secrets via the proxy's `POST/GET/DELETE /v1/secrets`. Implemented by a
separate frontend agent — this is the spec + contract only.

## Proxy contract this consumes (already built, `crab-shell-proxy` agent-customization)

- `POST /v1/secrets` — body `{ tenant_id, subs_acc_id, format, name, value }`;
  `format` ∈ `dotenv|json|file|native`; for `native`, `name` is a slot
  (`web.<provider>` or `model_list.<model>.api_keys`). Injects into the
  per-`(userAccId, role)` store, **restarts** the caller's agent container, `200`.
- `GET /v1/secrets?tenant_id&subs_acc_id` — returns set names only, grouped:
  `{ secrets: { dotenv:[…], json:[…], native:[…], file:[…] } }`. **Never values.**
- `DELETE /v1/secrets?tenant_id&subs_acc_id&format&name` — removes one, restarts.
- Authorized by the chat chain (write + tenant + role + account). Reached through
  the gateway at `/picoclaw-<role>/v1/secrets`. `channel_list` native slots are
  rejected by the proxy (protects the pico token) — the UI must NOT offer them.

## CTX-SM-01: a side drawer beside the chat
**Decision:** a toggleable drawer/panel opened from a button in the chat view
(secrets/config icon), not a permanent sidebar section or a separate settings
page. Operates on the **current workspace's agent** (tenant/subscription/role
come from the URL fragment — the `workspace-selection` model).

## CTX-SM-02: guided-by-format entry
**Decision:** a format selector drives the form. For `native`, the UI shows
**dropdowns** (web provider from the fixed set brave/tavily/kagi/gemini/
perplexity/glm_search/baidu_search; and, for `model_list.<model>.api_keys`, the
model) instead of a raw slot string. For `dotenv`/`json`/`file`, a free-text
**name** field. All take a **value** field. No `channel_list` option.

## CTX-SM-03: what the UI must make explicit (from the proxy contract)
- **Write-only:** values are NEVER fetched or shown — the list shows names only,
  with per-secret delete. After submit, the value field is cleared.
- **Restart notice:** injecting/deleting **restarts the agent container** (a live
  turn is briefly interrupted) — the UI warns before/while applying.
- **Scope:** the secret persists for **(this user, this agent)** across any
  subscription of the same agent — surface this so the user understands it isn't
  per-conversation.

## CTX-SM-04: BFF proxying + honest errors
**Decision:** new BFF routes `GET/POST/DELETE /api/secrets` forward to
`/picoclaw-<role>/v1/secrets` with the session JWT + `tenant_id`/`subs_acc_id`
(read client-side from the fragment, sent in the request the client makes to the
BFF). Surface the proxy's real `4xx` reason (400 bad name/slot, 403 unlicensed),
NOT a masked "connectivity" (reuse `upstreamError` from the workspace-selection
work). The fragment is never sent to any server (client reads it, passes ids).

## Convention
- `className` via **class-variance-authority** variants — no inline
  conditional/interpolated `className` (project preference).

## Out of scope
- Editing agent **templates** (AGENT.md/skills) — operator-config, not user UI.
- Any change to the proxy or its `/v1/secrets` contract.
- `channel_list` secret injection (blocked by the proxy).

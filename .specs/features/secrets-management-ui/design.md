# secrets-management-ui Design

Builds on `context.md` (CTX-SM-01..04) and `spec.md` (SM-01..06). Architecture +
contract for the separate frontend agent; reuses the chat-webapp patterns from
`workspace-selection`. Not prescriptive about the exact component tree — the
implementing agent owns that; this fixes the data flow, BFF contract, and states.

---

## 1. Data flow (fragment → client → BFF → gateway → proxy)

The selected workspace lives in the URL fragment (`#t=&s=&r=&sid=`,
`workspace-selection` DEC-2), which the browser never sends to the server. So:

1. The drawer (a client component) reads `tenant/subs/role` from the fragment
   (reuse the existing `app/chat/fragment.ts` helper — `useFragment`/`toWorkspace`).
2. It calls the **BFF** (`/api/secrets`) passing `tenant_id`, `subs_acc_id`
   explicitly in the request it makes (body for POST, query for GET/DELETE) —
   the ids come from the fragment, not from any server-visible URL.
3. The BFF (server) attaches the session JWT and forwards to
   `/picoclaw-<role>/v1/secrets` via `fetchMycelium` (role = the fragment's `r`,
   validated against `INSTANCES` from `lib/mycelium.ts`).

`role` picks the gateway service path; the proxy scopes the store to
`(profile.accId, role)` server-side — the client never sends an accId.

---

## 2. BFF routes — `app/api/secrets/route.ts` (SM-04)

Mirror `app/api/subscriptions/route.ts` (workspace-selection): `getSession()`
(401 if none), validate `isInstance(role)` (400), `fetchMycelium(...)` with
`Authorization: Bearer <session.token>`, and on a non-OK response use
`upstreamError(res)` to return the proxy's real `{error,status}` (NOT the
`connectivity` mask — that is reserved for a caught `MyceliumConnectivityError`).

- `GET /api/secrets?tenant_id&subs_acc_id&role` → forwards
  `GET /picoclaw-<role>/v1/secrets?tenant_id&subs_acc_id` → returns
  `{secrets:{dotenv,json,native,file:[names]}}`.
- `POST /api/secrets` body `{tenant_id,subs_acc_id,role,format,name,value}` →
  forwards `POST /picoclaw-<role>/v1/secrets` with the same (minus role).
- `DELETE /api/secrets?tenant_id&subs_acc_id&role&format&name` → forwards
  `DELETE /picoclaw-<role>/v1/secrets?...`.

The BFF never logs or echoes `value`.

---

## 3. Drawer + guided form (SM-01, SM-02, SM-03, SM-05)

- **Toggle** from the chat view (a control in `chat-view.tsx`/`workspace-nav.tsx`),
  disabled when there is no fragment workspace (SM-01.2). A slide-over drawer.
- **Form (guided by format):** a `format` selector (`dotenv | json | file |
  native`). On `native`, render **dropdowns** — a web-provider select over the
  fixed set `[brave, tavily, kagi, gemini, perplexity, glm_search, baidu_search]`
  (→ slot `web.<provider>`) and, for a model key, a model select (→ slot
  `model_list.<model>.api_keys`); do NOT render a `channel_list` option. On
  `dotenv|json|file`, a free-text `name` (client-validate `^[A-Za-z0-9._-]+$` for
  a fast fail before the proxy's own 400). A `value` field (password-style),
  cleared on success. Submit → POST; on 200 refresh the list + clear value.
- **List:** the `GET` result rendered grouped by format, **names only**, each
  with a delete action (confirm → DELETE → refresh).
- **States:** loading, empty (no error), error (show `upstreamError` message),
  and an "applying — the agent restarts" indicator during POST/DELETE (the proxy
  restarts the container; a live turn is briefly interrupted — SM-05).
- **Copy:** a line stating secrets persist for **(you, this agent)** across
  subscriptions and future sessions; values are write-only (never shown).

---

## 4. Convention (SM-06)

`className` via **class-variance-authority** variants (drawer open/closed, format
tabs, list rows, buttons) — no inline conditional/interpolated `className`
(project preference). Follow the existing components' styling system.

---

## 5. Component / file map (indicative)

| Concern | Location (indicative) |
| --- | --- |
| BFF GET/POST/DELETE proxy | `app/api/secrets/route.ts` |
| Drawer shell + toggle | `app/chat/secrets-drawer.tsx` (+ hook into chat view) |
| Guided form (format → dropdowns/name + value) | within the drawer |
| Names list + delete | within the drawer |
| Fragment read | reuse `app/chat/fragment.ts` |
| mycelium fetch + error | reuse `lib/mycelium.ts` (`fetchMycelium`, `upstreamError`, `INSTANCES`) |

---

## 6. Risks
- **R1 — value leakage:** the value must never land in a URL, a GET response, a
  log, or client state after submit. Keep it in the form field only; clear on
  success; POST body only.
- **R2 — restart UX:** injecting interrupts a live turn (proxy restarts the
  container). Warn; don't fire on every keystroke — only on explicit submit.
- **R3 — native slot/model list source:** the model dropdown needs the agent's
  model list; if not readily available client-side, offer `web.<provider>` +
  free generic formats first and treat `model_list` as a follow-up (the proxy
  rejects unknown/absent model slots with 400, so a stale list fails safe).
- **R4 — role from fragment:** validate `role ∈ INSTANCES` before calling the
  BFF; a tampered fragment role just 404s at the gateway (no security impact —
  the proxy authz still gates by profile).

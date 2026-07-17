# onboarding Design

Builds on `context.md` (CTX-OB-01..04) and `spec.md` (OB-01..07). Reuses the
chat-webapp BFF/session patterns. Implemented by this agent.

Endpoints confirmed in the mycelium source (scopes `SystemActor::Beginner`="beginners",
`UrlGroup::{Accounts,Profile}`="accounts"/"profile", each `#[get("")]`, under the
`/_adm` prefix the verify route already uses):
- `GET /_adm/beginners/profile`
- `GET /_adm/beginners/accounts`

---

## 1. Detection (OB-01) — `lib/onboarding.ts` (server-only)

`hasAccount(token): Promise<"yes" | "no" | "unreachable">`:
- `Promise.allSettled` of `fetchMycelium("/_adm/beginners/profile", {Authorization: Bearer token})`
  and `fetchMycelium("/_adm/beginners/accounts", {…})`.
- **yes** if either settled with a 2xx `Response`.
- **unreachable** if BOTH rejected with `MyceliumConnectivityError` (transport) —
  do NOT treat as account-less.
- **no** otherwise (both reached the gateway but non-2xx — the account-less
  user's profile can't resolve, L-006).

## 2. Session flag (avoid re-probing) — `lib/session.ts`

Add `accountReady?: boolean` to the session payload. Set `true` once detection
returns "yes" or after a successful onboarding create. The chat entry checks the
flag first and only probes mycelium when it is unset — one probe per user, not
per navigation.

## 3. Routing (OB-02)

- **`app/chat/page.tsx`** (server) — the app entry after signin (`signin` does
  `router.push("/chat")`). Before rendering the workspace list: if
  `session.accountReady` is unset, call `hasAccount(token)`:
  - `no` → `redirect("/onboarding")`.
  - `unreachable` → render an error state (not a redirect).
  - `yes` → set `accountReady=true` on the session, render the workspace list.
  (If already `accountReady`, render directly.)
- **`app/onboarding/page.tsx`** (server guard + client screen) — if
  `session.accountReady` (or `hasAccount`=="yes"), `redirect("/chat")` so a
  returning user never lingers on onboarding.

## 4. Onboarding screen (OB-03) — `app/onboarding/`

A welcome (client component for the button): greeting, plain-language copy — "a
sua conta será criada" + "seus workspaces/agentes aparecerão quando um
administrador o convidar" (sets the invite-gated expectation) — and a **"Vamos
começar"** button. Click → `POST /api/onboarding`; on success `router.push("/chat")`;
on error show the real message + allow retry. `className` via cva.

## 5. BFF create (OB-04) — `app/api/onboarding/route.ts`

`POST` → `getSession` (401 if none) → `fetchMycelium("/_adm/beginners/users",
{method:POST, Authorization: Bearer token, body:{email}})`. On 2xx (or an
already-exists conflict — idempotent), set `session.accountReady=true`, return
`{ok:true}`. On a real failure, return the upstream reason (via `upstreamError`);
`connectivity` only for a caught `MyceliumConnectivityError`.

## 6. Verify change (OB-05) — `app/api/auth/verify/route.ts`

Remove the transparent `POST /_adm/beginners/users` block. Verify now only:
magic-link verify → `setSession({token, email})` (no `accountReady`). Account
creation is the onboarding action.

---

## 7. Component / file map

| Concern | Location |
| --- | --- |
| Detection probe (profile + account) | `webapp/lib/onboarding.ts` (new) |
| `accountReady` on the session | `webapp/lib/session.ts` |
| Entry routing (probe/redirect) | `webapp/app/chat/page.tsx` |
| Onboarding guard + welcome screen | `webapp/app/onboarding/page.tsx` (+ client button component) |
| Create-account BFF | `webapp/app/api/onboarding/route.ts` (new) |
| Drop transparent create | `webapp/app/api/auth/verify/route.ts` |

---

## 8. Risks
- **R1 — concurrent front agent:** the webapp is being edited elsewhere. Touch
  new files + the two shared files (`verify/route.ts`, `chat/page.tsx`,
  `session.ts`) carefully; check `webapp/` git status before editing and after
  (avoid clobbering WIP).
- **R2 — probe latency/cost:** mitigated by the `accountReady` session flag
  (probe once). A stale flag can't grant chat access anyway (the proxy authz
  still gates), so the flag is a UX optimization, not a security boundary.
- **R3 — scope-path drift:** the `/_adm/beginners/{profile,accounts}` paths are
  source-confirmed but verify empirically against the running gateway when wiring
  (curl with a real JWT) before trusting the detection.
- **R4 — "unreachable" vs "no":** never route a user to onboarding on a
  transport failure (they may already have an account) — distinguish the two.

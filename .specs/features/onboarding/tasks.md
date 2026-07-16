# onboarding Tasks

Webapp feature, implemented by this agent. Gate: `next build` (typecheck +
compile) green via `docker build --network=host -t zombie-crab-project-chat-webapp:latest ./webapp`;
runtime detection path confirmed with a real JWT against the running gateway.
Coordinate with the concurrent front agent (check `webapp/` git status before/
after). `[P]` = parallelizable.

---

### T01 — Detection helper — OB-01, OB-06
- **What:** `lib/onboarding.ts` `hasAccount(token)` → `"yes"|"no"|"unreachable"`
  via `Promise.allSettled` of `GET /_adm/beginners/profile` + `/accounts` (JWT);
  yes=either 2xx, unreachable=both `MyceliumConnectivityError`, no=otherwise.
- **Done when:** unit/typecheck; empirically curl both endpoints with a real JWT
  to confirm the paths + 2xx-vs-non-2xx behavior for an account vs account-less user.
- **Depends on:** — (reuses `lib/mycelium.ts`)

### T02 — Session `accountReady` flag — OB-02
- **What:** add `accountReady?: boolean` to the session payload in `lib/session.ts`
  (+ its type); preserve existing fields.
- **Done when:** typecheck; set/read round-trips.
- **Depends on:** —

### T03 — Drop transparent create from verify — OB-05
- **What:** remove the `POST /_adm/beginners/users` block from
  `app/api/auth/verify/route.ts`; verify only authenticates + `setSession`.
- **Done when:** verify no longer creates the account; signin still sets session.
- **Depends on:** —

### T04 — Create-account BFF — OB-04, OB-06
- **What:** `app/api/onboarding/route.ts` POST → `getSession` (401) →
  `POST /_adm/beginners/users` (JWT, `{email}`) → set `accountReady=true`, `{ok}`;
  real errors via `upstreamError`; `connectivity` only on transport failure.
- **Done when:** httpish check: 200 sets the flag; a failure returns the reason.
- **Depends on:** T02

### T05 — Onboarding screen — OB-03, OB-07
- **What:** `app/onboarding/page.tsx` (server guard: if `accountReady`/`hasAccount`
  =="yes" → redirect `/chat`) + a client welcome with the invite-expectation copy
  and a "Vamos começar" button → `POST /api/onboarding` → `router.push("/chat")`;
  error + retry. `className` via cva.
- **Done when:** renders; guard redirects a returning user; button flow works;
  no inline conditional/interpolated className.
- **Depends on:** T01, T04

### T06 — Entry routing — OB-02
- **What:** `app/chat/page.tsx` (server) — if `!session.accountReady` call
  `hasAccount`: `no`→`redirect("/onboarding")`, `unreachable`→error state,
  `yes`→set flag + render workspace list.
- **Done when:** account-less user is redirected to onboarding; account user
  renders workspaces; transport failure shows an error (not onboarding).
- **Depends on:** T01, T02

### T07 — Verify
- **What:** `next build` green; manual: new user → onboarding welcome → "Vamos
  começar" → account created → workspace list (empty, with the invite copy having
  set the expectation); returning user skips onboarding; verify no longer creates.
- **Done when:** spec §Success Criteria observed. **Note:** live path needs the
  gateway up + a fresh (account-less) magic-link user.
- **Depends on:** T03, T05, T06

---

## Dependency graph
```
T01 ─┬─ T05 ─┐
T02 ─┼─ T04 ─┤
     └─ T06 ─┼─ T07
T03 ─────────┘
```

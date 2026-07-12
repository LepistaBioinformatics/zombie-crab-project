# Mycelium Chat Webapp Tasks

**Design**: `.specs/features/mycelium-chat-webapp/design.md`
**Status**: T1-T13 (Phase A) DONE. T14-T22 (Phase B) DEFERRED, not executed -- see STATE.md
AD-006. Phase A's own T12 spike is what surfaced the conflict that caused the deferral: routes
shipped as `authenticated` (email-based identity), not `protectedByRoles`. T14-T22 remain below
as a reference for a possible future role-scoped-access feature.

**Testing posture**: This repo has no automated test suite anywhere yet (confirmed -- no
`TESTING.md`, no test runner configured in any existing service). Adding one is out of scope
for this feature. Gates below are TypeScript build/typecheck (for `chat-webapp`) plus manual
verification (curl/browser) against the running stack -- consistent with how every prior
feature in this project (protected routes, healthz, etc.) was verified.

---

## Execution Plan

### Phase 1: Foundation (sequential)

```
T1 ─┬→ T3
T2 ─┘
```

### Phase 2: chat-webapp core (parallel OK after T1)

```
      ┌→ T4 ─┐
      ├→ T5 ─┤
T1 ───┼→ T6 ─┼──→ T8 ──→ T9 ──→ T11 ──→ T12
      ├→ T7 ─┤
      └──────┘
T5 ──→ T10 ──────────────────────↗
```

### Phase 3: Phase-A verification + docs (sequential)

```
T3 + T12 + T10 → T13 → T14
```

### Phase 4: Phase-B infra spike (sequential, starts after T13 passes)

```
T15 → T16
    → T17
(T16 + T17) → T18 → T19 → T20 → T21 → T22
```

---

## Task Breakdown

### T1: Scaffold `chat-webapp` Next.js app

**What**: New `webapp/` directory: Next.js (App Router, TypeScript) project, `package.json`,
`tsconfig.json`, minimal `app/layout.tsx`, `Dockerfile` (multi-stage, `node:24-alpine`
consistent with `picoclaw-openai-proxy/Dockerfile`'s version choice; standard `next build` then
`next start`).
**Where**: `webapp/`
**Depends on**: None
**Reuses**: `picoclaw-openai-proxy/Dockerfile`'s multi-stage shape (adapted for `next build`
instead of a single-file Node app)
**Requirement**: CHAT-04

**Done when**:
- [ ] `yarn install && yarn build` succeeds locally
- [ ] `docker build ./webapp` succeeds
- [ ] Placeholder `/` page renders

**Tests**: none (scaffold only)
**Gate**: build

---

### T2: `mycelium-webapp` Dockerfile [P]

**What**: New `mycelium-webapp/Dockerfile`: git-clone `LepistaBioinformatics/mycelium-webapp`
at a pinned commit (mirroring `mycelium/Dockerfile.standalone`'s "no local source copied"
convention), `yarn build` with `VITE_MYCELIUM_API_URL` as a build ARG, nginx runtime stage
(copy upstream's own `nginx.conf`).
**Where**: `mycelium-webapp/Dockerfile`
**Depends on**: None
**Reuses**: `mycelium/Dockerfile.standalone`'s git-clone-at-build-time pattern; upstream's own
`Dockerfile` (read at `/home/sgeliasp/thirdparty-projects/mycelium-monorepo/modules/mycelium-webapp/Dockerfile`)
adapted to clone instead of using local build context.
**Requirement**: CHAT-05

**Done when**:
- [ ] `docker build --network=host ./mycelium-webapp --build-arg VITE_MYCELIUM_API_URL=http://localhost:8080` succeeds
- [ ] Resulting image serves the SPA on port 80

**Tests**: none
**Gate**: build

---

### T3: Wire `chat-webapp` + `mycelium-webapp` into `docker-compose.yaml`

**What**: Add both services (per design.md's Docker Compose Changes -- Phase A subset: no
Postgres/Mailpit yet). `chat-webapp`: `MYCELIUM_INTERNAL_URL=http://mycelium-gateway:8080`,
published `${CHAT_WEBAPP_PORT:-3000}`, `depends_on: mycelium-gateway: condition:
service_healthy`. `mycelium-webapp`: build arg `VITE_MYCELIUM_API_URL=http://localhost:${MYCELIUM_PORT:-8080}`,
published `${MYCELIUM_WEBAPP_PORT:-8081}`. Add `allowedOrigins` entry for
`http://localhost:${MYCELIUM_WEBAPP_PORT:-8081}` to `mycelium/config.standalone.toml`'s
`[api]` block (CORS, needed even in Phase A since `mycelium-webapp` calls the gateway directly
from the browser regardless of gateway mode).
**Where**: `docker-compose.yaml`, `mycelium/config.standalone.toml`, `.env.example`
**Depends on**: T1, T2
**Reuses**: existing `depends_on: condition: service_healthy` convention already used by the
proxy services
**Requirement**: CHAT-05

**Done when**:
- [ ] `docker compose up -d chat-webapp mycelium-webapp` brings both up alongside the existing stack
- [ ] `mycelium-webapp` loads in a browser and its network calls target `localhost:8080`, not `api.lepista.io`
- [ ] No CORS errors in devtools when `mycelium-webapp` calls the gateway

**Tests**: none
**Gate**: manual (docker compose up + browser check)

---

### T4: `/api/auth/request` route handler [P]

**What**: `POST { email }` -> `fetch(`${MYCELIUM_INTERNAL_URL}/_adm/beginners/users/magic-link/request`, ...)`, always returns 200 (mirrors Mycelium's own anti-enumeration contract).
**Where**: `webapp/app/api/auth/request/route.ts`
**Depends on**: T1
**Reuses**: none (first route handler)
**Requirement**: CHAT-01

**Done when**:
- [ ] Valid email -> 200
- [ ] Malformed email -> 400 before hitting Mycelium (basic shape check only, Mycelium does the real validation)
- [ ] Gateway unreachable -> 502 with `{ error: "connectivity" }`

**Tests**: none
**Gate**: manual (curl the route handler directly once `chat-webapp` is up)

---

### T5: `/api/auth/verify` route handler [P]

**What**: `POST { email, code }` -> calls Mycelium's verify endpoint; on success, sets
`myc_session` httpOnly cookie (`SameSite=Lax`, JSON `{ token, email }` from the verify
response); on 401 from Mycelium, passes through 401 with `{ error: "invalid_code" }`.
**Where**: `webapp/app/api/auth/verify/route.ts`
**Depends on**: T1
**Reuses**: none
**Requirement**: CHAT-01, CHAT-02

**Done when**:
- [ ] Correct code -> 200, `Set-Cookie: myc_session=...; HttpOnly; SameSite=Lax`
- [ ] Wrong code -> 401, no cookie set
- [ ] Cookie value round-trips (readable server-side by T6)

**Tests**: none
**Gate**: manual

---

### T6: `/api/auth/session` + `/api/auth/logout` route handlers [P]

**What**: `GET /api/auth/session` reads `myc_session`, returns `{ authenticated, email }` (never
the token). `POST /api/auth/logout` clears the cookie, returns 200.
**Where**: `webapp/app/api/auth/session/route.ts`, `webapp/app/api/auth/logout/route.ts`
**Depends on**: T1
**Reuses**: cookie shape from T5
**Requirement**: CHAT-02, CHAT-07

**Done when**:
- [ ] No cookie -> `{ authenticated: false }`
- [ ] Valid cookie -> `{ authenticated: true, email }`
- [ ] Logout clears the cookie and a subsequent `/api/auth/session` call returns `{ authenticated: false }`

**Tests**: none
**Gate**: manual

---

### T7: `webapp/middleware.ts` route gating [P]

**What**: Redirect to `/signin` when `/chat` or `/chat/*` is requested without a `myc_session`
cookie present (presence check only -- real validation happens per-request in the route
handlers).
**Where**: `webapp/middleware.ts`
**Depends on**: T1
**Reuses**: none
**Requirement**: CHAT-02

**Done when**:
- [ ] Unauthenticated request to `/chat` redirects to `/signin`
- [ ] Authenticated request (cookie present) reaches `/chat`

**Tests**: none
**Gate**: manual

---

### T8: `/signin` page

**What**: Two-step email/code form (email step -> code step -> on success, redirect to `/chat`),
same UX shape as reference `mycelium-webapp`'s `HomePage` (email input, then 6-digit code
input with a "back" action), calling T4/T5's route handlers via `fetch`.
**Where**: `webapp/app/signin/page.tsx`
**Depends on**: T4, T5
**Reuses**: UX shape from `mycelium-webapp/src/screens/HomePage/index.tsx` (read locally, not
copied -- different component library, no shared code)
**Requirement**: CHAT-01

**Done when**:
- [ ] Email step submits to `/api/auth/request`, advances to code step regardless of response content (per CHAT-01 AC#1)
- [ ] Code step submits to `/api/auth/verify`; success redirects to `/chat`; failure shows inline "invalid code" and stays on the code step
- [ ] "Back" returns to the email step without losing form state awkwardly

**Tests**: none
**Gate**: manual (real signin against the running standalone stack -- this is the first real
exercise of Mycelium's magic-link flow on this project, see AD-005)

---

### T9: Instance picker `/chat` page

**What**: Authenticated page showing `alpha` and `beta` as selectable options (both always
shown, per CHAT-03 AC#1); reads `/api/auth/session` to display the signed-in email and a
logout button (CHAT-07).
**Where**: `webapp/app/chat/page.tsx`
**Depends on**: T6, T7
**Reuses**: none
**Requirement**: CHAT-03, CHAT-07

**Done when**:
- [ ] Both instances shown regardless of role
- [ ] Selecting an instance navigates to `/chat/[instance]`
- [ ] Signed-in email visible; logout works and returns to `/signin`

**Tests**: none
**Gate**: manual

---

### T10: `/api/chat/[instance]` route handler [P]

**What**: `POST { message, session_id }` -> reads `myc_session`, forwards to
`${MYCELIUM_INTERNAL_URL}/picoclaw-{instance}/v1/chat/completions` as `{ model: "picoclaw",
session_id, messages: [{ role: "user", content: message }] }` with `Authorization: Bearer
<token>`; maps gateway 401 -> clear cookie + 401 `{ error: "session_expired" }`, 403 -> 403
`{ error: "role_required" }`, network failure -> 502 `{ error: "connectivity" }`, success ->
200 `{ content: choices[0].message.content }`.
**Where**: `webapp/app/api/chat/[instance]/route.ts`
**Depends on**: T5 (cookie shape)
**Reuses**: proxy's existing response contract (`picoclaw-openai-proxy/server.js:326-337`)
**Requirement**: CHAT-04

**Done when**:
- [ ] `instance` param restricted to `alpha`/`beta` (400 on anything else, before ever reaching the gateway)
- [ ] Successful chat call returns the assistant's reply
- [ ] 401/403/network failure map to the three distinct error shapes above

**Tests**: none
**Gate**: manual

---

### T11: Conversation view `/chat/[instance]` page

**What**: Message list + input, calls T10's route handler, generates a fresh `session_id`
(`crypto.randomUUID()`) whenever the `instance` param changes (CHAT-03 AC#3), renders the three
distinct error states from T10 (session expired -> redirect to `/signin`; role required ->
readable permission message; connectivity -> generic banner).
**Where**: `webapp/app/chat/[instance]/page.tsx`
**Depends on**: T9, T10
**Reuses**: none
**Requirement**: CHAT-04, CHAT-03

**Done when**:
- [ ] Sending a message renders the assistant's reply
- [ ] Switching instance (back to picker, pick the other one) starts a fresh, empty conversation
- [ ] All three T10 error shapes render distinguishably (not just a generic "error" toast)

**Tests**: none
**Gate**: manual

---

### T12: Manual end-to-end pass, Phase A

**What**: With the current `standalone` stack running (`docker compose up -d`), from a browser:
sign in with a real email via `chat-webapp`, retrieve the magic-link code from `docker compose
logs mycelium-gateway` (stub transport), verify, pick `alpha`, send "hi", get a real reply.
Repeat instance switch to confirm separate `session_id`s (cross-check against
`data/alpha/workspace/sessions/*.meta.json`, same technique used earlier in this project to
verify session isolation).
**Where**: n/a (verification pass)
**Depends on**: T3, T8, T9, T11
**Requirement**: CHAT-01 through CHAT-04, all ACs

**Done when**:
- [ ] Full signin -> pick -> chat loop works with zero curl
- [ ] JWT never appears in browser devtools (Application/Storage tab, or any non-httpOnly cookie)
- [ ] Session files on disk confirm per-account, per-instance isolation as designed

**Tests**: none
**Gate**: manual, this is the gate for Phase A

---

### T13: Update READMEs for Phase A

**What**: Add a "Chat webapp" section (English + pt-BR, keep parity per this project's
established convention) documenting: bringing up `chat-webapp`/`mycelium-webapp`, the
magic-link-via-docker-logs dev flow, and a note that role-based access enforcement is not yet
active (still `protected`, not `protectedByRoles` -- that's Phase B).
**Where**: `README.md`, `README.pt-br.md`
**Depends on**: T12
**Requirement**: n/a (docs)

**Done when**:
- [ ] Both READMEs describe the same steps
- [ ] Existing curl-based walkthrough steps still accurate (unchanged in Phase A)

**Tests**: none
**Gate**: manual read-through

---

### T14: [SPIKE] Boot base-mode gateway + Postgres + Mailpit, no app changes

**What**: One-off validation, not a durable code task: build a `base`-mode `myc-api` image
(default `postgres-backend` feature, git-clone pattern per AD-003), bring up `mycelium-postgres`
+ `mailpit` + this gateway image with `[smtp]` pointed at Mailpit and `[redis]` present but
**no redis container running**. Confirm: (a) the gateway boots and stays up (answers whether
the KV/notifier Redis client is actually lazy at boot, AD-005's open question), (b) it stays
healthy for a few minutes of idle running (answers whether the redis-backed email queue poll
loop crashes/retries-forever vs. degrades quietly).
**Where**: scratch/throwaway compose override, not committed
**Depends on**: T12 (Phase A verified first, per AD-005)
**Requirement**: CHAT-06 (unblocks it)

**Done when**:
- [ ] Gateway process stays up with no Redis container for at least 5 minutes idle
- [ ] Findings written to STATE.md (Lessons Learned) regardless of outcome

**Tests**: none
**Gate**: manual, this is itself a gate for T15 (or a re-plan if it fails)

---

### T15: [SPIKE] Seed staff account + verify magic-link delivers through Mailpit

**What**: Build `myc-cli` (git-clone pattern, default features, same commit as the gateway
image), run `accounts create-seed-account` against `mycelium-postgres`. Log into
`mycelium-webapp` with that account. Separately, `POST /_adm/beginners/users/magic-link/request`
against the base-mode gateway from T14 and check Mailpit's web UI for the email (resolves the
`SmtpTransport::relay()`-vs-plaintext-Mailpit TLS question flagged in design.md).
**Where**: same throwaway environment as T14
**Depends on**: T14
**Requirement**: CHAT-05, CHAT-06

**Done when**:
- [ ] Seed staff account created and can log into `mycelium-webapp`
- [ ] Magic-link email appears in Mailpit's UI -- OR, if it doesn't, a specific fallback is
      chosen and recorded (Mailpit `--smtp-tls-cert`, real SMTP, or a maintainer-side `.relay()`
      patch) before proceeding to T16
- [ ] Findings written to STATE.md (Lessons Learned)

**Tests**: none
**Gate**: manual, this is the gate for T16 -- do not proceed until email delivery is confirmed
working end to end by some path

---

### T16: Migrate `mycelium-gateway` to base mode for real

**What**: Replace `mycelium/Dockerfile.standalone` + `mycelium/config.standalone.toml` with the
base-mode build + config validated in T14/T15 (`config.base.toml`: vault disabled, `[diesel]`
pointing at `mycelium-postgres`, `[smtp]` pointing at `mailpit` or whatever T15 settled on).
Add `mycelium-postgres` and `mailpit` as permanent `docker-compose.yaml` services. Remove the
now-unused `mycelium-data` SQLite volume.
**Where**: `mycelium/Dockerfile.standalone` -> replaced, `mycelium/config.standalone.toml` ->
replaced, `docker-compose.yaml`
**Depends on**: T15
**Requirement**: CHAT-06

**Done when**:
- [ ] `docker compose up -d` boots the full stack on the new mode
- [ ] T12's manual verification pass still succeeds unmodified against the new mode (chat-webapp
      is mode-agnostic per design.md)

**Tests**: none
**Gate**: manual, re-run T12's checklist

---

### T17: Flip routes to `protectedByRoles`

**What**: `mycelium/config.base.toml`'s four `[[picoclaw-*.path]]` blocks: `group = "protected"`
-> `group = { protectedByRoles = [{ name = "alpha" }] }` / `"beta"` per instance.
**Where**: `mycelium/config.base.toml`
**Depends on**: T16
**Requirement**: CHAT-06

**Done when**:
- [ ] Gateway boots without error with the new route groups
- [ ] `alpha`/`beta` `GuestRole` records exist after boot (check via `mycelium-webapp` or gateway logs) with no manual creation step
- [ ] A caller with a valid JWT but no assigned role gets 403 attempting to chat (matches CHAT-04 AC#3 / the spec's Edge Cases section)

**Tests**: none
**Gate**: manual

---

### T18: Manually assign a test account to `alpha`, verify full loop

**What**: Using the seeded Staff account in `mycelium-webapp`: create a tenant, a subscription
account, a guest role for `alpha`, and invite the `chat-webapp` test account (from T12) into it.
Confirm that account can now chat with `alpha` (and still gets 403 on `beta`, unassigned).
**Where**: n/a (manual admin flow)
**Depends on**: T17
**Requirement**: CHAT-05, CHAT-06, success criteria in spec.md

**Done when**:
- [ ] Assigned account can chat with `alpha` end to end through `chat-webapp`
- [ ] Same account still gets a readable 403 (not a crash) on `beta`
- [ ] Steps recorded precisely enough to turn into a README walkthrough (T19)

**Tests**: none
**Gate**: manual, this is the feature's overall success-criteria gate

---

### T19: Update READMEs for Phase B (final)

**What**: Extend the Phase A README section (T13) with: base-mode setup (Postgres, Mailpit,
seeding the Staff account via `myc-cli`), the `mycelium-webapp` role-assignment walkthrough from
T18, and the CHAT-06 `protectedByRoles` config explanation (mirroring this project's existing
pattern of explaining *why* a config choice was made, not just *what* it is).
**Where**: `README.md`, `README.pt-br.md`
**Depends on**: T18
**Requirement**: n/a (docs)

**Done when**:
- [ ] Both READMEs in parity
- [ ] A person with zero prior context can follow it start to finish (spec.md's Success Criteria)

**Tests**: none
**Gate**: manual read-through

---

### T20: Update ROADMAP.md / STATE.md

**What**: Mark `mycelium-profile-chat-ui`/`mycelium-chat-webapp` COMPLETE in ROADMAP.md, record
final lessons learned (especially the T14/T15 spike outcome, whatever it turns out to be) in
STATE.md, move the "Frontend role filtering" and "automated role seeding" deferred ideas
forward if they're still relevant.
**Where**: `.specs/project/ROADMAP.md`, `.specs/project/STATE.md`
**Depends on**: T19
**Requirement**: n/a (project bookkeeping)

**Done when**:
- [ ] ROADMAP.md reflects reality
- [ ] STATE.md's Lessons Learned captures anything a future session would need to not re-derive
      this same research (Redis laziness, `.relay()` behavior, the CLI's Postgres-only wiring)

**Tests**: none
**Gate**: manual

# Roadmap

**Current Milestone:** Human-usable signin + chat
**Status:** In Progress

---

## M1: Multi-tenant PicoClaw behind Mycelium

**Goal:** Two PicoClaw instances reachable only through Mycelium, with verified session identity.

### Features

**Core stack (compose + gateway + proxies)** - COMPLETE
**Health checks** - COMPLETE
**Authenticated routes / email-derived identity** - COMPLETE (superseded twice: `public` ->
`protected`/accId-based (an earlier session) -> `authenticated`/email-based (AD-006, this
session) -- see STATE.md for why `protected` didn't work out for a self-service signup flow)

---

## M2: Human-usable test client

**Goal:** A human can sign in and actually chat with alpha/beta through the gateway (not just curl).

### Features

**mycelium-chat-webapp** - COMPLETE

- `chat-webapp` (Next.js BFF: magic-link signin, automatic account creation,
  instance picker, chat, system-theme-aware UI) and `mycelium-webapp` wired
  into compose.
- Verified end-to-end against the live gateway: real magic-link flow, real
  JWT, a genuine chat reply through gateway -> proxy -> picoclaw -> LLM.
- Routes are `authenticated` (not `protectedByRoles`) -- see M3.

---

## M3 (future, not started): Role-scoped access per instance

**Goal:** Restrict which accounts can reach `picoclaw-alpha` vs `picoclaw-beta`.

**Why not done yet:** Traced during M2 (STATE.md L-006): `protected`/`protectedByRoles` both
require an existing guest membership just to resolve a profile at all -- a freshly signed-up
account has none, so *no* chat works under those groups until a full Staff -> tenant ->
subscription -> guest-invite chain exists, which itself requires migrating `mycelium-gateway`
off SQLite to Postgres (`myc-cli`'s seed-account command is Postgres-only) plus a real SMTP
catcher (Mailpit) for email delivery. This is real, multi-step infra work -- deliberately
separated from M2 rather than blocking "sign in and chat" on it. `.specs/features/
mycelium-chat-webapp/{design,tasks}.md`'s Phase B sections are a ready-made starting point
(architecture, task breakdown, open verification questions already identified) whenever this
milestone is picked up.

### Features

**PLANNED**:
- Migrate `mycelium-gateway` to `base` mode (Postgres, no Redis) + add Mailpit
- Seed the first Staff account, verify magic-link delivers through Mailpit
- Flip routes to `protectedByRoles` (roles: `alpha`, `beta`)
- Manual `mycelium-webapp` walkthrough: tenant -> subscription -> guest-invite
- Frontend enforcement of role-based instance visibility (currently the picker shows both
  regardless of role)
- Automated seeding of `alpha`/`beta` role *assignment* (record creation is already automatic,
  per Mycelium's own `propagate_declared_roles_to_storage_engine`)

---

## Future Considerations

- Production hardening (TLS termination, secret rotation)

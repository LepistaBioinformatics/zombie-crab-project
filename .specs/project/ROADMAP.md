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

**chat-history** - COMPLETE

- New proxy endpoint `GET /v1/sessions/history` (locates a session's
  `.jsonl` transcript via `.meta.json` scanning, no new picoclaw API).
- Multi-conversation groundwork: session_id persistence moved from
  "one per agent" to a full client-side conversation index (superseded
  again by chat-ui-redesign below).

**chat-ui-redesign** - COMPLETE

- Alpha/beta are called "agents" in all UI copy (routing/type names
  unchanged internally).
- Persistent sidebar shell (`app/chat/layout.tsx`): logo, "New chat" +
  agent picker, search box, unified conversation list (both agents mixed,
  tagged), user menu.
- Conversation URLs now include the session id
  (`/chat/{instance}/{sessionId}`), so sidebar items deep-link to an exact
  past conversation, not just "the last one."
- Full-content search: debounced, fetches each conversation's history in
  parallel and filters by substring match, not just titles.
- Replies stream in token-by-token (SSE pass-through from the proxy's
  existing `stream: true` support, through the BFF, to a client-side
  `ReadableStream` reader) instead of waiting for the full response.
- Project logo (zombie-crab) on the sidebar and signin page.

---

## M3 (in progress): Role-scoped access per instance

**Goal:** Restrict which accounts can reach `picoclaw-alpha` vs `picoclaw-beta`.

**Why it stalled, then restarted:** Traced during M2 (STATE.md L-006): `protected`/
`protectedByRoles` both require an existing guest membership just to resolve a profile at all,
which requires a Staff -> tenant -> subscription -> guest-invite chain, which requires
Postgres (`myc-cli`'s seed-account command is Postgres-only). Originally deferred entirely
(AD-006); resumed 2026-07-13 at the user's explicit request to create the Staff account (see
AD-007).

### Features

**DONE**:
- Migrated `mycelium-gateway` to `base` mode (Postgres) -- `Dockerfile.base`/`config.base.toml`,
  new `mycelium-postgres` + `mailpit` compose services (AD-007).
- Applied the Postgres schema by hand (`up.sql` + the envelope-encryption migration -- no
  auto-migration for this backend, see STATE.md L-009).
- Built `myc-cli`, seeded the first Staff account (`staff@localhost`, see L-010/L-011 for how).
  Verified: logs in via `/_adm/beginners/users/login`, gets a JWT back.

**KNOWN ISSUE (deferred at user's request, see STATE.md L-012)**:
- chat-webapp's magic-link signin is currently broken against the base-mode gateway --
  `SmtpTransport::relay()` (implicit TLS) vs. Mailpit (STARTTLS only) are incompatible. The
  Staff account itself is unaffected (password-based, no email).

**PLANNED (not started)**:
- Fix the SMTP/TLS mismatch (options recorded in STATE.md L-012)
- Log into `mycelium-webapp` as Staff, create a tenant -> subscription -> guest role for
  `alpha`/`beta`, invite a test account
- Flip routes to `protectedByRoles` (roles: `alpha`, `beta`)
- Frontend enforcement of role-based instance visibility (currently the picker shows both
  regardless of role)

---

## Future Considerations

- Production hardening (TLS termination, secret rotation)

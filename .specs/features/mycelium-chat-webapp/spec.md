# Mycelium Chat Webapp Specification

> **Superseded (2026-07-12, AD-006):** Goal #4 and CHAT-06 below (routes on `protectedByRoles`)
> were reversed after implementation revealed they're incompatible with Goal #2/CHAT-01
> ("sign in and chat now, roles later") -- `protected`/`protectedByRoles` both require an
> existing guest membership just to resolve a profile at all, which a fresh signup never has.
> Routes are `authenticated` (email-based identity) in the shipped feature. CHAT-06 and this
> doc's `protectedByRoles` framing are kept below as a record of the original ask and the
> reasoning that changed it -- see STATE.md AD-006 for the decision, and design.md/tasks.md's
> Phase B for what a future role-scoped-access feature would still need to do.

## Problem Statement

Right now the only way to exercise the stack's protected/role-scoped APIs is `curl` with a
manually-obtained bearer token. There's no human-usable way to sign in, pick which PicoClaw
instance (alpha/beta) to talk to, and chat -- and no admin UI to create/manage the Mycelium
accounts and roles that gate access. This feature adds both: a Next.js test client for signing
in and chatting, and Mycelium's own `mycelium-webapp` for account/role administration.

## Goals

- [ ] A user can sign in (and, on first use, implicitly create their account) via Mycelium's
      magic-link flow, entirely through the Next.js app -- no curl required.
- [ ] A signed-in user can pick alpha or beta and send/receive chat messages through the real
      gateway -> proxy -> PicoClaw chain.
- [ ] An operator can reach `mycelium-webapp` to create the `alpha`/`beta` guest roles' account
      assignments, without building any custom admin tooling.
- [ ] Gateway routes for both instances move from `protected` to `protectedByRoles` (roles
      `alpha`, `beta`), so access is enforceable per-instance going forward.

## Out of Scope

| Feature | Reason |
|---|---|
| Frontend filtering the instance picker by the signed-in user's actual roles | Explicitly deferred by the user -- "a parte de validar os papeis construimos depois". The picker shows both instances regardless of role; a lacking-role user sees the gateway's 403 when they try to send a message. |
| Automated seeding/assignment of `alpha`/`beta` roles to accounts | Deferred -- done manually via `mycelium-webapp`, see AD-002 in STATE.md. |
| 2FA/TOTP | Not requested; Mycelium supports it but this feature only implements the base magic-link flow. |
| Production hardening (TLS, secret rotation, rate limiting policy) | Same posture as the rest of this repo -- dev/demo stack. |
| Editing/managing tenants, subscriptions, billing in the Next.js app | That's what `mycelium-webapp` is for; the Next.js app is a minimal chat test client only. |

---

## User Stories

### P1: Sign in via magic link ⭐ MVP

**User Story**: As a new or returning user, I want to sign in with just my email (no password)
so that I can start using the chat test client.

**Why P1**: Nothing else in this feature is reachable without auth.

**Acceptance Criteria**:

1. WHEN the user submits their email THEN the system SHALL call Mycelium's magic-link request
   endpoint and show a "check your email" step, regardless of whether the email is a new or
   existing account (Mycelium's own endpoint never reveals which, to prevent enumeration).
2. WHEN the user opens the emailed link THEN Mycelium itself (not the Next.js app) SHALL render
   a page showing a 6-digit code.
3. WHEN the user enters that 6-digit code in the Next.js app THEN the system SHALL call
   Mycelium's verify endpoint and, on success, establish an authenticated session (httpOnly
   cookie) and redirect to the instance picker.
4. WHEN the user enters a wrong/expired code THEN the system SHALL show an inline "invalid
   code" error and let them retry without resubmitting their email.
5. WHEN this is the account's first successful verify ever THEN the system SHALL NOT require
   any separate "create account" step -- Mycelium provisions the account on first verified
   login (beginner-scope behavior).

**Independent Test**: Sign in with a fresh email, receive the code, verify, land on the
authenticated picker screen -- no curl, no manual token copy-paste.

---

### P1: Session persistence via httpOnly cookie ⭐ MVP

**User Story**: As a signed-in user, I want my session to survive a page reload so I don't
have to re-verify a code every time.

**Why P1**: Without this the app is unusable beyond a single request.

**Acceptance Criteria**:

1. WHEN verify succeeds THEN the system SHALL set the Mycelium JWT in an httpOnly, `SameSite=Lax`
   cookie scoped to the Next.js app's own origin -- never in a client-readable cookie, header,
   or `localStorage`.
2. WHEN a page loads and the cookie is present and the JWT is still valid THEN the system SHALL
   treat the user as authenticated without another round trip to verify.
3. WHEN a downstream call (chat, models) returns 401 THEN the system SHALL clear the session
   cookie and redirect to sign-in with a "session expired" message.
4. WHEN the user explicitly logs out THEN the system SHALL clear the cookie and redirect to
   sign-in.

**Independent Test**: Sign in, reload the page, still authenticated. Manually expire/corrupt
the cookie, next protected action bounces to sign-in.

---

### P1: Instance picker (alpha / beta) ⭐ MVP

**User Story**: As a signed-in user, I want to choose which PicoClaw instance to talk to, since
the stack runs two independent ones.

**Why P1**: The whole point of this stack is multi-instance isolation; the test client needs to
exercise both.

**Acceptance Criteria**:

1. WHEN the user is authenticated THEN the system SHALL show both `alpha` and `beta` as
   selectable options, regardless of the user's actual role membership (role filtering is out
   of scope for this feature, see Out of Scope).
2. WHEN the user selects an instance THEN the system SHALL route them to a chat screen scoped
   to that instance's `/picoclaw-{instance}/...` gateway path.
3. WHEN the user switches instances mid-session THEN the system SHALL start a fresh
   `session_id` for the newly selected instance (conversations are not shared across instances).

**Independent Test**: From the picker, select alpha, chat, go back, select beta -- get a
separate empty conversation, not alpha's history.

---

### P1: Minimal chat UI ⭐ MVP

**User Story**: As a signed-in user, I want to send a message and see the assistant's reply, so
I can confirm the full request chain (Next.js -> Mycelium -> proxy -> PicoClaw) works.

**Why P1**: This is the actual point of the test client.

**Acceptance Criteria**:

1. WHEN the user submits a message THEN the system SHALL POST to a Next.js route handler that
   forwards to `Mycelium /picoclaw-{instance}/v1/chat/completions` with the session's JWT as
   `Authorization: Bearer`, and the user-entered text plus the current `session_id` in the body.
2. WHEN the gateway/proxy/picoclaw chain responds successfully THEN the system SHALL render the
   assistant's reply in the conversation view.
3. WHEN the gateway responds 401 or 403 (e.g., no `alpha`/`beta` role assigned yet) THEN the
   system SHALL show a readable error explaining the request was rejected by the gateway,
   distinguishable from a network/connectivity failure.
4. WHEN the gateway/proxy is unreachable or times out THEN the system SHALL show a generic
   connectivity error, not crash the page.
5. WHEN a new conversation starts (first message of a fresh `session_id`) THEN the system SHALL
   generate that `session_id` client-side (e.g. a UUID), matching the existing proxy contract.

**Independent Test**: Send "hi" to alpha, get a real model reply rendered in the UI; force a
403 (unassigned role) and see the distinct permission-error message instead of a crash.

---

### P1: `mycelium-webapp` available for account/role administration ⭐ MVP

**User Story**: As the operator running this stack, I want the official Mycelium admin UI
available so I can create accounts, tenants, and assign the `alpha`/`beta` roles without
building anything custom.

**Why P1**: `protectedByRoles` is meaningless without a way to actually assign roles to
accounts, and building that UI ourselves is explicitly out of scope.

**Acceptance Criteria**:

1. WHEN the stack is brought up THEN `mycelium-webapp` SHALL be reachable on its own published
   host port, built from the upstream `LepistaBioinformatics/mycelium-webapp` Dockerfile (git
   context, no local monorepo source copied into the image -- same posture as
   `mycelium/Dockerfile.standalone`).
2. WHEN `mycelium-webapp` loads THEN it SHALL be configured (via its `VITE_MYCELIUM_API_URL`
   build arg) to talk to this stack's own `mycelium-gateway`, not the upstream default
   (`https://api.lepista.io`).
3. WHEN an operator signs into `mycelium-webapp` THEN they SHALL be able to reach the
   guest-role screens needed to assign `alpha`/`beta` to an account (manual step, documented in
   the README, not automated by this feature).

**Independent Test**: `docker compose up -d`, open `mycelium-webapp`'s port in a browser, sign
in, see it talking to the local gateway (not lepista.io).

---

### P2: Config switch to `protectedByRoles`

**User Story**: As the project maintainer, I want the gateway routes for both PicoClaw
instances to require the `alpha`/`beta` roles respectively, so role-scoped access is actually
enforced, not just documented as a future step.

**Why P2**: Not strictly required for the Next.js app to exist and demo the signin/chat flow
against `protected` routes, but the user explicitly asked for this config change as part of the
same request, and it's what makes the instance picker meaningful. Not P1 because it turned out
to require a real prerequisite: the gateway must move from `standalone` (SQLite) to `base`
mode (Postgres) since `myc-cli accounts create-seed-account` -- the only way to create the
first `Staff` account needed before any role can be assigned in `mycelium-webapp` -- only
supports Postgres. See STATE.md AD-003/AD-004/AD-005 and tasks.md's Phase 4 for the full
sequencing and the empirical spike this required.

**Acceptance Criteria**:

1. WHEN `mycelium/config.standalone.toml` is updated THEN each instance's
   `/v1/chat/completions` and `/v1/models` paths SHALL use
   `group = { protectedByRoles = [{ name = "<instance>" }] }` (`alpha` for picoclaw-alpha,
   `beta` for picoclaw-beta) instead of `group = "protected"`.
2. WHEN the gateway boots with this config THEN it SHALL auto-create the `alpha`/`beta`
   `GuestRole` records (Mycelium's own `propagate_declared_roles_to_storage_engine` behavior --
   no seed script needed from this project).
3. WHEN a caller's token lacks the required role THEN the proxy-facing request SHALL be
   rejected by the gateway (403) before it ever reaches `picoclaw-openai-proxy`.

**Independent Test**: Read the config diff; boot the stack; confirm (via `mycelium-webapp` or
gateway logs) the `alpha`/`beta` roles exist without any manual creation step.

---

### P3: Logout and visible identity

**User Story**: As a signed-in user, I want to see which email I'm signed in as and be able to
log out.

**Why P3**: Convenience, not required for the core signin -> pick -> chat loop to be demoable.

**Acceptance Criteria**:

1. WHEN authenticated THEN the system SHALL display the signed-in email somewhere persistent
   in the UI (e.g. header).
2. WHEN the user clicks logout THEN the system SHALL clear the session cookie and return to
   sign-in.

---

## Edge Cases

- WHEN the magic-link request is submitted for an email with no existing account THEN the
  system SHALL behave identically to an existing-account email (no enumeration signal),
  per Mycelium's own endpoint contract.
- WHEN the user requests a new code before verifying a previous one THEN the system SHALL let
  the newest request supersede (Mycelium invalidates the prior display token on new request --
  the Next.js app does not need to track this itself, just re-render the code step).
- WHEN the JWT expires mid-conversation (`jwtExpiresIn`, default 12h per this stack's config)
  THEN the next chat send SHALL surface as a 401 -> "session expired" redirect, not a stuck
  spinner.
- WHEN `mycelium-gateway` itself is down/unhealthy THEN both the Next.js sign-in call and any
  chat call SHALL show a connectivity error distinct from an auth error.
- WHEN two instances (alpha/beta) are both healthy but the user only has the `beta` role THEN
  selecting `alpha` and sending a message SHALL fail with a 403 surfaced in the chat UI, per
  the P1 chat story's acceptance criteria #3 -- this is expected behavior, not a bug, given the
  deferred frontend role-filtering.

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
|---|---|---|---|
| CHAT-01 | P1: Sign in via magic link | Tasks (T4, T5, T8) | In Tasks |
| CHAT-02 | P1: Session persistence via httpOnly cookie | Tasks (T5, T6, T7) | In Tasks |
| CHAT-03 | P1: Instance picker | Tasks (T9, T11) | In Tasks |
| CHAT-04 | P1: Minimal chat UI | Tasks (T10, T11) | In Tasks |
| CHAT-05 | P1: mycelium-webapp in compose | Tasks (T2, T3, T15, T18) | In Tasks |
| CHAT-06 | P2: protectedByRoles config switch | Tasks (T14-T17) | In Tasks |
| CHAT-07 | P3: Logout and visible identity | Tasks (T6, T9) | In Tasks |

**Coverage:** 7 total, 7 mapped to tasks, 0 unmapped

---

## Success Criteria

- [ ] A person with no prior context can clone the repo, follow the README, sign in through the
      Next.js app with a real email, get assigned a role via `mycelium-webapp`, and successfully
      chat with the assigned instance -- entirely through browsers, zero curl.
- [ ] Attempting to chat with an instance the account has no role for produces a readable 403 in
      the UI, not a crash or silent failure.
- [ ] No JWT is ever observable from browser devtools (Application > Storage or a
      non-httpOnly cookie) at any point in the flow.

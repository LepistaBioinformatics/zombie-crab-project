# State

**Last Updated:** 2026-07-13T07:45:00-03:00
**Current Work:** M3 (role-scoped access) -- Staff account exists, protectedByRoles cutover not yet done

---

## Recent Decisions (Last 60 days)

### AD-007: Migrated mycelium-gateway to base mode (Postgres) to create the first Staff account (2026-07-13)

**Decision:** Replaced `standalone` (SQLite) with `base` mode (Postgres, default `postgres-backend`
feature) -- new `mycelium/Dockerfile.base` + `config.base.toml`, new `mycelium-postgres` and
`mailpit` compose services. `mycelium/Dockerfile.standalone`/`config.standalone.toml` are no
longer used by any compose service (kept in the repo as reference, not wired in). This directly
reverses AD-006's earlier choice to stay on standalone -- done because the user (project owner)
explicitly asked to create a Staff account, and that's Postgres-only regardless of which routes
end up gated.
**Reason:** `myc-cli accounts create-seed-account` -- the only way to create the first `Staff`
account, itself required before any tenant/subscription/guest-role screen in `mycelium-webapp`
is reachable -- is hardcoded to Postgres (confirmed earlier, AD-003). No way around this short
of patching mycelium itself.
**Trade-off:** Lost standalone's zero-dependency posture and its stub email transport (see
L-011 below -- this broke chat-webapp's magic-link signin, not yet fixed, user's call to defer).
Routes are still `authenticated` (not `protectedByRoles`) -- this migration only unblocks role
assignment, doesn't itself flip route security groups.
**Impact:** A Staff account exists (`staff@localhost`, see L-010 for how it was created) and can
log into `mycelium-webapp`. The remaining M3 work (create tenant -> subscription -> guest role ->
invite an account -> flip routes to `protectedByRoles`) is still not done.

---

## Lessons Learned (continued -- base-mode migration)

### L-009: `diesel_postgres` has no embedded/auto-run migrations -- unlike SQLite, which self-provisions

**Context:** After switching to base mode, the gateway booted fine but every DB-touching call
failed with `relation "token" does not exist`.
**Problem:** `adapters/diesel_sqlite` embeds its migrations (`embed_migrations!` +
`run_pending_migrations` called automatically at boot) -- that's why standalone mode "just
worked" with no setup step. `adapters/diesel_postgres` has no such mechanism at all; its schema
lives in a single `sql/up.sql` script (parameterized via `-v db_name=... -v db_user=... -v
db_role=... -v db_password=...`) plus loose one-off files under `sql/migrations/` (NOT in
diesel_cli's expected `<version>_<name>/{up,down}.sql` folder format, so `diesel migration run`
finds zero migrations and silently does nothing).
**Solution:** Applied `up.sql` directly via `psql`, then the one migration file
(`20260421_01_envelope_encryption.sql`, a two-column `ALTER TABLE tenant`) by hand.
**Prevents:** Assuming `diesel migration run` (the diesel_cli tool) does anything useful against
this codebase's Postgres schema -- it doesn't, for either the base schema or the one existing
incremental migration. Docs for this are in `docs/book/src/02-installation.md`'s "Database
setup" section (`psql ... -f postgres/sql/up.sql -v db_password=...`).

### L-010: Watch the `up.sql` param quoting -- `-v var="'value'"` bakes literal quote characters into the identifier

**Context:** First `up.sql` run appeared to succeed (no errors, `CREATE TABLE`/`GRANT` printed)
but the target `mycelium` database stayed empty.
**Problem:** Passed `-v db_name="'mycelium'"` (shell-escaped single quotes included) -- psql's
`:'db_name'` substitution wraps the value in ITS OWN quoting, so the effective value became the
literal string `'mycelium'`, quote characters included. The script's `NOT EXISTS` check found no
database with that (mangled) name, so it happily `CREATE DATABASE`'d a new one actually named
`'mycelium'` (quotes as part of the name) and built the whole schema there instead.
**Solution:** Pass bare values with `-v db_name=mycelium` (no extra quoting) -- psql adds the
right quoting itself when the SQL uses `:'var'`.
**Prevents:** A silent-success footgun -- the script prints normal `CREATE TABLE` output either
way, so this only surfaces when you go looking for the tables and don't find them where expected.

### L-011: `myc-cli`'s password prompt needs a real TTY -- `docker run -i`/`-it` alone don't provide one for piped input

**Context:** `myc-cli accounts create-seed-account` panicked (`No such device or address`, errno
ENXIO) when run via `printf 'pw\n' | docker run --rm -i ...`, and `docker run -it` outright
refused piped stdin ("cannot attach stdin to a TTY-enabled container because stdin is not a
terminal").
**Problem:** `rpassword::prompt_password` opens `/dev/tty` directly (not plain stdin) to disable
echo -- that device doesn't exist/isn't the controlling terminal for a container process
whose stdin is just a pipe, `-t` or not.
**Solution:** Spawn `docker run -it ...` under a real pseudo-terminal on the host side (a small
Python `pty.openpty()` wrapper reading output and writing the password once the prompt text
appears), rather than a plain pipe.
**Prevents:** Assuming `-i`/`-it` alone is enough to script an interactive password prompt in a
container -- it isn't; something has to actually allocate and hold open a PTY device.

### L-012 (known issue, not fixed -- user's call): chat-webapp's magic-link signin is broken after the base-mode migration

**Context:** Base mode has no stub/file email transport (`standalone`-only Cargo feature) --
real SMTP became mandatory, so Mailpit was added as a local catcher (see AD-004's original plan).
**Problem:** Mycelium's `SmtpConfig::build_transport()` calls lettre's `SmtpTransport::relay()`,
which negotiates **implicit** TLS from the first byte of the connection (confirmed empirically:
`Could not send email: ... SSL routines:ssl3_get_record:wrong version number`). Mailpit's SMTP
server only supports **STARTTLS** (confirmed via `mailpit --help`: `--smtp-tls-cert` is
explicitly labeled "(STARTTLS)" with no implicit-TLS/SMTPS mode at all) -- the two are
fundamentally incompatible, not a config-tuning issue.
**Status:** Deferred at the user's explicit request ("deixar pra depois, só documentar"). Real
options if picked up later: (a) a small TLS-terminating sidecar (stunnel/socat) in front of
Mailpit translating implicit-TLS -> STARTTLS, self-contained to this project; (b) patch
mycelium's own `smtp_config.rs` to use `starttls_relay()` instead of `.relay()` (the user is
the mycelium maintainer, could fix upstream); (c) point `[smtp]` at a real mail provider instead
of Mailpit.
**Impact:** chat-webapp's `/signin` magic-link flow cannot deliver email right now against the
base-mode gateway -- it did work before this migration (standalone's stub transport, logged to
stdout). The Staff account (password-based, no email involved) is unaffected.

### AD-001: Next.js test client uses a BFF pattern, not client-side tokens (2026-07-12)

**Decision:** The new Next.js chat client talks to Mycelium through its own route handlers (server-side). The JWT returned by magic-link verify is stored in an httpOnly cookie, never exposed to browser JS.
**Reason:** User explicitly chose this over the simpler client-side/localStorage pattern used by the reference `mycelium-webapp`, prioritizing not exposing the token to XSS over build simplicity.
**Trade-off:** More pieces to build (server-side auth route handlers + a server-side proxy for chat calls) than a pure SPA.
**Impact:** Design must define Next.js route handlers for magic-link request/verify and for forwarding chat/model calls to Mycelium with the cookie's JWT as Bearer auth.

### AD-002: `alpha`/`beta` role *assignment* is documented, not automated (2026-07-12)

**Decision:** No automated script grants the `alpha`/`beta` roles to any account. Mycelium itself auto-creates the `GuestRole` records for any role slug declared in a route's `protectedByRoles` list on gateway boot (`propagate_declared_roles_to_storage_engine`), so the roles will exist once the config ships -- but no account is a member of them until an operator uses `mycelium-webapp`'s guest-role invite flow to assign a signed-up user to `alpha` and/or `beta`.
**Reason:** Matches the user's own scope cut ("a parte de validar os papeis construimos depois") -- role validation/assignment is deliberately deferred to a later feature.
**Trade-off:** The stack will not "just work" for chat after switching to `protectedByRoles` until an operator manually invites accounts into the roles via `mycelium-webapp`.
**Impact:** Spec must call this out explicitly as a manual setup step, not a bug. Design does NOT need a role-seeding script -- only documentation of the manual invite step.

---

## Recent Decisions (continued)

### AD-006: Reversed the routing decision -- `authenticated` + email now, `protectedByRoles` deferred to a future feature (2026-07-12)

**Decision:** Routes reverted from `protectedByRoles` back to `authenticated` (not `protected`
either). `picoclaw-openai-proxy` now derives identity from the gateway-injected
`x-mycelium-email` header instead of decoding `x-mycelium-profile` via
`@lepistabioinformatics/mycelium-sdk` (dependency removed entirely; Node engine reverted from
`>=23.8.0` to `>=22`, `node:24-alpine` -> `node:22-alpine`). Session keys are now
`sha256(email::session_id)` instead of `sha256(accId::session_id)`.
**Reason:** L-006 proved the user's two explicit requests were mutually incompatible as
configured: `protectedByRoles` (asked for directly) makes *any* chat impossible for a freshly
signed-up account regardless of role, because `protected`/`protectedByRoles` both require an
existing guest membership just to resolve a profile -- which is exactly the "role validation"
work the user said to defer ("a parte de validar os papeis construimos depois"). Presented as an
explicit fork (keep `protectedByRoles` and build the whole Staff/tenant/subscription/Postgres
chain now, vs. drop to `authenticated` and keep "sign in and chat immediately" working); user
chose the latter.
**Trade-off:** Session isolation is now email-based, not account-id-based (still unspoofable --
the gateway fully replaces, not appends, the header -- but less rich than a full profile; no
`x-mycelium-profile`/SDK integration in this codebase anymore). Per-instance role restriction
(`alpha`-only vs `beta`-only accounts) is no longer live -- any authenticated account can reach
both instances.
**Impact:** AD-003/AD-004 (Postgres/Mailpit/`myc-cli` staff-seed migration) and tasks.md's Phase
4 (T14-T22) are **not being executed** as part of this feature -- they're preserved in
tasks.md/design.md as a reference for a possible future "role-scoped access" feature, but are
superseded for `mycelium-chat-webapp`'s actual scope. `mycelium-webapp` stays in the compose
stack (still useful for exploring Mycelium's admin screens) but is no longer load-bearing for
this feature's chat flow to work.

---

## Active Blockers

None currently -- see AD-003/AD-004 for the standalone->base mode migration plan, and AD-005
for why it's sequenced *after* the chat-webapp MVP rather than before it.

### AD-005: Sequence -- validate signin+chat against the *current* standalone stack first, migrate to base mode as a separate, spiked step (2026-07-12)

**Decision:** Build and manually verify `chat-webapp`'s magic-link signin + chat flow against
the existing `standalone`/SQLite stack (`protected` routes, stub email via `docker compose
logs`) before touching `mycelium-gateway`'s mode at all. The Postgres/Mailpit/staff-seed/
`protectedByRoles` migration (AD-003/AD-004) is then executed as its own spiked, empirically
verified step -- boot it, check it actually stays up without Redis, check `myc-cli` seed works
against Postgres, check a magic-link email actually arrives in Mailpit -- before writing
detailed tasks for it.
**Reason:** AD-003/AD-004 rest on several unverified runtime assumptions stacked on top of each
other (Redis client laziness at boot vs. whether the *email queue* delivers without Redis;
whether `SmtpTransport::relay()`'s implicit-TLS handshake succeeds against Mailpit's default
plaintext listener on :1025). Also: the magic-link flow has never actually been exercised on
this stack before this feature -- all prior protected-route testing used a hand-crafted
`x-mycelium-profile` header injected directly at the proxy, bypassing real Mycelium auth
entirely. Stacking a Next.js build on four unverified assumptions at once is expensive to debug;
proving the cheap path (existing stack, stub email, `protected` routes -- no role gate needed
for the user's own stated MVP) first isolates the BFF/UI risk from the infra risk.
**Trade-off:** Two migration passes on `chat-webapp`'s target routes instead of one (though the
app itself is mode-agnostic -- it just calls whatever the gateway exposes, so this costs little).
**Impact:** Tasks are split into Phase A (chat-webapp + mycelium-webapp compose wiring, verified
against current standalone/`protected`) and Phase B (base-mode infra spike, then
`protectedByRoles` cutover) -- see tasks.md.

---

## Recent Decisions (continued)

### AD-003: Switch `mycelium-gateway` from `standalone` (SQLite) to `base` mode (Postgres) (2026-07-12)

**Decision:** Replace the `standalone` build (`Dockerfile.standalone`, `config.standalone.toml`,
SQLite, in-process secrets/cache) with Mycelium's `base` mode: default `postgres-backend`
Cargo feature, a new `mycelium-postgres` service, Vault disabled with inline secrets (same
posture as upstream's `config.dev.for-docker.toml`), no Redis container.
**Reason:** Traced in the local `mycelium-monorepo` checkout: `myc-cli accounts
create-seed-account` (the only way to create the first `Staff` account, which is required
before any tenant/guest-role/role-assignment screen in `mycelium-webapp` is reachable) is
hardcoded to `mycelium-diesel` -> `adapters/diesel_postgres` (workspace `Cargo.toml:125`) with
no SQLite path. Standalone mode is a dead end for this feature's role-assignment requirement.
User confirmed directly (as the project's maintainer) to switch to `base` mode rather than fix
the CLI upstream or run a throwaway full-mode instance just for seeding.
**Trade-off:** Loses standalone's zero-dependency posture (adds a Postgres container, secrets
are no longer autogenerated/keyring-backed) and its stub email transport (see AD-004). Loses
the `token = { env = "..." }` field-level secret resolver fix (PR #166) as the headline reason
this project used standalone in the first place -- `base` mode's routes still support the
resolver, this isn't a regression, just no longer the primary motivation for the mode choice.
**Impact:** `mycelium/Dockerfile.standalone` and `config.standalone.toml` are replaced (not
kept alongside) by a `base`-mode build + config. All existing protected/`protectedByRoles`
route behavior needs re-verification against this new mode during Execute.

### AD-004: Add Mailpit as the local SMTP catcher (2026-07-12)

**Decision:** Add a `mailpit` service (`axllent/mailpit`, no config needed) to the compose
stack; `mycelium-gateway`'s `[smtp]` block points at it (`host = "mailpit"`, `port = 1025`,
dummy username/password -- Mailpit doesn't validate SMTP auth).
**Reason:** Traced `adapters/notifier/src/repositories/remote_message_sending.rs`: the
`local-transport` feature (stub/file email, what standalone mode used) is only compiled under
the `standalone` Cargo feature. `base`/full mode's `RemoteMessageSendingRepository` calls
`self.client.get_smtp_client()` unconditionally -- there is no stub fallback once `standalone`
is dropped (AD-003). Real magic-link delivery requires either real SMTP credentials or a local
catcher; a catcher preserves this project's "zero external dependency to get started" posture
better than asking every reader for real SMTP credentials.
**Trade-off:** One more container in the stack.
**Impact:** README's signin instructions change from "check `docker compose logs
mycelium-gateway`" to "open Mailpit's web UI (its own published port) and read the magic-link
email there" -- arguably a better dev UX than grepping logs.

---

## Lessons Learned (continued -- chat-ui-redesign feature)

### L-008: `next/image` needs `images.unoptimized = true` in this Docker image (no `sharp`)

**Context:** Added the project logo via `next/image` for the sidebar and signin page.
**Problem:** `next/image`'s optimization pipeline requires the `sharp` package in production;
`webapp/Dockerfile`'s runtime stage doesn't install it (deliberately minimal, `output:
standalone` traces only what's actually imported, and nothing else needed it before).
**Solution:** Set `images: { unoptimized: true }` in `next.config.ts` -- serves the asset as-is,
no dependency needed. Fine for a small local logo with no responsive-variant requirement; would
need revisiting (install `sharp`, or drop `unoptimized`) if the app ever serves user-uploaded or
large images.
**Prevents:** A production-only image-optimization error that wouldn't reproduce in local `yarn
dev` (which doesn't hit the same optimization code path the same way).

## Lessons Learned (continued -- chat-history feature)

### L-007: Manual `docker build` (bypassing `docker compose build`) drops compose's build args -- reintroduced the SecretResolver TOML parse failure (2026-07-12)

**Context:** While rebuilding `mycelium-gateway` for the chat-history feature's new route, used
`docker build --network=host -t zombie-crab-project-mycelium-gateway:latest ./mycelium -f
mycelium/Dockerfile.standalone` directly (compose's own `build` command doesn't accept
`--network`, needed for the git-clone/cargo-install steps in this sandbox). This silently
dropped `MYCELIUM_GIT_REF`, which `docker-compose.yaml` normally supplies from `.env`
(`a1981ecdf16b78e9ffeb28bb2cd9bbff427a88ff` -- the commit with the field-level
`SecretResolver<String>` fix, LepistaBioinformatics/mycelium#166). The Dockerfile's own default
ARG value (`a22ac20860f551e2a6fc196bc9d3dec0f1f7ef55`) is an *older*, pre-fix commit -- so the
resulting image failed to boot with the exact same `data did not match any variant of untagged
enum SecretResolver` TOML parse error documented earlier this session, on a config file that
hadn't changed at all in the relevant section.
**Solution:** Always pass `--build-arg MYCELIUM_GIT_REF=$(grep MYCELIUM_GIT_REF .env | cut -d=
-f2)` (or just read `.env` first) when building `mycelium-gateway` directly instead of via
`docker compose build`.
**Prevents:** Re-diagnosing this as a config/code regression -- it's purely a build-arg mismatch
between the Dockerfile's stale embedded default and `.env`'s actual pinned commit, triggered
only by bypassing compose's own build-arg wiring.

## Lessons Learned (continued during Phase A execution)

### L-002: mycelium-gateway's standalone secret file doesn't survive *any* container recreation, not just image rebuilds (2026-07-12)

**Context:** While wiring T3 (docker-compose.yaml), recreating `mycelium-gateway` -- even with
an unchanged image, just a plain `docker compose up -d mycelium-gateway` re-create -- hit
`Failed to decrypt standalone secret file "/data/.secrets/token_secret.secret"` again, not only
after image rebuilds as previously documented.
**Problem:** The encrypted-local-file fallback's wrapping key is derived from something
container-instance-specific (likely `/etc/machine-id` or similar, which Docker regenerates per
container instance in this sandbox rather than persisting it), not just from the SQLite/data
volume contents. So the volume's `.secrets/` directory becomes undecryptable by any new
container instance, image-unchanged or not.
**Solution:** Same fix as before -- `docker compose stop/rm mycelium-gateway && docker volume rm
zombie-crab-project_mycelium-data && docker compose up -d mycelium-gateway`. No way found yet to
make this survive a plain restart in this environment.
**Prevents:** Wasting time debugging this as a config regression -- it's an inherent standalone
mode + this sandbox's container-recreation behavior interaction, not something T3's changes
caused. Worth flagging to the user if it keeps disrupting the Phase B database migration too.

### L-004: `PermissionedRole`'s TOML field is `name`, not `slug` -- and the routes are already live on `protectedByRoles` (2026-07-12)

**Context:** During T12's manual verification, a chat call to `picoclaw-alpha` (still expected
to be on the `protected` group per Phase A's plan) came back 403
`"User was authenticated but has not an account"` instead of a successful reply. Checking
`mycelium/config.standalone.toml` directly showed all four paths already on
`group = { protectedByRoles = [ {name = "alpha"} ] }` / `"beta"` -- CHAT-06/T17's target state,
applied ahead of this feature's planned Phase A/B sequencing (AD-005). Gateway trace logs
confirmed `PermissionedRole { name: "alpha", permission: Some(Read) }` is the real struct shape.
**Problem:** Two things worth recording so they aren't re-derived: (1) the gateway's own docs
(`06-downstream-apis.md`) show `{ slug = "..." }` in `protectedByRoles` TOML examples, but the
actual field `serde` deserializes is `name` -- `slug` is silently accepted as an unknown/ignored
key (no error), which would leave the role list empty rather than failing loudly, a sharp edge
for anyone copying the docs verbatim. (2) The route config no longer matches what T12 was
written to exercise -- there is currently no way to get a *successful* chat reply through this
stack without an account actually holding the `alpha`/`beta` role, which (per AD-003) requires
the full Postgres/`myc-cli` seed-staff chain regardless of when the route flip happened.
**Solution:** Corrected `{ slug = ... }` to `{ name = ... }` everywhere in
`.specs/features/mycelium-chat-webapp/{spec,design,tasks}.md` and in
`config.standalone.toml`'s own comment block (which still described the old `"protected"`
rationale). T12 is being completed against this reality: auth, session, and the chat
request/response plumbing are fully verified (correct JWT flow, correct 403 mapping to
`role_required`); only the "successful reply" branch is gated behind Phase B now landing next.
**Prevents:** Trusting `06-downstream-apis.md`'s `slug` examples for any future `protectedByRoles`
config in this project; assuming T12's "send hi, get a reply" independent test is achievable
before Phase B's staff-seed chain lands, now that the routes are already role-gated.

### L-005: A magic-link JWT proves identity but does not provision an account -- a separate call is required (2026-07-12)

**Context:** After L-004's discovery (routes already `protectedByRoles`), a chat call with a
freshly-verified JWT still 403'd with `"User was authenticated but has not an account"`.
Inspecting `mycelium.db` directly (`docker cp` + `sqlite3`) showed the `account` and `user`
tables both had 0 rows despite two successful magic-link verifies -- so `verify_magic_link`
does NOT auto-provision an account, contrary to what CHAT-01 AC#5 assumed (based on the
"no passwords required" framing in Mycelium's own docs and `mycelium-webapp`'s UX, which reads
like signup-on-first-login but isn't, structurally).
**Problem:** A second, separate call -- `POST /_adm/beginners/users` (`create_default_user_url`,
`{ email }` body, `Authorization: Bearer <jwt-from-verify>`) -- is what actually creates the
`user`/`account` rows, using the JWT's provider as the identity source (confirmed empirically:
`curl` with the real JWT returned `201 Created`, and the row count moved off zero). Without
this call, every signed-in user is permanently stuck at "authenticated but has not an account"
regardless of role assignment, since there's no account to assign a role *to*.
**Solution:** `webapp/app/api/auth/verify/route.ts` now calls this endpoint automatically right
after a successful verify, best-effort (a returning user's redundant call is swallowed, not
treated as a login failure). This keeps CHAT-01 AC#5's "no separate create-account step from the
user's point of view" true at the UI level even though it's two Mycelium calls underneath.
**Prevents:** Assuming `verify_magic_link`'s JWT alone is sufficient for `mycelium-webapp`'s
guest-role invite screens to find the account either -- if Phase B's manual role-assignment
walkthrough (T18) can't find an account to invite, this missing step is why.

### L-006: "has not an account" is not role-specific -- it blocks `protected` routes too, for any Beginners-only user with no guest membership anywhere (2026-07-12)

**Context:** After L-005's fix (account-creation call added), the `user` table gained rows but
the `account` table stayed at 0 rows, and chat still 403'd identically. Traced the actual
middleware (`recovery_profile_from_storage_engines.rs:56-64`): this profile-resolution step runs
for *both* `protected` and `protectedByRoles` alike (the `roles` parameter only affects the
cache key here, not whether resolution succeeds) -- it returns this exact 403 whenever
`fetch_profile_from_datastore` can't build a `Profile` for the email at all, independent of role
checking.
**Problem:** Cross-referencing `15-account-types.md`'s tenant-membership model: a `User`-type
account (what Beginners self-registration creates) has "no administrative privileges by
default" and only gains a resolvable profile/context by being *guested* into a tenant-scoped
`Subscription` account. There is no such thing as a bare personal `account` row for a
self-registered Beginners user in this data model -- so this 403 is not specific to
`protectedByRoles` at all. **A freshly signed-up user, with zero guest memberships, cannot pass
ANY `protected` or `protectedByRoles` route, full stop** -- not just the role check.
**Impact on this feature's sequencing (AD-005):** The premise that Phase A could be fully
verified end-to-end (a real chat reply) against the cheap `standalone` + `protected`-routes
stack, before touching Postgres/staff-seed/Mailpit, does not hold -- it was never reachable
without at least one guest membership existing, which requires the same Staff -> tenant ->
subscription -> guest-invite chain Phase B was already going to build for role enforcement.
Phase A's BFF/UI code is still fully validated (correct JWT flow end to end, correct 401/403
mapping, correct account-creation call) -- only the "send hi, get a real reply" leaf of T12's
independent test is gated on Phase B, not on a bug in this feature's own code.
**Prevents:** Re-attempting to get a successful chat reply through `chat-webapp` before Phase
B's account/tenant/subscription/guest-invite chain exists, for any newly-registered user,
regardless of route security group.

### L-003: mycelium-gateway's `/health` endpoint only accepts GET, not HEAD (2026-07-12)

**Context:** Added a Docker healthcheck for `mycelium-gateway` (needed so `chat-webapp`'s
`depends_on: condition: service_healthy` has something to wait on).
**Problem:** `wget -q --spider http://127.0.0.1:8080/health` (the same pattern used
successfully by every other healthcheck in this compose file) failed with HTTP 400 --
`--spider` sends a HEAD request, and the route only handles GET. The error text
(`"Request path does not match any service"`) is the same generic message the gateway's proxy
router uses for an actually-missing route, which reads misleadingly like a routing
misconfiguration rather than a method mismatch.
**Solution:** Use a plain `wget -q -O /dev/null http://127.0.0.1:8080/health` (real GET)
instead of `--spider`.
**Prevents:** Copy-pasting the `--spider` healthcheck pattern onto any other Mycelium
gateway-native (not proxied) endpoint without checking it accepts HEAD first.

---

## Lessons Learned

### L-001: Mycelium's "magic link" is actually email + 6-digit code, not a clickable deep link into the client app (2026-07-12)

**Context:** Verified against the real `mycelium-webapp` source (`services/auth/magic-link.ts`, `HomePage`) and `mycelium-api-gateway`'s `user_endpoints.rs`.
**Problem:** The docs page name ("Magic link") and its diagram suggest a single click-through link; the actual flow is `POST .../magic-link/request` (send email) -> user opens the emailed link, which hits `GET .../magic-link/display` -- a page *rendered by Mycelium itself* showing a 6-digit code -> the client app calls `POST .../magic-link/verify` with `{email, code}` -> receives `{token, type: "Bearer"}`.
**Solution:** The Next.js client replicates this exact two-step (email, then code) form, same as `mycelium-webapp`'s `LoginPage`/`HomePage`. No deep-link handling needed in the Next.js app itself.
**Prevents:** Building a callback route in the Next.js app that never gets hit, or misreading the gateway docs as requiring a token-in-URL flow.

---

## Quick Tasks Completed

| #   | Description                                                        | Date       | Commit  | Status  |
| --- | -------------------------------------------------------------------- | ---------- | ------- | ------- |
| 001 | Removed unused `picoclaw-harness-in-docker-main/` reference dir + stale `.gitignore`/compose comments | 2026-07-12 | pending | Done |

---

## Deferred Ideas

- [ ] Frontend role-based filtering of the instance picker (show only instances the signed-in user has a role for) — Captured during: mycelium-chat-webapp discussion
- [ ] Automated seeding/migration for `alpha`/`beta` GuestRole records — Captured during: mycelium-chat-webapp discussion

---

## Todos

- [ ] None yet — feature spec in progress

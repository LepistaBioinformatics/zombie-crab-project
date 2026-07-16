# onboarding — Discussion Context (gray-area decisions)

A chat-webapp onboarding step: after magic-link signin, a new user who has no
mycelium account yet is shown a "Vamos começar" welcome (with context that
prepares them for the invite-gated reality) whose action creates the account —
instead of the current transparent, invisible account creation.

## Current flow (grounded — `webapp/app/api/auth/verify/route.ts`)

Today, right after `POST /_adm/beginners/users/magic-link/verify`, the BFF
**transparently** calls `POST /_adm/beginners/users` (best-effort, swallowed) to
provision the account, then sets the session and lands the user in the app. The
user never sees or triggers account creation. This feature makes that step
explicit and human.

**Reality to set expectations for (L-005/L-006):** creating the account does NOT
grant chat access — a self-registered user has no resolvable workspace until an
operator invites them into a subscription with a role. So a freshly onboarded
user lands on an empty workspace list; the onboarding must prepare them for that.

## CTX-OB-01: new-user detection via mycelium (probe profile AND account)

**Decision:** after login, detect whether the user already has an account by
probing mycelium — the **user** (from the magic link) is independent of the
**account**. Probe BOTH simultaneously, with the session JWT:
- `GET /_adm/beginners/profile`  (fetch_profile — `#[get("")]`)
- `GET /_adm/beginners/accounts` (get_my_account_details — `#[get("")]`)

If **neither** succeeds (both non-2xx — a user with no account can't resolve a
profile, L-006), the user has **no account → show onboarding**. If **either**
succeeds, the account exists → skip onboarding, go straight to the workspace
list. No persisted flag — mycelium is the source of truth.

**Note (source vs request):** the user suggested `POST`; the mycelium source
decorates both as `#[get("")]`, so the probes are **GET**. Exact scope base
paths (`/_adm/beginners/profile`, `/_adm/beginners/accounts`) to be confirmed
empirically against the running gateway when wiring the BFF (the `/users` sibling
base `/_adm/beginners/users` is already confirmed by the verify route).

## CTX-OB-02: account creation moves from verify → the explicit onboarding action

**Decision:** remove the transparent `POST /_adm/beginners/users` from
`verify/route.ts` (verify only authenticates + sets the session). The "Vamos
começar" button triggers account creation via a BFF onboarding route. Returning
users (account already exists) never see the button.

## CTX-OB-03: onboarding communicates the invite-gated reality

**Decision:** the welcome explains, in the user's terms, that (a) their account
is being created, and (b) workspaces/agents appear once an administrator invites
them into one — so the empty state that follows is expected, not an error. Warm,
guiding copy ("what you'll see next").

## CTX-OB-04: implemented here (webapp), by this agent

**Decision:** unlike `secrets-management-ui` (handed to the front agent), the
user asked this agent to spec AND implement the onboarding in the webapp.
Coordinate with the concurrent front work (check `webapp/` WIP before editing;
prefer new files + the single `verify/route.ts` change to minimize overlap).

## Convention
- `className` via **class-variance-authority** variants (project preference).

## Out of scope
- Changing mycelium's account/user model or endpoints.
- The invite/guest-role assignment itself (operator action in mycelium-webapp).
- Onboarding steps beyond account creation (e.g. profile editing) — welcome +
  create + expectation-setting only.

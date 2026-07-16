# onboarding Specification

Builds on `context.md` (CTX-OB-01..04). A chat-webapp onboarding step that turns
the currently-invisible account creation into an explicit, welcoming "Vamos
começar" flow for users who have no mycelium account yet.

## Problem Statement

After magic-link signin the webapp silently provisions the mycelium account
(`POST /_adm/beginners/users`) inside the verify handler; the user never sees it
and gets no orientation. New users also don't understand that, once the account
exists, they still won't see any workspace until an operator invites them — so
they land on an empty screen with no explanation. We want an explicit onboarding:
detect the account-less user, greet them, explain what comes next, and create the
account on their action.

## Goals
- [ ] After login, detect whether the user already has a mycelium account
      (probe profile + account); route account-less users to onboarding.
- [ ] An onboarding screen: welcome + "what you'll see next" (invite-gated
      reality) + a "Vamos começar" button.
- [ ] The button creates the account via a BFF route; on success it proceeds to
      the workspace list.
- [ ] Remove the transparent account creation from the verify handler.
- [ ] Returning users (account exists) skip onboarding entirely.

## Out of Scope
| Item | Reason |
| --- | --- |
| The invite / guest-role assignment | Operator action in mycelium-webapp |
| Profile editing / multi-step wizard | Welcome + create + expectation only |
| mycelium account/user model changes | Consumed as-is |

---

## User Stories

### P1: Detect the account-less user ⭐ MVP
**Story**: As a just-logged-in user, the app knows whether I still need an
account.
**Acceptance Criteria**:
1. WHEN a signed-in session hits the app entry THEN the server SHALL probe
   `GET /_adm/beginners/profile` AND `GET /_adm/beginners/accounts` with the
   session JWT; if **both** are non-2xx the user is account-less; if **either**
   is 2xx the account exists.
2. WHEN account-less THEN the user SHALL be routed to the onboarding screen; WHEN
   the account exists THEN onboarding SHALL be skipped (straight to the workspace
   list).
3. WHEN the probes fail for connectivity (not auth) THEN the app SHALL show a
   real error, not silently treat the user as account-less.

### P1: Onboarding welcome + create ⭐ MVP
**Story**: I see a "Vamos começar" welcome that explains what's next, and my
click creates my account.
**Acceptance Criteria**:
1. WHEN the onboarding screen renders THEN it SHALL greet the user and explain
   (in plain language) that a "Vamos começar" click creates their account, and
   that workspaces/agents will appear once an administrator invites them.
2. WHEN "Vamos começar" is clicked THEN the client SHALL call the BFF onboarding
   route, which creates the account (`POST /_adm/beginners/users`, JWT); on
   success it SHALL proceed to the workspace list.
3. WHEN account creation fails THEN the UI SHALL show the real error and let the
   user retry (not strand them).

### P1: Verify no longer auto-creates ⭐ MVP
**Story**: Signin only authenticates; account creation is the explicit step.
**Acceptance Criteria**:
1. WHEN `verify/route.ts` succeeds THEN it SHALL set the session but SHALL NOT
   call `POST /_adm/beginners/users` (that moves to the onboarding action).

---

## Requirement Traceability
| ID | Story | Component | Status |
| --- | --- | --- | --- |
| OB-01 | Post-login account detection (probe profile + account) | webapp BFF (`app/api/onboarding` or entry check) + `lib/mycelium` | Pending |
| OB-02 | Route account-less → onboarding; account-exists → workspaces | webapp chat entry / middleware | Pending |
| OB-03 | Onboarding screen: welcome + invite-expectation copy + button | webapp `app/onboarding` | Pending |
| OB-04 | Create account on action via BFF | webapp `app/api/onboarding` | Pending |
| OB-05 | Remove transparent create from verify | `webapp/app/api/auth/verify/route.ts` | Pending |
| OB-06 | Honest errors (connectivity vs real reason); retry | webapp BFF + screen | Pending |
| OB-07 | `className` via cva variants | new components | Pending |

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

---

## Success Criteria
- [ ] A brand-new user, after signin, lands on the onboarding welcome (not a raw
      empty workspace list); "Vamos começar" creates the account and proceeds.
- [ ] The welcome explains the invite-gated next step.
- [ ] A returning user with an account never sees onboarding.
- [ ] `verify/route.ts` no longer creates the account.
- [ ] `next build` (typecheck + compile) is green.

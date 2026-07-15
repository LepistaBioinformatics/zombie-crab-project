# Mycelium Chat Webapp Context

**Gathered:** 2026-07-12
**Spec:** `.specs/features/mycelium-chat-webapp/spec.md`
**Status:** Ready for design

---

## Feature Boundary

A Next.js test client that lets a human sign in via Mycelium magic-link, pick a PicoClaw
instance (alpha/beta), and chat -- plus `mycelium-webapp` added to the compose stack for
account/role administration, plus the gateway config switch to `protectedByRoles`. Frontend
role-based filtering of the instance picker is explicitly out of scope (see spec.md).

---

## Implementation Decisions

### Token/session storage architecture

- Next.js app uses a BFF (backend-for-frontend) pattern: server-side route handlers call
  Mycelium directly; the JWT lives only in an httpOnly cookie set by the Next.js server.
- Chosen over the simpler client-side/localStorage pattern (what the reference `mycelium-webapp`
  itself does), trading build simplicity for not exposing the token to browser JS/XSS.
- Practical implication: the Next.js server needs its own outbound calls to
  `mycelium-gateway` (magic-link request/verify, and forwarding chat/models calls with the
  cookie's JWT as `Authorization: Bearer`) -- it is not a pure static/client-only SPA.
- See STATE.md AD-001.

### `alpha`/`beta` role assignment

- This feature does not seed or auto-assign the `alpha`/`beta` roles to any account.
- Mycelium auto-creates the `GuestRole` *records* for any role slug declared in a
  `protectedByRoles` route on gateway boot -- no seed script needed for that part.
- Actually assigning a signed-up account to `alpha`/`beta` is a manual step through
  `mycelium-webapp`'s guest-role invite screens, documented in the README.
- See STATE.md AD-002.

### Agent's Discretion

- Exact Next.js directory name/location within the repo (plain top-level dir vs. separate repo)
  -- default to a plain top-level directory in `zombie-crab-project`, consistent with this being
  a test client for this repo's own stack rather than a standalone reusable project.
- Published host ports for `mycelium-webapp` and the new Next.js service, and the exact route
  handler names/paths inside the Next.js app.
- Visual design of the chat UI -- functional/minimal is sufficient, this is a test client, not
  a product.

---

## Specific References

- Auth flow must match the *actual* Mycelium contract (verified against
  `mycelium-webapp/src/services/auth/magic-link.ts` and
  `mycelium-api-gateway/ports/api/src/rest/role_scoped/beginners/user_endpoints.rs`), not the
  docs page's simplified diagram: `POST .../magic-link/request` (email) ->
  user opens emailed link -> Mycelium's own `GET .../magic-link/display` page shows a 6-digit
  code -> `POST .../magic-link/verify` (email + code) -> `{ token, type: "Bearer" }`.
- `mycelium-webapp` build: use its own GitHub Dockerfile as build context (git-based, no local
  monorepo source copied in), same posture as this repo's `mycelium/Dockerfile.standalone` for
  the gateway itself.

---

## Deferred Ideas

- Frontend role-based filtering of the instance picker — captured in ROADMAP.md "Future
  Considerations", not part of this feature.
- Automated seeding/assignment of `alpha`/`beta` roles — same, deferred.

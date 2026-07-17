# admin-shared-content — Tasks

Legend: `[P]` = parallelizable with siblings. Gate = `docker build --network=host`
(proxy: go vet + go test) / `next build` (webapp).

## Proxy

### T1 — Layout builders + Scope type
- **What:** add `TenantSharedFilesDir`, `TenantSharedSecretsDir`,
  `SubscriptionSharedFilesDir`, `SubscriptionSharedSecretsDir` to `config.go`;
  add `docker.Scope{Kind,TenantID,SubsAccID}` + `FileMeta`/`UserRef` types.
- **Reuses:** existing builder pattern (root-first, `SanitizeID`).
- **Done when:** builders compile; scaffold creates the empty shared dirs.
- **Depends on:** —

### T2 — Tier resolution (`internal/authz`)
- **What:** `CallerTier(profile, tenantID, subsAccID) Tier` + helpers
  (`AuthorizeSharedScope`, `AuthorizeUserManagement`) implementing the matrix.
- **Reuses:** `LicensedResources.records` scan (per `handlers.go:366`),
  `HasAdminPrivileges()`. Role slugs from `SystemActor`.
- **Done when:** unit tests cover each tier × target; FR-1/FR-1.1/FR-7 encoded.
- **Depends on:** —

### T3 — Manager: shared files + secrets + user-file mgmt + RestartScope
- **What:** implement the 11 `Orchestrator` methods in `docker.Manager`
  (design "Orchestrator additions"); reuse `secrets.go` sink writers + media
  sanitize/store.
- **Done when:** methods compile; shared writes land in the T1 dirs; list/delete
  work; `ListUserFiles` returns metadata only (no bytes); `RestartScope`
  restarts running containers under the scope (best-effort).
- **Depends on:** T1

### T4 — Cascade mounts + shared-secret env in EnsureRunning
- **What:** add the two `.shared/*:ro` binds + shared-secret env layering to the
  container spec (FR-4/FR-5/NFR-2/NFR-3); user secret wins on collision.
- **Done when:** a started container sees tenant/subs shared files read-only and
  the merged env; write to shared content still can't be modified by the agent.
- **Depends on:** T1, T3

### T5 — HTTP handlers + routes + mycelium config
- **What:** the 11 `/v1/admin/*` handlers, gated via T2; register in `Handler()`
  and in `mycelium/config.standalone.toml` (`group="protected"`). Enforce
  `RestartScope` on shared writes/deletes.
- **Done when:** handlers return correct statuses; **no** user-file content/edit
  route exists (FR-7); traversal rejected (NFR-5).
- **Depends on:** T2, T3

### T6 — Authz + handler tests
- **What:** extend `handlers_test.go`: `licensedProfile` variants for
  `tenant-owner`/`tenant-manager`/`subscriptions-manager`/staff; table tests for
  the full matrix + the privacy invariant.
- **Done when:** `go test ./...` green; gate passes.
- **Depends on:** T5

## Webapp

### T7 [P] — BFF routes `app/api/admin/*`
- **What:** forward scopes/shared/shared-secrets/users/user-files to the proxy
  (`fetchMycelium`/`upstreamError`, session token) — mirror `/api/secrets`.
- **Done when:** each route proxies + surfaces upstream errors; `next build` ok.
- **Depends on:** T5 (contract) — can start from the spec in parallel.

### T8 [P] — Admin screen `app/admin/` + nav entry
- **What:** client screen with Shared files / Shared secrets / Members panels;
  entry point shown only when `GET /api/admin/scopes` is non-empty; cva styling;
  reuse existing primitives; **no** view/edit affordance for user files (FR-7).
- **Done when:** screen renders each panel; secrets never display values;
  `next build` ok.
- **Depends on:** T7

### T9 — End-to-end verify + STATE.md
- **What:** build both images (gate); live smoke via magic-link tokens at
  different tiers if feasible; record an `AD-0xx` in `.specs/project/STATE.md`.
- **Depends on:** T4, T6, T8

## Suggested execution order
T1 → T2 → T3 → T4 → T5 → T6, with T7/T8 in parallel once T5's contract is fixed,
then T9.

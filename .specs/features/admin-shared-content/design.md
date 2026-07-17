# admin-shared-content — Design

## Architectural decision

**AD: the admin authorization check is a distinct shape from the chat chain.**
The existing chat check is *self-scoped* — "is the caller licensed for THIS
tenant/subs/agent, as themselves" (`WithWriteAccess().OnTenant().WithRoles([agent]).OnAccount().GetRelatedAccountOrError()`).
Admin ops need *authority-over-target* — "is the caller's tier at/above the
**target scope**, within the same branch". They must not be collapsed into the
chat chain. (FR-1)

The admin routes are **agent-agnostic** for storage but still pass through a
mycelium service (e.g. `picoclaw-alpha/v1/admin/...`) so the existing
`resolveAgent` bearer-token guard (anti-bypass) still applies. The addressed
agent is just the auth vehicle; shared content is stored under tenant/
subscription scope, not per-role.

## On-disk layout (extends config.go builders — single source of truth)

```
data/tenants/<T>/shared/files/            # tenant-scope shared files
data/tenants/<T>/shared/secrets/          # tenant-scope shared secrets (sink formats)
data/tenants/<T>/subscriptions/<S>/shared/files/     # subscription-scope files
data/tenants/<T>/subscriptions/<S>/shared/secrets/   # subscription-scope secrets
data/tenants/<T>/subscriptions/<S>/agents/<R>/users/<U>/  # existing user workspace (private)
```

New builders in `internal/config/config.go`:
`TenantSharedFilesDir`, `TenantSharedSecretsDir`,
`SubscriptionSharedFilesDir`, `SubscriptionSharedSecretsDir` — each taking the
root as first arg (host + container prefixes), every segment through
`identity.SanitizeID`.

## Cascade (down) — mounts + env (FR-4, FR-5, NFR-2, NFR-3)

In `manager.go` `EnsureRunning`, the user container gets, in addition to today's
`hostDir:$HOME/.picoclaw` and `.secrets:ro` binds:

- `TenantSharedFilesDir(host,T)` → `$HOME/.picoclaw/workspace/.shared/tenant:ro`
- `SubscriptionSharedFilesDir(host,T,S)` → `$HOME/.picoclaw/workspace/.shared/subscription:ro`

Both created (empty) on scaffold so the bind source always exists. Shared
**secrets** are resolved from the tenant + subscription shared secret stores and
injected via the **existing secret-sink/env mechanism**, layered **under** the
user's own secrets (user value wins on a name collision).

**Propagation (NFR-4):** a write/delete to a scope's shared content triggers
`RestartScope` — a best-effort restart of running containers under that scope
(tenant scope → all subscriptions under T; subscription scope → that S). New/
idled containers pick up the change on next start regardless.

## Tier resolution (FR-1.1) — `internal/authz` (new, small)

`func CallerTier(p *mycelium.Profile, tenantID, subsAccID string) Tier` where
`Tier ∈ {TierNone, TierSubscription, TierTenant, TierInstance}`:

- `TierInstance` if `p.HasAdminPrivileges()` (`IsStaff || IsManager`).
- `TierTenant` if `p.LicensedResources` has a record with role in
  {`tenant-owner`,`tenant-manager`} and `tenantId == T`.
- `TierSubscription` if a record has role `subscriptions-manager`, `tenantId == T`,
  `accId == S`.
- else `TierNone`.

Role slugs verified in gateway `core/src/domain/actors/mod.rs` (`SystemActor`
`Display`/`str`). Detection scans `LicensedResources.records` directly (the same
records already iterated at `handlers.go:366`), rather than relying on SDK
fluent helpers that don't express "role X on account S".

### Authorization matrix (enforced in proxy)

| Target | view/list/upload/edit/delete |
|---|---|
| Shared tenant scope `T` | tier ≥ Tenant on `T` (Tenant or Instance) |
| Shared subscription scope `S`/`T` | tier ≥ Subscription in branch (Subscription/Tenant/Instance) |
| User `U` private files — **list / delete** | strictly above `U`: Subscription/Tenant/Instance in branch |
| User `U` private files — **view content / edit** | **denied to all** (no endpoint) — FR-7 |

Uploader-retains-edit (CTX-ASC-03) needs no ownership bookkeeping: shared content
is scope-owned, so the manager who uploaded still has scope-tier authority.

## HTTP surface (new handlers in `internal/httpapi/handlers.go`)

All under `/v1/admin`, registered in `Handler()` and in `mycelium/config.standalone.toml`
as `group = "protected"` (authenticated + profile injected; tier enforced in-proxy).

| Method + path | Purpose | Authz |
|---|---|---|
| `GET /v1/admin/scopes` | caller's manageable tenants/subscriptions (FR-8) | authenticated |
| `GET /v1/admin/shared` | list shared files at scope | tier ≥ scope |
| `POST /v1/admin/shared` | upload shared file (multipart) | tier ≥ scope |
| `GET /v1/admin/shared/content` | download a shared file | tier ≥ scope |
| `DELETE /v1/admin/shared` | delete a shared file | tier ≥ scope |
| `POST /v1/admin/shared-secrets` | write shared secret | tier ≥ scope |
| `GET /v1/admin/shared-secrets` | list names only (never values) | tier ≥ scope |
| `DELETE /v1/admin/shared-secrets` | delete shared secret | tier ≥ scope |
| `GET /v1/admin/users` | list users under a subscription | tier ≥ Subscription |
| `GET /v1/admin/users/files` | list a user's private files (**metadata only**) | strictly above user |
| `DELETE /v1/admin/users/files` | delete a user's private file | strictly above user |

Query params: `scope=tenant|subscription`, `tenant_id`, `subs_acc_id`,
`user_acc_id`, `name`. Scope + ids resolve to a `Scope{Kind,TenantID,SubsAccID}`.
`GET /v1/admin/users` enumerates on-disk `.../agents/<R>/users/<U>` dirs. There
is **deliberately no** `GET /v1/admin/users/files/content` and **no** user-file
write/edit endpoint (FR-7).

## Orchestrator additions (`Orchestrator` interface + `docker.Manager`)

```
ListSharedFiles(scope Scope) ([]FileMeta, error)
WriteSharedFile(scope Scope, rawName string, r io.Reader) (StoredMedia, error)
ReadSharedFile(scope Scope, name string) (io.ReadCloser, FileMeta, error)
DeleteSharedFile(scope Scope, name string) error
WriteSharedSecret(scope Scope, format, name, value string) error
ListSharedSecrets(scope Scope) (SecretNames, error)
DeleteSharedSecret(scope Scope, format, name string) error
ListSubscriptionUsers(tenantID, subsAccID string) ([]UserRef, error)
ListUserFiles(key WorkspaceKey) ([]FileMeta, error)   // metadata only
DeleteUserFile(key WorkspaceKey, name string) error
RestartScope(scope Scope) error                        // best-effort (NFR-4)
```

Reuses the existing sink writers (`secrets.go`) for shared secrets, and the
media sanitize/store logic for shared files. `FileMeta{Name,Size,ModifiedAt}`.

## Webapp (FR-9) — `chat-webapp` admin screen

- BFF routes under `webapp/app/api/admin/*` forward to the proxy through a
  service (reusing `fetchMycelium`/`upstreamError`), token from the session
  cookie — same pattern as the existing `/api/secrets`, `/api/media`.
- A new route `webapp/app/admin/` (client): calls `GET /api/admin/scopes` to
  decide visibility; the entry point (a nav item / link) shows **only** when
  scopes is non-empty. Panels: **Shared files** (scope picker → list, upload,
  download, delete), **Shared secrets** (write, list names, delete — never
  shows values), **Members** (per subscription: user list → per user, list
  files + delete; **no view/edit** affordance, matching FR-7).
- `className` via cva (project convention); reuse existing `Input`, `Button`,
  `IconButton`, `Badge`, `Alert`, `ConfirmDialog`, `Spinner` primitives.

## Test strategy
- Go table tests (extend `handlers_test.go` fake orchestrator) for the authz
  matrix: each tier × each target × each op → expected allow/deny, plus the
  privacy invariant (no user-file content/edit path exists; metadata list omits
  bytes). Profile fixtures built with the existing `licensedProfile` helper,
  extended for `tenant-owner`/`tenant-manager`/`subscriptions-manager`/staff.
- Build gate: `docker build --network=host` (go vet + go test) for the proxy;
  `next build` for the webapp.

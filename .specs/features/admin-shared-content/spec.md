# admin-shared-content — Specification

## Summary

An administrative capability that lets each level of the tenant hierarchy
publish **files and secrets** that cascade **downward, read-only**, to every
level below it, while giving higher levels **metadata-level** management (list +
delete) over lower levels — but **never** access to an end user's private file
**content**. End users keep content-level privacy: nobody above them can read or
edit the bytes of their private files, though a higher tier can list and delete
them.

Delivered as: new `/v1/admin/*` endpoints on `crab-shell-proxy`, additional
read-only bind mounts + env injection into user containers, mycelium route
registration, and an administrative screen in `chat-webapp`.

## Tiers (authority, highest → lowest)

Resolved from the mycelium profile mycelium injects (`x-mycelium-profile`). Role
slugs are `SystemActor` string forms verified in
`mycelium-api-gateway/core/src/domain/actors/mod.rs`.

| Tier | Profile signal | Authority |
|---|---|---|
| **Instance** | `IsStaff` or `IsManager` (`HasAdminPrivileges()`) | Everything, all tenants |
| **Tenant** | licensed record role `tenant-owner` or `tenant-manager` on tenant `T` | Everything under `T` |
| **Subscription** | licensed record role `subscriptions-manager` on tenant `T`, account `S` | Everything under `S` |
| **User** | agent guest role (e.g. `alpha`), write on own account | Own private content only |

## Scopes (where content lives)

- **Tenant scope** — content published by a Tenant tier, visible to all of `T`.
- **Subscription scope** — content published by a Subscription tier (or above),
  visible to all of `S`.
- **User scope (private)** — an end user's own uploads/secrets. Content is
  private to that user.

## Functional requirements

### Tier & target resolution
- **FR-1** The proxy resolves the caller's tier from the injected profile, and
  the **target scope** from the request (scope kind + tenant/subs/user ids). The
  admin authorization check compares *caller tier* against *target scope* — a
  distinct check from the existing self-scoped chat chain (see design AD).
- **FR-1.1** A caller is authoritative over a target scope iff the caller's tier
  is at or above the scope's tier **and** within the same branch (same tenant
  `T` for Tenant/Subscription/User targets; same subscription `S` for
  Subscription/User targets). Instance tier is authoritative over all branches.

### Shared files — cascade down (read)
- **FR-2** A Tenant-tier (or Instance) caller can **upload / list / view /
  delete** files in the **tenant scope** of `T`.
- **FR-3** A Subscription-tier caller (or above, within branch) can **upload /
  list / view / delete** files in the **subscription scope** of `S`.
- **FR-4** Tenant-scope files of `T` are mounted **read-only** into every user
  container under `T`; subscription-scope files of `S` are mounted **read-only**
  into every user container under `S`. The agent can read but never modify them
  (kernel-enforced RO bind). Single source of truth — no per-user copies.

### Shared secrets — cascade down (env)
- **FR-5** Tenant-scope and subscription-scope **secrets** follow the same
  authorization tiers as shared files. They are injected as environment into
  every user container below the publishing scope (merged with the user's own
  secrets; reusing the existing secret-sink formats).
- **FR-5.1** The shared-secrets API is **write-only**: POST writes, list returns
  **names only**, DELETE removes. It **never** returns a secret value — matching
  the existing per-user secrets model.

### End-user privacy (metadata-only management)
- **FR-6** A caller strictly **above** an end user in that user's subscription
  branch (Subscription tier of `S`, Tenant tier of `T`, or Instance) can **list**
  (metadata: name, size, modified-at) and **delete** that user's private files.
- **FR-7 (privacy invariant)** **No** admin endpoint ever returns the **bytes**
  of an end user's **private** file, and no admin endpoint permits **editing**
  one. A user's private content never cascades upward. This holds regardless of
  caller tier (including Instance).
- **FR-7.1** Down-cascaded shared content (tenant/subscription scope) **is**
  readable by managers of that scope and above (they own/manage it) and by every
  member below (via the mounted files) — privacy applies only to **user-scope
  private** content.

### Discovery & UI
- **FR-8** An endpoint returns the set of scopes the caller may administer
  (tenants where the caller is Tenant/Instance tier; subscriptions where the
  caller is Subscription tier or above), so the UI can render only what the
  caller controls.
- **FR-9** `chat-webapp` gains an **administrative screen** (visible only to
  callers with any manage authority) to: browse manageable scopes; upload / list
  / view / delete shared files; write / list-names / delete shared secrets; and,
  per subscription, list the users under it and list/delete a user's private
  files **without** content access.

## Non-functional requirements
- **NFR-1** All authorization is enforced **server-side** in the proxy from the
  mycelium-injected profile. The client is never trusted; the webapp screen is
  a convenience, not a gate.
- **NFR-2** Cascade is single-source-of-truth via read-only bind mounts + env
  injection — no content duplication across user directories.
- **NFR-3** The read-only invariant for shared files is kernel-enforced (`:ro`
  bind), consistent with the existing `.secrets:ro` mount.
- **NFR-4** A write to shared content/secrets is picked up by user containers on
  their next (re)start; the proxy makes a **best-effort restart of running
  containers** under the affected scope so changes propagate without manual
  action (mirrors the existing restart-on-secret-write).
- **NFR-5** Every dynamic path segment passes through `identity.SanitizeID`
  before touching the filesystem; the admin API rejects path traversal in
  file names.

## Out of scope
- Changing mycelium's role/account model or its endpoints (roles are consumed as
  injected, not created here).
- Versioning / history of shared files (latest-write-wins).
- Cross-tenant sharing (cascade is strictly within a branch).
- Managing an end user's **secrets** from above (secrets have no metadata worth
  listing beyond names, and per-user secret names are already write-only; only
  **files** get the above-tier list/delete management in v1).

## Traceability
Requirement IDs (FR-*/NFR-*) are referenced by `design.md` components and
`tasks.md` tasks. Gray-area decisions are recorded in `context.md`.

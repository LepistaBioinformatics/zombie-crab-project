# admin-shared-content — Discussion Context (gray-area decisions)

Decisions the user made that shape the spec. Everything else was grounded in
source (mycelium `SystemActor`, the mycelium-sdk-go `Profile`, the existing
proxy layout/mount code) rather than assumed.

## CTX-ASC-01: subscription-manager IS first-class (grounded, not assumed)

The SDK v0.1.0 only surfaces `IsStaff`, `IsManager`, and the `tenant-manager`
role constant, which looked like a gap. Resolved from the gateway source
(`core/src/domain/actors/mod.rs`): `SystemActor` has `TenantOwner`
(`tenant-owner`), `TenantManager` (`tenant-manager`), and
`SubscriptionsManager` (`subscriptions-manager`). These ride in a profile's
`LicensedResources.records` as the `role` field, scoped by `tenantId` and
`accId`, exactly like the agent guest roles. So the proxy detects each tier by
scanning licensed resources for the matching role slug + scope — no new mycelium
work, no invented mapping.

## CTX-ASC-02: implementation scope — proxy + webapp (FINAL)

**Decision:** this agent specs AND implements both the proxy endpoints and the
`chat-webapp` administrative screen. (Unlike `secrets-management-ui`, which was
handed to the front agent.) Coordinate with concurrent front work: prefer new
files, check `webapp/` WIP before editing shared files.

## CTX-ASC-03: edit rights — uploader + tiers above (FINAL)

**Decision:** standard ownership model. When a Subscription manager uploads a
subscription-scope file, that uploader **retains** edit/delete, and every tier
**above** within the branch (Tenant owner/manager, Instance) can also
edit/delete. Members below only read. The user's phrase "somente tenant manager
terá permissão de edição dele" is read as "the tier above *also* gets edit"
(contrasting with read-only members below), **not** "the uploader loses edit."

## CTX-ASC-04: files AND secrets in v1; secrets privacy framing (FINAL)

**Decision:** both shared files and shared secrets ship in v1. Shared secrets at
tenant/subscription scope are injected as **env** into every user container
below and are usable by the agent at runtime; the **API stays write-only**
(POST / list-names / DELETE, never returns a value). Privacy stated precisely:
a user's own **private** content never flows upward; **shared** content flows
downward and is readable by those below — "content privacy" is a guarantee about
**user-scope private** content only (see FR-7 / FR-7.1), not about shared
content.

## CTX-ASC-05: cascade mechanism — read-only bind mounts (decided, not asked)

**Decision (design call, confirmed sound):** down-cascade uses additional
**read-only bind mounts** for files and env injection for secrets — a single
source of truth mirroring the existing `.secrets:ro` bind — rather than copying
content into each user directory. No duplication, no sync problem; the mount
*is* the cascade. Not surfaced to the user because there is a clearly correct
choice consistent with existing patterns.

## CTX-ASC-06: shared secrets via effective `.secrets` mount, not env (revised)

**Decision (revises CTX-ASC-04's env delivery):** shared secrets are no longer
injected as Docker **env** (which is baked at create time and forced a container
**recreate** to update — recreating truncated picoclaw's live session and cut
conversations). Instead the proxy materializes a per-(user,agent) **effective
secret view** = tenant+subscription shared sinks cascaded with the user's own
(user wins), and bind-mounts it **read-only** at `workspace/.secrets` — the same
place picoclaw reads the user's own secrets. So a shared secret arrives as a sink
file (live via the mount) and takes effect on a **stop/start**, never a recreate.
Shared **files** likewise no longer restart anything (live RO bind). Net: no
in-app operation recreates a container, so the transcript is never truncated.
`RestartScope` now stop/starts (was recreate); `recreateByKey` removed. The
managed skill (see `managed-skills`) documents secrets as living in `.secrets`.

## Convention
- `className` via **class-variance-authority** variants (project preference).
- Go: no framework; `net/http`, existing `httpapi`/`docker`/`config` packages.

## Deferred
- Managing end-user **secrets** from above (only files get above-tier
  list/delete in v1 — see spec "Out of scope").
- Shared-file versioning/history (latest-write-wins in v1).

# model-registry-source-of-truth — Specification

## Summary

Replace the two competing model-selection systems in `crab-shell-proxy` with a
single proxy-level **model inventory** backed by an embedded database, which is
the only answer to "which model does this workspace use". The inventory tracks,
alongside each model, which agent instances (per user, per agent) are using it —
so a model cannot be deleted or disabled while in use, and a model in use can be
retired only by **deprecating** it with a named replacement that new users get
while existing users keep the old one.

Supersedes `admin-model-override` (its cascade is absorbed) and the
`registered-models` store (its catalog is migrated). Resolves the webapp feature
`model-list-management`'s deferred Part 2 (full CRUD over models).

## Problem

Two systems write `agents.defaults.provider/model_name` into the same workspace
`config.json` and neither knows about the other:

1. **`admin-model-override`** — `resolveModel` (`internal/docker/model.go:74`)
   resolves a tenant/subscription/user cascade over the models declared in the
   proxy's `config.yaml` (`agent.Models`), keys sourced from environment
   variables.
2. **`registered-models`** — `ApplyRegisteredModelToUser`
   (`internal/docker/registered_models.go:123`) writes a model an admin typed
   into the UI (including its key) straight into one user's workspace.

A `ReapplyModelScope` from (1) runs `resolveModel` for every workspace in scope.
`resolveModel` has no knowledge of (2)'s catalog, so it resolves the scope
default and `reapplyModel` overwrites the registry assignment — no error, no log,
nothing in the UI. The lost choice is unrecoverable because (2) never persisted
"this user was set to model X" anywhere except the file it just clobbered.

Four further defects in the same area, all verified:

- **Keys in the wrong file.** `ApplyRegisteredModelToUser` writes `api_key` into
  the workspace `config.json` `model_list` entry
  (`registered_models.go:158-161`). picoclaw ignores it in schema V2+ (the
  template is `"version": 3`); the effective key is the one in `.security.yml`.
  See CTX-MR-07 for the full verification chain.
- **Inconsistent key.** The registry keys entries on `(provider, name)`
  (`registered_models.go:91`) but the apply path matches the workspace
  `config.json` entry on `model_name` alone (`registered_models.go:165`), so
  `{zhipu, glm-4.7}` and `{openai, glm-4.7}` are both accepted and then collide.
- **No guided selection.** The register form is five free-text fields
  (`app/admin/model-registry-panel.tsx:234-238`); nothing lists the models an
  instance already has.
- **A third writer of model keys.** `validateNativeSlot`
  (`internal/docker/secrets.go:174`) accepts `model_list.<model>.api_keys` as a
  native secret slot, validated against a template's `.security.yml`.

## Functional requirements

### Inventory

- **FR-1** A proxy-level model inventory persists model records keyed by a
  unique `model_name`, each holding: `provider`, `model`, `api_base`, `api_key`,
  optional `auth_method` and `extra_body`, `status`, `replaced_by`, `fallbacks`,
  `position`, `version`, `created_at`, `updated_at`.
- **FR-1b** `fallbacks` is an ordered list of other models' `model_name`s. A model
  may not list itself, and every name listed must exist. `position` orders the
  active list in the UI and has **no functional effect** (CTX-MR-09).
- **FR-2** Create, read, update, delete and reorder the inventory. Reads never
  return `api_key` — only `has_key`.
- **FR-3** `model_name` is unique across the inventory. A duplicate create is
  rejected. (picoclaw permits same-named `model_list` entries as a round-robin
  load-balancing group; the inventory forbids them because `model_name` also
  keys `.security.yml`, so homonyms would share one credential slot.)
- **FR-4** A model's `status` is `active`, `disabled` or `deprecated` per
  CTX-MR-03.
- **FR-5** Deleting a model is rejected while it is referenced by any assignment,
  any scope default, another model's `replaced_by`, or another model's
  `fallbacks`. The rejection enumerates the referrers, so the admin knows exactly
  what to detach first.
- **FR-6** Transitioning a model to `disabled` carries the same precondition as
  FR-5.
- **FR-7** Deprecating a model requires a `replaced_by` naming an existing model
  that is **not `disabled`**. A `deprecated` replacement is legitimate: it is a
  chain link, and resolution hops onward from it until it reaches something
  active — which is what lets an admin retire a series of models incrementally
  rather than having to re-point every predecessor each time. Deprecation chains
  are cycle-free and traversal is bounded (8 hops).
- **FR-8** Each write carries the record's `version`; a stale version is
  rejected with 409 and no write occurs.
- **FR-9** A read-only **suggestion catalog** of known model definitions
  (`provider`, `model`, `api_base`; never a key), embedded in the proxy binary,
  is exposed so the register form can prefill instead of requiring free text.

### Assignment inventory

- **FR-10** For every provisioned workspace the inventory records what was
  materialized, as `{model_name, chain, source, materialized_at}` where
  `model_name` is the primary, `chain` the fallback names written alongside it,
  and `source` is `explicit` (an admin pinned it to this user) or `inherited` (it
  came from a scope default). `chain` is recorded so FR-19's eager triggers and
  FR-25's drift check can see the whole materialized set, not just the primary.
- **FR-11** Scope defaults are stored at `global`, `agent`, `tenant` and
  `subscription` level. `global` and `agent` are instance-wide and therefore
  require proxy-level admin privileges; `tenant` and `subscription` use the
  shared-scope tier check.
- **FR-12** A single resolver returns the effective model and fallback chain for
  a workspace, with the precedence of CTX-MR-04. It is the only such function;
  `resolveModel` and `reapplyModel` are removed and every caller routes through
  it.
- **FR-13** When the resolved model is `deprecated` **and** the workspace has no
  materialized assignment yet, the resolver follows `replaced_by`. A workspace
  that already uses the deprecated model keeps it.
- **FR-14** Which workspaces and scope defaults reference a given model is
  readable, for the UI's usage count and for the FR-5 rejection detail.

### Materialization

- **FR-15** Provisioning materializes the resolved primary plus its declared
  fallback chain into the workspace: full `model_list` entries in `config.json`
  (each `"enabled": true`), `agents.defaults.provider`/`model_name` set to the
  primary, and `agents.defaults.model_fallbacks` to the chain names in order. The
  chain is the primary's own `fallbacks`, expanded **one level only**, with any
  entry that is not `active` skipped and logged.
- **FR-16** Materialized `config.json` `model_list` entries carry **no
  `api_key`**. Each model's key is written to `.security.yml` at
  `model_list.<model_name>.api_keys` as a single-element array, read-modify-write
  so the pico channel token and all sibling keys survive.
- **FR-17** Materialization records or updates the workspace's assignment
  (FR-10).
- **FR-17b** Materialization **prunes** `.security.yml`: a `model_list.<name>`
  entry for a model no longer in the workspace's materialized set is removed.
  Without this the two files drift permanently — `config.json`'s `model_list` is
  replaced wholesale while `.security.yml` is read-modify-write, so every model a
  workspace ever used keeps its key there forever. Pruning must not touch the
  pico channel token, the `web.*` families, or any native-secret overlay slot.
- **FR-18** When no model resolves at any cascade level, provisioning is refused
  with an explicit error rather than producing a workspace picoclaw cannot boot.
- **FR-19** Re-materialization triggers are defined exhaustively:
  - changing a **scope default** re-materializes every established workspace that
    resolves through it (i.e. without a more specific override) — **eager**. A
    workspace with an explicit per-user pin is skipped **entirely**, not merely
    re-materialized to the same bytes: a no-op rewrite is invisible but a restart is
    not, and bouncing someone's agent because a sibling's default changed is what
    AC-7 forbids. A `global` or `agent` change has no scope to sweep and is left to
    each workspace's next start;
  - changing a **per-user assignment** re-materializes that workspace — **eager**;
  - editing a **model's definition or key** re-materializes every established
    workspace whose materialized set contains it — that is, where it is the
    primary **or** appears in the primary's declared chain — **eager**;
  - editing a model's **`fallbacks`** re-materializes every established workspace
    whose primary is that model — **eager**;
  - **reordering** the active list is presentation only (FR-1b) and triggers
    **nothing**;
  - **deprecating** a model triggers nothing immediately — existing users keeping
    the model is the point (FR-13).

  Every eager path is stop/start, never recreate, so the transcript survives.
- **FR-20** The embedded default template ships `"model_list": []` with empty
  `agents.defaults.provider`/`model_name`, and the migration normalizes every
  per-instance disk template `<dataRoot>/templates/<agent>/config.json` to the
  same shape, so no template is ever a source of models (CTX-MR-08). The
  normalization backs the original up to `config.json.pre-registry` first — it is
  the migration's only destructive write.

### Migration

- **FR-21** A one-time import at boot seeds the inventory from, in order:
  `config.yaml` `agent.Model` + `agent.Models` (keys resolved from
  `apiKeyEnv`; `agent.Model` also seeds the agent-level default); the existing
  `registered-models/<agent>.json` files; the existing `shared/model.json` and
  `.crab-model.json` override files (into scope defaults and explicit
  assignments). The per-instance disk template is **not** an import source — it
  is normalized per FR-20.
- **FR-22** The import then records, for every existing workspace, the model its
  `config.json` currently names — as an `inherited` assignment when no explicit
  override was imported for it.
- **FR-23** A workspace whose current model matches nothing imported is imported
  as a model record from that workspace's own `model_list` entry and
  `.security.yml` key, flagged and logged for admin review.
- **FR-24** Superseded files (`registered-models/*.json`, `shared/model.json`,
  `.crab-model.json`) are left on disk but no longer read; the proxy logs that
  they are being ignored.
- **FR-25** Every subsequent boot runs a drift check comparing each workspace's
  `config.json` — its active model **and** its `model_fallbacks` — against the
  recorded assignment's primary and `chain`, logging mismatches without
  auto-correcting.

### Admin surface

- **FR-26** Inventory CRUD, reorder, deprecate, usage and suggestion-catalog
  reads require proxy-level admin privileges (the caller supplies API keys with
  instance-wide blast radius), as do the `global` and `agent` scope defaults.
  `tenant` and `subscription` defaults reuse the shared-scope tier check;
  per-user assignment reuses the user-management check.
- **FR-27** The admin UI lists the inventory as two groups — active (ordered by
  `position`, reorderable as presentation) and inactive (`disabled` or
  `deprecated`, badged with the reason and, for deprecated, the replacement) —
  each row showing provider, api_base, whether a key is stored, its usage count,
  and its declared fallback chain.
- **FR-27b** A model's `fallbacks` list is editable as an ordered selection of
  other `active` models, and the UI states plainly that this list — not the
  listing order — is what becomes `agents.defaults.model_fallbacks`.
- **FR-28** The register/edit form is driven by the suggestion catalog: picking a
  known model prefills `provider`, `model` and `api_base`, with a manual option
  for anything else, plus `model_name` and `api_key`.
- **FR-29** An existing model can be **duplicated** into the form — every field
  prefilled except `model_name` (blank, since it must be unique) and `api_key`
  (blank, since keys are never read back).
- **FR-30** Delete and disable are visibly unavailable, with the reason, while a
  model is in use. Deprecation prompts for the replacement.
- **FR-31** A 409 from a stale version surfaces as "another admin changed this —
  reload", not a generic failure.

### Native secret slot

- **FR-32** `validateNativeSlot`'s `model_list.<model>.api_keys` family validates
  the model against the inventory instead of a template `.security.yml`. Its
  overlay precedence over the inventory key is documented (CTX-MR-12).

### Gateway routing

- **FR-33** Every new admin route must be reachable through the mycelium gateway.
  **Already satisfied — verified during execution, no change required.** The
  per-mode deploy configs (`deploy/standalone/config.standalone.toml`,
  `deploy/prod/config.base.toml`, `deploy/dokploy/config.base.toml`) collapsed the
  per-route admin allowlist into a single wildcard per service —
  `path = "/v1/admin/*"` with `methods = ["GET", "POST", "PUT", "DELETE"]` — whose
  own comment states that the proxy enforces the exact path and method per route.
  Every route this feature adds is therefore already routed, and there are no
  superseded per-route entries left to drop.

  This supersedes the original requirement, which was written against the
  pre-consolidation layout (`fungi/mycelium/config.{base,standalone}.toml`, one
  block per route, precedent `c89570c`). Those paths no longer exist: parent commit
  `91c506d` moved the files under `deploy/` and the wildcard replaced the
  enumeration. Adding per-route blocks beside the wildcard would be redundant.

  **The gateway reload is still a deploy step** — not for new paths, but because a
  running gateway holds its config in memory.

## Non-functional

- **NFR-1** Storage is a pure-Go embedded database — the proxy builds with
  `CGO_ENABLED=0` (`Dockerfile:15`), so cgo-linked SQLite is unavailable.
- **NFR-2** The database file lives on the persisted data volume, outside every
  per-workspace tree so `chownTree` never touches it, root-owned 0600.
- **NFR-3** Each mutation is one write transaction, so a check-then-write cannot
  interleave with another admin's write.
- **NFR-4** No API response ever contains a model `api_key`.
- **NFR-5** Re-materialization is stop/start only, never recreate.
- **NFR-6** Authorization is decided server-side in the proxy from the injected
  profile; the UI mirrors it but is not the gate.
- **NFR-7** Migration is idempotent — a second boot with the schema marker
  present is a no-op.

## Out of scope

- **Hermes agents.** They keep reading `config.yaml`'s `agent.Model` (CTX-MR-13);
  their key reaches the container as an environment variable, a different
  mechanism entirely. Folding them in is a follow-on.
- **Transitive fallback expansion.** A primary's `fallbacks` is expanded one level
  only (FR-15), matching picoclaw's flat `model_fallbacks`. Walking a fallback's
  own fallbacks is not done.
- **End-user model switching** per conversation.
- **Deleting the superseded on-disk files** (FR-24 leaves them).

## Acceptance criteria (EARS)

- **AC-1** WHEN an admin registers a model whose `model_name` already exists
  THEN the system SHALL reject it with 409 and write nothing.
- **AC-2** WHEN an admin applies a model to a user and inspects that workspace
  THEN `config.json`'s `model_list` entry SHALL contain no `api_key` field AND
  `.security.yml` SHALL contain `model_list.<model_name>.api_keys` with the key
  AND SHALL contain no `model_list` entry for any model outside the workspace's
  materialized set, AND the pico channel token SHALL be unchanged.
- **AC-3** WHEN an admin deletes a model that any workspace or scope default
  references THEN the system SHALL respond 409 naming the referrers and write
  nothing.
- **AC-4** WHEN an admin sets a model in use to `disabled` THEN the system SHALL
  reject it with the same 409 as AC-3.
- **AC-5** WHEN an admin deprecates a model without naming a replacement, or
  names one that is absent, `disabled`, or itself, THEN the system SHALL respond
  400 and write nothing. WHEN the named replacement is `deprecated` THEN the
  deprecation SHALL succeed, because resolution hops onward from it (FR-7).
- **AC-6** WHEN a model is deprecated with replacement `Y` AND a new user
  provisions under a scope whose default is the deprecated model THEN that new
  workspace SHALL be materialized with `Y`, AND every workspace already using the
  deprecated model SHALL keep it.
- **AC-7** WHEN a subscription default changes THEN every established workspace
  under it without an explicit per-user assignment SHALL be re-materialized and
  the running ones restarted, AND a workspace with an explicit assignment SHALL be
  neither re-materialized **nor restarted**.
- **AC-8** WHEN both a per-user assignment and a subscription default apply to a
  workspace THEN the per-user assignment SHALL win.
- **AC-9** WHEN a workspace provisions and no model resolves at any cascade level
  THEN the system SHALL refuse with an explicit error AND create no container.
- **AC-10** WHEN a write carries a stale `version` THEN the system SHALL respond
  409 and write nothing.
- **AC-11** WHEN the proxy boots against a data root holding pre-migration state
  THEN every existing workspace SHALL end with a recorded assignment naming the
  model its `config.json` currently uses, AND no workspace's active model SHALL
  change as a result of the migration alone.
- **AC-12** WHEN the proxy boots a second time THEN the migration SHALL be a
  no-op.
- **AC-13** WHEN a caller without proxy-admin privileges calls any inventory
  mutation THEN the system SHALL respond 403 and write nothing.
- **AC-14** WHEN an admin duplicates a model in the UI THEN the form SHALL be
  prefilled with every field except `model_name` and `api_key`, both blank.
- **AC-15** WHEN a model's `fallbacks` list is `[B, C]` AND a workspace resolves
  to that model THEN that workspace's `agents.defaults.model_fallbacks` SHALL be
  `[B, C]` in that order, AND its `config.json` `model_list` SHALL contain exactly
  the primary plus `B` and `C`, AND its `.security.yml` SHALL hold exactly those
  three keys.
- **AC-15b** WHEN a model listed in a primary's `fallbacks` is not `active` THEN
  it SHALL be skipped in the materialized chain and the skip logged.
- **AC-15c** WHEN an admin deletes or disables a model that appears in another
  model's `fallbacks` THEN the system SHALL respond 409 naming that model, AND
  after the admin removes it from that list the same operation SHALL succeed.
- **AC-16** WHEN a native secret names `model_list.<model>.api_keys` for a model
  absent from the inventory THEN validation SHALL reject it.
- **AC-17** WHEN the migration completes THEN every per-instance disk template's
  `config.json` SHALL have an empty `model_list` and empty
  `agents.defaults.provider`/`model_name`, AND every workspace that was using a
  model only declared in that template SHALL still resolve to it (via its own
  imported record).
- **AC-18** WHEN an admin edits a model's `api_base` or `api_key` THEN every
  established workspace whose materialized set contains that model — as primary or
  as a chain member — SHALL be re-materialized and the running ones restarted, AND
  workspaces without it SHALL be untouched.
- **AC-19** WHEN an admin reorders the active list THEN no workspace SHALL be
  re-materialized or restarted, and no materialized file SHALL change.

## Traceability

| Repo | Artifacts |
|---|---|
| `crab-shell-proxy` | `.specs/features/model-registry-source-of-truth/` — storage, resolver, materialization, migration, HTTP |
| `crab-exoskeleton-webapp` | `.specs/features/model-registry-source-of-truth/` — BFF routes, admin panel |
| parent (this repo) | no gateway change needed (FR-33 already satisfied by the `/v1/admin/*` wildcard in `deploy/*/config*.toml`); submodule pointer bumps and `.specs/` only |

## Status

Spec written 2026-07-25. Design in `design.md`. Tasks pending.

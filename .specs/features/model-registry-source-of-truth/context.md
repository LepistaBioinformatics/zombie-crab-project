# model-registry-source-of-truth — Context

User decisions captured during discussion (2026-07-25). These are binding; the
spec and design derive from them.

## CTX-MR-01 — One source of truth, one resolver

The proxy owns a **model inventory** in an embedded database. It is the only
place that answers "which model does this workspace use". `resolveModel` and
`reapplyModel` (`internal/docker/model.go`) are **deleted**; `config.yaml`'s
`agent.Model` / `agent.Models` stop being read at runtime and become migration
seed only.

**Why:** today two systems write `agents.defaults.provider/model_name` into the
same workspace `config.json` — the `config.yaml`-backed override cascade
(`resolveModel`) and the on-disk model registry (`ApplyRegisteredModelToUser`).
The first does not know the second exists, so any `ReapplyModelScope` silently
overwrites a registry assignment with no error, no log and no way to recover the
lost choice (it was never persisted anywhere but the file it just clobbered).

## CTX-MR-02 — Inventory is global at proxy level

Models are registered at the proxy, not per agent. Every picoclaw agent may use
every registered model; there is no per-model agent allowlist. Which workspace
gets what is decided by scope defaults and per-user assignment, not by
partitioning the catalog.

**Consequence accepted:** the admin can pick a model that a given harness cannot
serve. Mitigated only by scoping the inventory to picoclaw agents this cycle (see
CTX-MR-13).

## CTX-MR-03 — Three lifecycle states, not a boolean

`Status ∈ {active, disabled, deprecated}`.

- **active** — offered; may be a scope default or a new assignment.
- **disabled** — not offered, and **nothing may be using it**. Reversible.
  For staging a model before rollout, or shelving an unused one.
- **deprecated** — not offered to new users, but existing users keep it.
  **Requires a replacement** naming an `active` model. This is the only way to
  retire a model that is in use.

**Why not `enabled bool` + a deprecation timestamp:** the two inactive states
have opposite preconditions (one demands zero usage, the other exists precisely
because usage persists). One enum makes the invariants unambiguous and maps
directly onto the two-list UI.

## CTX-MR-04 — Resolution cascade

```
per-user assignment > subscription default > tenant default > agent default > global default
```

Same order the deleted `resolveModel` used, with a global level added below the
agent level. No resolvable model at any level is an error, never a silent
default (CTX-MR-10).

## CTX-MR-05 — Referential integrity

Delete and transition-to-`disabled` are both blocked while the model is
referenced by any assignment, any scope default, or another model's
`replaced_by`. The rejection names the referrers. Together these two rules are
the guarantee that no workspace ever points at a model absent from the
inventory.

## CTX-MR-06 — Concurrency: transaction plus optimistic version

Every write runs inside one database write transaction, so a check-then-write
(e.g. "nobody uses this" then delete) cannot race. Each model record carries a
`version`; a write with a stale version returns **409** and the UI tells the
admin to reload.

Chosen over a visible advisory edit lock: no TTL to tune, no stale-lock recovery
when an admin closes the tab, and the proxy is single-instance so transaction
serialization is already sufficient for correctness. The trade-off accepted is
that a conflict surfaces at save time rather than at edit time.

## CTX-MR-07 — Model API keys live only in `.security.yml`

A materialized `config.json` `model_list` entry carries **no `api_key` field**.
The key goes to `.security.yml` under `model_list.<model_name>.api_keys` (array,
always — even for a single key).

**Verified:** picoclaw removed `api_key` (singular) from `config.json` in schema
V2+ and ignores it; the shipped template is `"version": 3`. Independently
confirmed in-repo: picoclaw containers receive only `PICOCLAW_GATEWAY_HOST` and
`HOME` (`internal/docker/manager.go:307`), so there is no environment fallback
that could mask a broken write — `.security.yml` is the only path that works,
and `applyModel` (`provision.go:143`) already proves it does. The comment at
`internal/docker/registered_models.go:155-157` claiming otherwise is stale: it
describes an `sk-dummy-placeholder` in the template `model_list` that does not
exist in any of the template's 30 entries.

## CTX-MR-08 — Templates ship no models; the suggestion catalog is separate

Both the embedded `internal/docker/defaulttemplate/picoclaw/config.json` and the
per-instance disk template `<dataRoot>/templates/<agent>/config.json` stop being
a source of models. Provision overwrites `model_list` wholesale from the
inventory, and the migration **normalizes the on-disk template** to
`"model_list": []` with empty `agents.defaults.provider`/`model_name` rather than
importing it — user-directed, so no competing source survives anywhere.

**Consequence accepted:** a template model that no workspace uses and that is not
a scope default is dropped. Models actually in use are preserved regardless,
because the migration reads each workspace's own `config.json` and `.security.yml`
(CTX-MR-11). Re-registering a dropped model is a few clicks now that the
suggestion catalog prefills the form.

The 30 entries currently in the embedded template move to a separate embedded,
read-only **suggestion catalog** (`provider` + `model` + `api_base`, never a
key), served to the register form so the admin picks instead of free-typing.
It is never copied into any workspace.

## CTX-MR-09 — Each model declares its own fallback list

Each model carries `fallbacks []string`, an ordered list of other models' names.
The chain materialized into a workspace is the resolved primary's own `fallbacks`,
in declared order, written to `agents.defaults.model_fallbacks`. This is picoclaw's
own field shape (`ModelConfig.Fallbacks`). Expansion is **one level only** — no
transitive walk — matching picoclaw's flat `model_fallbacks`.

**Why not a single global ordered list** (the first shape considered, and closer
to how the requirement was originally phrased): a global order makes the chain
"every active model", so every active model is materialized into every workspace.
That breaks referential integrity in a way that has no clean repair. A model that
is `active` but primary nowhere would have zero referrers, so it could be deleted
while every workspace still names it in `model_fallbacks` — and editing its key
would propagate nowhere, leaving fallbacks on a revoked credential. Counting chain
membership as a reference instead deadlocks: every active model is referenced by
every workspace, so nothing could ever be deleted or disabled. And more broadly,
any change to the active set or to any active model's credentials would become a
fleet-wide change.

A declared per-model list fixes all of it: chain membership is a countable
reference, so delete and disable block naturally; the blast radius of a change is
bounded to the models that declare it; and key spread is bounded to declared
chains rather than reaching every workspace.

**The reorderable listing survives as presentation.** Each model keeps a
`position` that orders the active list in the UI. It has **no functional effect** —
reordering never re-materializes anything and never restarts a workspace.

## CTX-MR-10 — No resolvable model refuses to provision

`ErrNoModelResolvable` returns 409 with an explicit message rather than
provisioning. **Verified:** picoclaw fails at startup when
`agents.defaults.model_name` does not match a `model_list` entry, so a workspace
provisioned without a model would be permanently unbootable.

## CTX-MR-11 — Migration captures current reality at boot

A one-time import inside `Reconcile` seeds the inventory from every existing
source and records, for every existing workspace, the model its `config.json`
currently names. Without this, existing users read as unassigned and get
re-resolved to a scope default on the first reapply — the exact orphaning this
feature exists to prevent.

## CTX-MR-12 — The native `model_list.*.api_keys` slot becomes a scope override

`validateNativeSlot` (`internal/docker/secrets.go:174`) currently accepts
`model_list.<model>.api_keys` and validates the model against a template's
`.security.yml`. It is repointed to validate against the **inventory**.

Because `applyNativeSecrets` runs after model materialization
(`provision.go:86` after `provision.go:60`), a scope-level native secret for a
registered model deliberately overrides the inventory key for that scope. This
is a layered override with defined precedence, not a competing writer, and it
preserves the existing ability of a scope admin to supply their own key.

**Flagged for review:** the stricter alternative is to drop the slot entirely so
model credentials have exactly one home. That removes a capability scope admins
have today.

## CTX-MR-13 — Hermes is out of scope this cycle

`provisionHermes` (`internal/docker/provision_hermes.go`) uses a different model
shape: `config.yaml` with `base_url`, and the key injected as a container
environment variable under `keyEnvName` (`provision_hermes.go:177`). It keeps
reading `config.yaml`'s `agent.Model` this cycle.

**Consequence stated plainly:** "single source of truth" holds for picoclaw
agents only until hermes is folded in. That is a follow-on decision, not an
oversight.

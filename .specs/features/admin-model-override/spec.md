# admin-model-override — Specification

## Summary

Let tenant/subscription admins change the LLM **model** of already-established
workspaces from the admin screen — for a single user, or for everyone at their
authority level (a tenant admin → all workspaces in the tenant; a subscription
admin → all in the subscription). Follows the `admin-shared-content` tier/authz
pattern, adds a **model override** cascade with a **per-user** layer, and
re-applies to live workspaces immediately.

## Context (how the model works today — verified)

- The model is pinned **per agent** in `config.yaml` (`agent.Model` =
  `{provider, name, apiKeyEnv}`) and applied at **provision** time into the
  workspace's `config.json` + `.security.yml` by `applyModel` (`internal/docker/provision.go`).
  There is no per-workspace/per-user override today; every user of an agent gets
  that agent's configured model.
- The model is read from config files at picoclaw **start**, so a re-applied
  model takes effect on a **stop/start** (no recreate) — unlike bind mounts.
- Valid models are those in the agent's picoclaw `model_list` (provider+name).

## Decisions (from discuss, 2026-07-20)

- **CTX-AMO-01 Granularity + precedence:** override stored at three levels —
  **tenant**, **subscription**, **user** — resolved **user > subscription >
  tenant > agent-default** when provisioning/applying a workspace.
- **CTX-AMO-02 Authority:** who may set which override reuses the
  `admin-shared-content` tier check — a Tenant tier may set the tenant override
  (and any subscription/user under it); a Subscription tier may set the
  subscription override (and any user under it). "Apply to all at my level" =
  set the scope-level override (it cascades to all workspaces below without a
  per-user write). "Change one user" = set that user's override.
- **CTX-AMO-03 Apply to established workspaces (immediate):** on change, re-apply
  the resolved model to the affected **already-provisioned** workspaces'
  `config.json`/`.security.yml` and **restart running containers now**
  (stop/start, reload config); stopped/scale-to-zero workspaces pick it up on
  their **next start** (re-apply at provision/start). No recreate.
- **CTX-AMO-04 Allowed models:** any model in the agent's picoclaw `model_list`
  (valid provider+name); no new keys introduced.

## Functional requirements

- **FR-1** Store a model override per scope: tenant `<root>/tenants/<t>/shared/model`,
  subscription `<root>/tenants/<t>/subscriptions/<s>/shared/model`, and per user
  `<root>/tenants/<t>/subscriptions/<s>/<role>/users/<u>/model` (exact paths in
  design). Each holds a `{provider, name}` selection.
- **FR-2** `resolveModel(agent, key)` returns the effective model:
  user → subscription → tenant → `agent.Model` (default). Used by `provision`
  in place of the raw `agent.Model`.
- **FR-3** Admin API to get/set/clear the override at a target level, authorized
  by the caller's tier vs the target (reuse `authz.AuthorizeSharedScope` for
  tenant/subscription; a per-user target requires authority over that user's
  subscription).
- **FR-4** Setting/clearing an override **re-applies** the resolved model to all
  affected established workspaces and restarts the running ones (reuse
  `RestartScope`; extend so the restart/provision path re-runs `applyModel` with
  the resolved model). Per-user change affects only that workspace.
- **FR-5** Validation: the chosen `{provider, name}` must exist in the agent's
  `model_list`; otherwise 400, nothing written.
- **FR-6** Admin UI: a **Model** control in the admin screen, scoped by the
  existing scope tree — pick a model and apply at tenant/subscription level, plus
  a per-user override list (mirrors the members panel for the per-user case).
- **FR-7** Reading the current effective model + which level set it, for display.

## Non-functional

- **NFR-1** Authorization server-side in the proxy from the injected profile.
- **NFR-2** Re-apply is stop/start only (never recreate — preserves transcript).
- **NFR-3** No secrets/keys in the override store (only provider+name); the API
  key stays sourced from env at apply time as today.

## Out of scope

Adding new models/providers/keys (only what `model_list` already declares);
per-conversation model switching by end users; model switching for the
`admin-shared-skills`/agents features.

## Acceptance criteria (EARS)

- **AC-1** WHEN a subscription admin sets the subscription model override to a
  valid `model_list` entry THEN every established workspace under `S` (that has
  no user-level override) SHALL be re-applied that model and running ones
  restarted, and new provisions under `S` SHALL use it.
- **AC-2** WHEN a tenant admin sets a single user's override THEN only that
  user's workspace SHALL change; sibling users SHALL be unaffected.
- **AC-3** WHEN both a subscription override and a user override exist for a
  workspace THEN the **user** override SHALL win.
- **AC-4** WHEN the chosen model is not in the agent's `model_list` THEN the
  system SHALL respond 400 and write nothing.
- **AC-5** WHEN a caller lacks authority over the target level/branch THEN 403,
  nothing written.
- **AC-6** Re-apply SHALL stop/start affected running containers (no recreate).

## Status: spec (design/tasks pending)

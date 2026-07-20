# admin-model-override — Design

Mirrors `admin-shared-content` (tiers/authz/BFF/admin-screen) and adds a model
override cascade. Keys stay backend-only (CTX-AMO-06).

## Config (proxy `internal/config/config.go`)

Extend `Agent` with a selectable model list (the default `Model` stays):
```go
type Agent struct {
    // ...existing...
    Model  *ModelConfig   // default (fallback)
    Models []*ModelConfig // selectable allowlist (each provider/name/apiKeyEnv)
}
```
On load, resolve each `Models[i].APIKey` from its `APIKeyEnv` (like `Model`).
Validation: each entry needs provider+name; a `{provider,name}` may appear once.
If `Models` is empty, only `Model` is selectable. Helper:
`func (a Agent) SelectableModels() []*ModelConfig` (default + Models, deduped by
provider/name) and `func (a Agent) FindModel(provider, name string) *ModelConfig`.

## Override store (proxy)

Files holding a `{ "provider": "...", "name": "..." }` JSON selection:
- tenant: `config.TenantModelOverrideFile(root, t)` = `<root>/tenants/<t>/shared/model.json`
- subscription: `config.SubscriptionModelOverrideFile(root, t, s)` = `<root>/tenants/<t>/subscriptions/<s>/shared/model.json`
- user: `config.UserModelOverrideFile(root, t, s, role, u)` = `<userWorkspace>/.crab-model.json` (dotfile picoclaw ignores, beside `.crab-owner.json`)

New `internal/docker/model.go`:
```go
type ModelSel struct { Provider, Name string }
func (m *Manager) getModelOverride(path string) (*ModelSel, error)   // nil if absent
func (m *Manager) setModelOverride(path string, sel ModelSel) error  // validated by caller
func (m *Manager) clearModelOverride(path string) error
// resolveModel returns the effective ModelConfig for a workspace: user > sub >
// tenant override (each mapped to an agent selectable entry) else agent.Model.
// An override whose {provider,name} is no longer selectable falls back to the
// default and logs.
func (m *Manager) resolveModel(agent config.Agent, key WorkspaceKey) *config.ModelConfig
```

## Apply / re-apply (proxy)

- `provision` uses `resolveModel(agent, key)` in place of the raw `agent.Model`
  on first provision (so a new workspace under an overridden scope is born with
  the right model).
- **Re-apply to established workspaces** — new `reapplyModel(userDir, model)`:
  rewrite ONLY `config.json`'s `agents.defaults.provider`/`model_name` and the
  `.security.yml` `model_list` entry for the model's key, **preserving the
  existing pico token and any merged native secrets** in `.security.yml` (do NOT
  regenerate the token or drop other model_list entries — read-modify-write, not
  the overwrite `applyModel` does on first provision). Idempotent.
- On override change, iterate affected established workspaces (dirs under the
  scope), `reapplyModel` each, then `RestartScope`-style stop/start of the
  running ones so picoclaw reloads the model at start. Stopped ones re-apply on
  next `provision`/start. **No recreate.**
  - Reuse/extend `RestartScope`: add per-key `reapplyModel(resolveModel(...))`
    in its loop (next to the secrets/skills sync), and ensure the
    provision/start path also re-applies (so stopped→started picks it up).

## HTTP API (proxy `internal/httpapi/admin.go` + `handlers.go`)

Reuse `s.resolveSecretCaller`, `s.adminScope`, `authz.AuthorizeSharedScope`.
```
GET  /v1/admin/models            -> list SELECTABLE models {provider,name} for the caller's agent (NO keys)
GET  /v1/admin/model             -> current effective override at a scope/user (+ which level set it)
PUT  /v1/admin/model             -> set override {scope|user target, provider, name}; validate in allowlist; re-apply + restart
DELETE /v1/admin/model           -> clear override at a target; re-apply (falls back to next level) + restart
GET  /v1/admin/model/users       -> per-user overrides under a subscription (mirror /users) for the per-user UI
```
- A per-user target adds `user_acc_id` (authorized by authority over that user's
  subscription).
- **Never** include any API key in a response (CTX-AMO-06). The models list is
  provider/name only.

## Gateway (fungi/mycelium both configs, alpha+beta)

Add `[[picoclaw-*.path]]` blocks (`group="protected"`, matching secretName,
`acceptInsecureRouting=true`): `/v1/admin/models` (GET), `/v1/admin/model`
(GET,PUT,DELETE), `/v1/admin/model/users` (GET).

## Webapp (crab-exoskeleton-webapp)

- `lib/adminModels.ts` (new, don't touch lib/admin.ts): `SelectableModel{provider,name}`,
  `listSelectableModels()`, `getModelOverride(target)`, `setModelOverride(target, sel)`,
  `clearModelOverride(target)`, `listUserModelOverrides(scope)`.
- BFF routes `app/api/admin/models/route.ts`, `app/api/admin/model/route.ts`
  (GET/PUT/DELETE), `app/api/admin/model/users/route.ts` — forward via
  `proxyAdminJson`. Keys never present (backend strips).
- `app/admin/model-panel.tsx`: a scope-level model picker (dropdown of selectable
  models; shows current + which level set it; Apply / Reset-to-inherited) plus a
  per-user override list (each user: current model + override/clear). Wire a
  `"model"` tab into `admin-screen.tsx`.

## Testing

- Proxy: `resolveModel` precedence (user>sub>tenant>default; stale override →
  default); override get/set/clear round-trip; `reapplyModel` updates config.json
  provider/model_name and the .security.yml key WITHOUT changing the pico token
  or dropping merged secrets (construct a .security.yml with a token + a native
  secret, reapply, assert token + secret survive); validation rejects a
  {provider,name} not in the allowlist. Handler test: PUT unauthorized → 403;
  PUT unknown model → 400; response bodies contain NO api key.
- Webapp: tsc + build; assert BFF/list responses never carry a key field.

## Out of scope
Adding models/keys the operator hasn't declared in config.yaml; per-conversation
end-user switching.

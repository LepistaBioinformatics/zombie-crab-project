# admin-model-override — Context (user decisions)

## CTX-AMO-01..04
See spec.md "Decisions": three-level override (tenant/subscription/user),
precedence user>sub>tenant>agent-default; authority via the shared-content tier
check; re-apply to established workspaces immediately (stop/start, no recreate);
allowed models come from the picoclaw `model_list`.

## CTX-AMO-05: Selectable models are declared per-agent in the proxy config.yaml
The proxy realizes "the model_list the admin can pick from" as a per-agent
**list of models in `config.yaml`**, each `{provider, name, apiKeyEnv}` — the
operator declares which models are switchable and where each one's key lives in
the environment. The default `agent.Model` remains the fallback.

**Why:** the proxy currently knows only one model+key per agent; a switch needs
the target model's key. Sourcing the list (and keys-by-env) from config.yaml is
the only option that satisfies CTX-AMO-06.

## CTX-AMO-06: API keys are backend-only — never transit the API (hard security rule)
The model-override API and the webapp handle **only `{provider, name}`**. An API
key MUST NEVER appear in any API response or reach the client. If a key hint is
ever surfaced to an operator, it is **masked** (only first/last few characters),
computed server-side; the raw key is never serialized past the proxy. Keys stay
in environment variables (`apiKeyEnv`), exactly as today.

## Open design points (resolved in design.md)
- Exact override-file paths + JSON shape.
- How `resolveModel` maps an override `{provider,name}` to a full `ModelConfig`
  (must match an entry in the agent's configured selectable list; else fall back
  to default + log).
- How to re-apply a changed model to an ESTABLISHED workspace without corrupting
  the pico token or the merged native secrets in `.security.yml`.

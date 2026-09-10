# web-search-providers — Specification (authoritative)

**Status:** Harness implemented; the admin surface (R5) is partly built. See "Implementation status" below.
**Date:** 2026-09-10.
**Spans:** `crab-ganglion-harness`, `crab-shell-proxy`, `crab-exoskeleton-webapp`.
**Closes:** `crab-ganglion-harness` spec DF-6 ("built-in `web_search` / `web_fetch`").
**Depends on:** `ganglion-model-registry` FR-1 (the config file) and FR-4.1 (`enc://`).

## Problem

A ganglion agent has exactly one tool: `shell`. It cannot search the web. picoclaw
ships ten search providers (`pkg/tools/integration/web.go`) — Brave, Tavily, Kagi,
Perplexity, SearXNG, GLM, Baidu, Gemini grounding, DuckDuckGo, Sogou — behind one
`web_search` tool, selected by a fixed priority order.

The ask is *"permita o registro de provedores de busca … O usuário deve conseguir
registrar igual acontece no picoclaw"*. In picoclaw, "registering" means editing
`config.json` and `.security.yml` by hand. **In this stack that surface does not
exist for a member or an admin**: `config.json` is materialized by the proxy and
`.security.yml` is admin-only by an explicit decision
(`native-secrets-admin-only`). So "the same as picoclaw" has to mean *the same
providers and the same configuration keys*, reached through the admin UI.

Half of it is already here and nobody can see it. `lib/secrets.ts` carries:

```ts
export const WEB_PROVIDERS = ["brave","tavily","kagi","gemini","perplexity","glm_search","baidu_search"];
```

and the proxy's `validateNativeSlot` accepts `web.<provider>` as a native secret
slot. So an admin can already store a Brave key for a **picoclaw** agent. What is
missing is: enabling a provider (as opposed to keying it), choosing which one is
preferred, and a harness that uses any of it.

## What is being built

**R1 — a `web_search` tool in ganglion**, name and JSON schema byte-compatible
with picoclaw's (`web.go:1923-1953`):

```json
{"type":"object",
 "properties":{
   "query":{"type":"string","description":"Search query"},
   "count":{"type":"integer","minimum":1,"maximum":10},
   "range":{"type":"string","enum":["d","w","m","y"]}},
 "required":["query"]}
```

and returning picoclaw's exact result text, so a prompt written for one harness
reads identically on the other:

```
Results for: <query>
1. <title>
   <url>
   <snippet>
```

**R2 — a `web_fetch` tool**, retrieving one URL as text, capped at 50 000
characters as picoclaw caps it (`defaultMaxChars`).

**R3 — providers, v1 set.** `brave`, `tavily`, `searxng`, `duckduckgo`. The first
two are the keyed providers this deployment is most likely to buy; `searxng` needs
only a base URL; `duckduckgo` needs nothing and is the floor so the tool is never
dead. Provider identifiers, config keys and key names are picoclaw's.

**R4 — configuration**, under picoclaw's own path, read from the config file
introduced by `ganglion-model-registry` FR-1:

```jsonc
{ "tools": { "web": {
    "provider": "auto",              // or a provider name; "auto" walks R6's order
    "brave":      { "enabled": true, "max_results": 5, "api_keys": ["enc://…"] },
    "tavily":     { "enabled": true, "base_url": "", "max_results": 5 },
    "searxng":    { "enabled": true, "base_url": "https://searx.example/" },
    "duckduckgo": { "enabled": true, "max_results": 5 },
    "fetch_limit_bytes": 2000000,
    "proxy": "" } } }
```

**R4.1 — keys.** As with models: `GANGLION_WEB_KEY_<PROVIDER>` first, inline
`api_keys[0]` second, both `enc://`-capable. The environment path is what the
proxy uses, so a key never has to sit in a file the harness can be pointed at by
mistake.

**R5 — admin surface.** A **Search** section tab, admin-only, listing every known
provider with an enable switch, its provider-specific fields, and a write-only key
field. Stored per scope on the proxy beside the model registry, materialized into
picoclaw's `.security.yml`/`config.json` and into ganglion's config file from the
same record — the property that makes it "the same tools".

**R6 — selection.** Picoclaw's order, restricted to the v1 set:
explicit `tools.web.provider` if ready → `brave` → `tavily` → `searxng` →
`duckduckgo`. "Ready" means enabled **and** carrying whatever credential it needs.

**R6.1 — one deliberate divergence, recorded.** picoclaw picks a provider per
query and **does not** retry against the next when the call fails
(`resolveProviderName`; only intra-provider key-pool failover exists). Ganglion
**does** fall through to the next ready provider on a transport or 5xx failure.
This is a behavioural difference on purpose, and it is exactly the class of
difference the `ganglion-model-registry` compatibility note exists to license.

## Where the tool runs, and why it is not the shell

The obvious cheap implementation — let the agent `curl` a search API from the
shell tool — is refused. The shell tool's environment is scrubbed to
`PATH HOME TERM LANG TZ` and an agreement test
(`TestNoConfiguredVariableIsPassedToCommands`) fails the build if any `GANGLION_*`
variable is added to that allowlist. Handing the shell a search API key would mean
widening the allowlist, which would mean the key is readable by any command the
model is talked into running.

So `web_search` is a Go tool making its own HTTP call from the harness process,
where the key never enters a child environment. Landlock does not restrain it and
does not need to: Landlock governs the filesystem, and this tool touches none.

## Acceptance criteria

- **AC-1** With no provider configured, `web_search` returns a `Result` saying so.
  It never fails the turn (DEC-2: a tool-level problem is the agent's to react to).
- **AC-2** A Brave key set through the admin UI reaches a ganglion agent and a
  picoclaw agent from the same record.
- **AC-3** The result text for a given query is byte-identical in shape to
  picoclaw's, verified against the format quoted in R1.
- **AC-4** A command run through the shell tool cannot read any search key —
  the same assertion class as `ganglion-model-registry` AC-4.
- **AC-5** With `brave` enabled but its key revoked, the turn still gets results
  from the next ready provider, and a `Progress` frame names the hop (R6.1).

## Out of scope

Kagi, Perplexity, GLM, Baidu, Gemini grounding, Sogou. Each is an adapter with its
own wire format and its own free-tier; adding one after this feature is a file and
a registration line, which is the point of building the registry rather than four
hard-coded calls.

`prefer_native` (letting the provider's own built-in search run instead of the
tool). It presumes a provider capability probe ganglion does not have.

---

## Implementation status (2026-09-10)

| Requirement | State |
|---|---|
| R1, R2 | **done** — `internal/adapter/tool/websearch`, schema and result text pinned to picoclaw's by literal test |
| R3 | **done** — brave, tavily, searxng, duckduckgo |
| R4, R4.1 | **done** — read from the shared config file; `GANGLION_WEB_KEY_<PROVIDER>` first |
| R6, R6.1 | **done** — priority order, cross-provider fallback, a pinned provider used alone |
| R5 | **PARTLY.** A key stored in the existing `web.<provider>` native secret slot now reaches a ganglion agent as well as a picoclaw one, which is the "same tools" property. What does NOT exist is the **Search section tab**: enabling a provider without keying it, `searxng`'s base URL, and `duckduckgo` (which needs no key, so nothing can infer intent from a stored secret) are unreachable from the admin UI |
| AC-1, AC-3, AC-4, AC-5 | **asserted by test** |
| AC-2 | **not exercised against a live deployment** — no Brave key is configured in this stack |

**A bug the tests caught rather than review, worth keeping:** `tools.web` mixes
scalars (`provider`, `proxy`, `fetch_limit_bytes`) with one object per provider
in the same JSON object. Decoding it in a single pass into a map of provider
structs fails on the scalars and silently yields **no providers** — the whole
block reads as "search is off" while looking perfectly correct in the file.

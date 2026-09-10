# ganglion-reasoning-depth — Specification

**Status:** Draft
**Size:** Medium (one harness, one proxy field, one webapp input)
**Repos touched:** `crab-ganglion-harness`, `crab-shell-proxy`, `crab-exoskeleton-webapp`

---

## Problem

A ganglion turn always thinks the same amount. Whatever the question — "what time
is it" or "reconcile these two schemas and tell me which migration is safe" — the
same request goes on the wire with no depth parameter, and the model spends the
same effort on both.

The harness is closer to solving this than it looks, which is why the requirement
below is narrow rather than broad. Two of the three pieces already exist:

- **Reasoning already comes back.** `openai.go:240` decodes
  `delta.reasoning_content` into `domain.Delta.Reasoning`, the loop coalesces it
  at 1s and emits it as `ProgressThought` (`loop.go:513`), and
  `domain.Message.Reasoning` persists it into the transcript.
- **A depth field can already go out — statically.** `Client.ExtraBody` is merged
  into the request body by `encode()` and only `model`, `stream`, `messages`,
  `tools` and `stream_options` are reserved, so
  `"extra_body": {"reasoning_effort": "high"}` on a `model_list` entry reaches the
  wire today.

What is missing is that the depth is **fixed at configuration time and identical
for every turn**. An operator who wants a model to think hard on hard questions
must make it think hard on every question, and pay for it.

## Grounding (verified in source — do not re-derive)

picoclaw v0.3.1 has exactly one knob: **`model_list[].thinking_level`**, a string
of `off | low | medium | high | xhigh | adaptive` (`pkg/config/config.go:780`).

- It is **per-model-entry only**. It does not exist in `agents.defaults`, does not
  exist in `agents.list[]`, and there is no global.
- Providers read it from an opaque options map (`pkg/agent/thinking.go:95`).
  Anthropic maps it to `thinking:{type:"enabled",budget_tokens:N}` with budgets
  4096/16384/32000/64000 and force-clears `temperature`. openai_compat emits
  `reasoning_effort` **only for DeepSeek** (`SupportsThinking()` is literally
  `providerName == "deepseek" || isDeepSeekHost(apiBase)`); for every other
  OpenAI-compatible provider only the *disable* path exists. Gemini emits
  `generationConfig.thinkingConfig`.
- `extra_body` is merged **last** and overrides all of it
  (`openai_compat/provider.go:217`).
- **Nothing selects depth at runtime.** `grep -rniE
  "deep_research|deepsearch|ultrathink|think harder"` over the whole tree returns
  **zero hits**. There is no `/think` command. The `spawn`/`delegate`/`subagent`
  schemas expose `task`, `label` and `agent_id` — no model, no effort. Depth is
  reachable only as a side effect of routing to a different agent.
- The web UI already renders the field (`edit-model-sheet.tsx:98,385`) and its
  hint reads "Leave blank to omit `thinking_level` and use the provider default",
  so **omitted ≠ off** at picoclaw's agent layer.

**Consequence for compatibility:** the key and its six values are the contract.
A seventh value would break picoclaw's own editor, so this feature adds none.

---

## Decisions

**D-1 — `thinking_level` is adopted verbatim, with picoclaw's exact six values.**
It is the static floor: what a model does when nothing else says otherwise. The
harness reads it from `model_list[]`, the proxy projects it from the inventory,
and the admin UI edits it. No new key, no new vocabulary.

**D-2 — Declaring `thinking_level` on a model IS the capability declaration.**
There is no built-in provider capability table in the harness, and this is
deliberate. picoclaw needs one because it speaks four provider dialects; ganglion
speaks exactly one wire (`internal/adapter/provider/openai` is the only provider
adapter, `router` selects among instances of it), so the only question is whether
*this endpoint* accepts a depth field — which the operator knows and the harness
cannot discover. A model with no `thinking_level` is never sent a depth field, at
any depth, by any path.

The cost of this decision is stated rather than hidden: an operator who forgets
the key gets a harness that silently never thinks deeply. AC-7 is the test that
makes the omission visible in the boot log rather than only in the bill.

**D-3 — Per-turn depth is chosen by the agent, through a tool, and is sticky for
the remainder of the turn.**

A model can only act through a tool call, so agent-selected depth costs one of the
12 `MaxIterations`. Sticky rather than per-completion is what makes that one call
worth paying for: the model raises the level once, and every subsequent completion
of that turn — including the ones after tool results come back, which is where the
hard reasoning usually happens — runs at the new level.

Rejected alternatives, and why:
- *Automatic classification by the harness* — the harness would have to judge
  difficulty from the user's text with no model in the loop, which is the problem
  the model is better at. It also makes the behaviour unexplainable.
- *A user-visible prefix (`/think`)* — the request is explicitly that the **agent**
  select according to the complexity of the problem.
- *Per-completion* — a level that resets between iterations is a level the model
  cannot use for the part of the turn that needs it.

**D-4 — A depth field that the endpoint rejects degrades; it does not end the
turn.** On a failed completion whose request carried a depth field, the harness
retries **once on the same model with the field removed** before falling through
to the next model in the chain. This is the same shape as the existing attachment
degradation in `completeWithFallback`, and it exists for the same reason: the
`vision-unsupported-glm` production failure, where an unsupported request field
ended every turn on a model that would have answered fine without it.

**D-5 — The level travels on `domain.Completion`, not in `extra_body`.**
`extra_body` stays exactly what it is: an operator-owned escape hatch merged last
and overriding everything, including this feature. An operator who pins
`extra_body.reasoning_effort` has said "always this", and this feature must not
quietly win that argument.

---

## Requirements

### Harness: reading the level

**FR-1** — `config.ModelSpec` gains `ThinkingLevel string`, read from
`model_list[].thinking_level`. Values are parsed case-insensitively with
surrounding whitespace trimmed, matching `pkg/agent/thinking.go:16-54`. An
unrecognised value is treated as **absent** and logged once naming the model and
the value — not as `off`, because `off` is a level a model can be sent and
"unparseable" is an operator mistake that should be visible.

**FR-2** — An absent or empty `thinking_level` means **the model is never sent a
depth field**, by any path, at any level. This is D-2 as a testable rule.

### Harness: the levels

**FR-3** — The level vocabulary is exactly picoclaw's:
`off`, `low`, `medium`, `high`, `xhigh`, `adaptive`. The harness defines no
seventh value and rejects none of the six.

**FR-4** — The default wire mapping, applied when the model declared a level and
carries no override:

| Level | Emitted on the request |
|---|---|
| `off` | `"reasoning_effort": "none"` |
| `low` | `"reasoning_effort": "low"` |
| `medium` | `"reasoning_effort": "medium"` |
| `high` | `"reasoning_effort": "high"` |
| `xhigh` | `"reasoning_effort": "high"` |
| `adaptive` | nothing — the field is omitted and the provider decides |

`xhigh` collapsing onto `high` is deliberate: `reasoning_effort` has no fourth
step in the OpenAI-compatible vocabulary, and inventing one would send a value no
endpoint recognises. An operator who has a provider with a higher step reaches it
through FR-5, and the collapse is logged once per model at boot so it is a known
ceiling rather than a silent one.

**FR-5** — `model_list[].thinking_body` overrides the table per level:

```json
{ "model_name": "deepseek-reasoner", "thinking_level": "high",
  "thinking_body": {
    "xhigh": { "reasoning_effort": "max" },
    "off":   { "thinking": { "type": "disabled" } } } }
```

The mapped object is merged into the request body at the top level under the same
`reserved` rule `ExtraBody` already obeys — `model`, `stream`, `messages`,
`tools` and `stream_options` cannot be overwritten. A level present in
`thinking_body` fully replaces FR-4's row for that level, including replacing it
with `{}` to emit nothing.

This is the one mechanism by which a new provider dialect is taught to the
harness without a code change, and it is why FR-4's table can stay this small.

**FR-6** — `extra_body` is merged **after** the depth field, so an operator's
pinned value wins (D-5). Ordering is asserted, not assumed.

### Harness: per-turn selection

**FR-7** — A tool named **`set_reasoning_depth`** is registered **only when at
least one model in the resolved text chain declared a `thinking_level`**. With no
such model the tool is absent from the schema list entirely.

This follows `imagegen`'s precedent (`New` returns nil, and nil means absent from
the tool list): a model told it can choose a depth, which then changes nothing, has
spent a turn learning what boot already knew.

Schema:

```json
{ "type": "object",
  "properties": {
    "level":  { "type": "string", "enum": ["off","low","medium","high","xhigh","adaptive"],
                "description": "How much to think for the rest of this turn" },
    "reason": { "type": "string", "description": "One line on why this problem needs that depth" } },
  "required": ["level"] }
```

**FR-8** — The tool sets the level for the **remainder of the current turn** and
returns immediately. It never calls a provider, so it costs one iteration and no
tokens.

**FR-9** — The level is **per turn**, not per conversation. A new turn starts at
the model's configured `thinking_level`. A depth raised for one question does not
silently bill every later one.

**FR-10** — `reason` is not used for control flow. It is emitted as a
`ProgressThought` so the member sees *why* the agent went deep, and it is recorded
on the turn's `domain.TurnRecord` so `evolution` can observe whether depth
correlates with success. A model that omits it is not refused.

**FR-11** — The chosen level applies to **every subsequent completion of the
turn**, including completions on fallback models — subject to FR-2, so a fallback
model that declared no level is still sent nothing.

### Harness: plumbing

**FR-12** — `domain.Completion` gains `ThinkingLevel string`. It is the only new
field on the domain type and it carries a level name, not a wire shape: the
mapping from name to JSON is the provider adapter's business (AR-2).

**FR-13** — `wireRequest` gains no typed field. The depth object is merged into
the encoded body by `encode()`, the same two-pass merge `ExtraBody` already uses,
because FR-5 means the shape is not fixed at compile time.

**FR-14** — On a completion error where the request carried a depth field, the
harness retries **once, on the same model, with the depth field removed**, before
moving to the next model in the chain (D-4). The retry is logged. If the retry
also fails, the chain proceeds normally.

**FR-15** — A model that has degraded under FR-14 is remembered **for the rest of
the turn only**: the same model is not re-sent a depth field on a later iteration
of the same turn. It is not remembered across turns, because the failure may have
been the endpoint's and not the model's.

### Proxy

**FR-16** — `registry.Model` gains `ThinkingLevel string`
(`json:"thinking_level,omitempty"`), validated against the six values on write and
rejected with 400 otherwise.

**FR-17** — `ganglionConfigDoc` projects `thinking_level` onto each `model_list`
entry when the record carries one, and omits the key otherwise. Omitted rather
than written empty, matching the file's existing rule for `model_fallbacks`.

**FR-18** — `materializeModels` projects the same field into a **picoclaw**
workspace's `model_list`, because the key is picoclaw's own and a value set in the
inventory should reach whichever harness the agent runs. This is the compatibility
requirement in the original ask, made concrete.

### Webapp

**FR-19** — The model editor gains a `thinking_level` select with the six values
plus an explicit empty option, whose helper text says what omitted means: the
provider's own default, and no depth field on the wire.

**FR-20** — The field is offered for **every inventory-governed harness**
(`INVENTORY_GOVERNED`), not gated to picoclaw. It is a property of the model
record, not of the harness that reads it.

---

## Non-functional

**NFR-1** — A deployment that sets no `thinking_level` anywhere behaves exactly as
today, byte-identically on the wire. This is the regression bar for the whole
feature.

**NFR-2** — The feature adds no dependency. `go.mod` stays at zero requires.

**NFR-3** — `set_reasoning_depth` must not be able to make a turn fail. Like every
other tool in this harness, its `Invoke` returns a `domain.Result` and never an
error, including for an unknown level (which is refused in the result text and
leaves the current level untouched).

---

## Acceptance criteria

**AC-1** — A model with `thinking_level: "high"` sends `reasoning_effort: "high"`
on every completion of a turn; the same model with the key removed sends a request
body byte-identical to today's.

**AC-2** — A model with no `thinking_level` is sent no depth field even after the
agent calls `set_reasoning_depth` with `xhigh` (FR-2 beats FR-11).

**AC-3** — `set_reasoning_depth{level:"xhigh"}` called at iteration 2 changes the
body of iterations 3..n of the same turn, and iteration 1 of the *next* turn is
back at the configured level (FR-8, FR-9).

**AC-4** — `thinking_body:{"xhigh":{"reasoning_effort":"max"}}` sends `"max"`;
`thinking_body:{"high":{}}` sends nothing for `high` while `low` still sends
`"low"` (FR-5).

**AC-5** — `extra_body:{"reasoning_effort":"low"}` with `thinking_level:"high"`
sends `"low"` — the operator's pin wins (FR-6, D-5).

**AC-6** — A server that 400s on `reasoning_effort` gets a second request from the
same model without the field, and the turn **answers**. A mutation that removes the
retry makes this test fail with the turn ending in an error.

**AC-7** — With no model declaring a level, `set_reasoning_depth` is absent from
the tool schemas, and boot logs one line saying depth selection is unavailable and
naming the key that would enable it.

**AC-8** — A `thinking_level` set through the admin UI reaches a **picoclaw**
workspace's `config.json` and a **ganglion** workspace's `config.json` from the
same inventory record (FR-17, FR-18).

**AC-9** — An unparseable `thinking_level` (`"HIGH!"`) is treated as absent and
logged; it is **not** silently read as `off`. This discriminates the failure mode
that would otherwise look like a working configuration that never thinks.

---

## Out of scope

- **Deep research and deepsearch.** They were part of the same request and they
  are not this mechanism: a depth field is one wire parameter, and research is a
  multi-step procedure (decompose → search → read → synthesize). Specified in
  `ganglion-subagents`, built on the fan-out that feature introduces. Putting a
  research loop behind `reasoning_effort` would be the wrong shape.
- Anthropic's native `thinking:{budget_tokens}` and Gemini's `thinkingConfig` as
  built-in mappings. Ganglion has one wire; FR-5 is how those are reached, and a
  second provider adapter is the moment to revisit it.
- A token budget for a turn. The harness has no token accounting today, and
  `xhigh` on a 12-iteration turn can be expensive. Named in
  `ganglion-subagents` NFR, where the same gap has teeth.
- Re-sending reasoning blocks on the next turn (`reasoning_content` replay,
  Anthropic signatures, Gemini `thoughtSignature`). Ganglion persists reasoning
  but never replays it, and this feature does not change that.

---

## Open questions

**OQ-1 — Should `set_reasoning_depth` be able to *lower* the level below the
model's configured floor?** The schema allows `off`, so an agent can decide a
question is trivial and save the operator money. It can also decide wrongly and
answer a hard question shallowly, and the operator who paid for `high` has no way
to see it happened. Recommendation: allow it, because FR-10 makes the choice and
its reason visible in the progress stream and the turn record — the operator can
see it. Revisit if the record shows the agent lowering more than it raises.

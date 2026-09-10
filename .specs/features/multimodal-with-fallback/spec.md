# multimodal-with-fallback — Specification (authoritative)

**Status:** Implemented in the harness. See "Implementation status" below.
**Date:** 2026-09-10.
**Spans:** `crab-ganglion-harness`, `crab-shell-proxy`, `crab-exoskeleton-webapp`.
**Depends on:** `ganglion-model-registry` (the config file, the candidate chain,
the fallback mechanics this feature reuses in both directions).

## Correcting the premise, because the correction makes the feature better

The request was: *"O picoclaw existe a chave `agents.defaults.image_model` que
permite registrar modelo para image-to-text. Entretanto essa config não permite
fallback. Implemente as duas opções ainda com fallback."*

Read against picoclaw v0.3.1, one third of that is wrong and it matters:

| Claim | Reality |
|---|---|
| `agents.defaults.image_model` exists for image-to-text | **True** — `pkg/config/config.go:430` |
| it permits no fallback | **False** — `image_model_fallbacks` is the very next line (`:431`), and `Fallback.ExecuteImage` walks it (`pipeline_llm.go:211-224`) |
| picoclaw has text-to-image | **False, and stronger than "no fallback"** — there is no image generation anywhere in the tree |

So the gap is not the one named. The three real ones are:

1. **Text-to-image does not exist at all.** Net-new, in both harnesses' worlds.
2. **The image model is `defaults`-only.** `ImageModel` lives on `AgentDefaults`
   and never on `AgentConfig` — every agent in a picoclaw instance shares one
   vision model, with no per-agent override.
3. **The chain has no terminal behaviour.** When the image candidates are
   exhausted, `pipeline_llm.go:282-287` returns `ControlBreak` with a user-facing
   error. No text-only degradation, no retry with the image stripped. And because
   the media reference stays in the session history, **every later turn in that
   conversation fails identically** — this stack has already been bitten by
   exactly that, which is why `deploy/picoclaw-glob/vision-unsupported-glm.patch`
   exists.

This feature builds against the real gaps.

## The cost that is not obvious

Ganglion has **no concept of an image**. `domain.Message.Content` is a `string`;
the OpenAI adapter's `wireMessage.Content` is a `string`, not the multi-part
`content: [{type,text|image_url}]` array; the SSE ingress carries no media field.
Before one image moves, this feature touches the domain, the provider wire format,
the HTTP ingress, the proxy's turn forwarding and the webapp's composer. That is
the bulk of the work; the model selection on top of it is small.

## What is being built

### Image-to-text (vision)

**R1 — an attachment in the domain.** `domain.Message` gains
`Attachments []Attachment`, where `Attachment{Kind, MIME, Ref, Bytes}`. `Kind` is
`image` in v1. The domain stays stdlib-only, as `arch_test.go` enforces.

**R2 — multi-part on the wire.** When a completion carries attachments, the
OpenAI adapter emits the array form with `image_url` parts (`data:` URLs), and the
plain string form otherwise — so a text-only turn's bytes do not change.

**R3 — a vision chain, per agent.** `agents.defaults.image_model` and
`agents.defaults.image_model_fallbacks` are read from the config file, picoclaw's
keys unchanged. **Unlike picoclaw, `agents.list[].model.image_*` overrides them
per agent** (gap 2). Entries name `model_list` members, exactly as the text chain
does.

**R4 — routing.** A turn whose messages carry an image runs on the vision chain
when one is configured. When none is, it runs on the ordinary chain — and if that
model refuses the image, R5 applies.

**R5 — a terminal behaviour, which is the actual feature.** When the vision chain
is exhausted, or no vision model is configured and the text model refuses images,
the turn **does not die**. It retries once with the attachments stripped and a
system note stating that an image was present and could not be read. The answer
is degraded and says so. This is the direct fix for gap 3 and for the failure
`vision-unsupported-glm.patch` documents: the conversation stays usable instead of
becoming permanently broken by one image in its history.

**R5.1** — "the model cannot see images" is detected by the same error-text
patterns picoclaw uses (`isVisionUnsupportedError`), **including this stack's own
GLM case**, which upstream still lacks and which this repository carries as a
patch. Porting it here means the ganglion path is born with the fix picoclaw
needed a patch for.

### Text-to-image (generation)

**R6 — a `generate_image` tool.** Arguments `{prompt, size?, n?}`. It calls an
OpenAI-compatible images endpoint (`POST {api_base}/images/generations`), writes
each result into the workspace under `media/` and returns the paths in its
`Result`, so the agent can then deliver them with the ordinary file path it
already understands.

**R7 — a generation chain.** `agents.defaults.image_gen_model` and
`image_gen_model_fallbacks`, same shape and same per-agent override as R3. These
keys are **new** — picoclaw has no equivalent to be compatible with — and are
named to sit beside its existing ones so a future picoclaw that grows the feature
has an obvious place to land.

**R8 — the tool is absent when no generation model is configured.** Not present
and answering "unavailable": absent from `Tools.Available`, so the model is never
told about a capability it does not have.

## Acceptance criteria

- **AC-1** A turn carrying an image is answered by the configured vision model.
- **AC-2** With the vision chain exhausted, the member gets a degraded answer that
  states the image could not be read — and **the next turn in that conversation
  works** (the regression `vision-unsupported-glm.patch` was written for).
- **AC-3** A text-only turn's request bytes are unchanged by this feature.
  Asserted directly against the serialized request, not inferred.
- **AC-4** `generate_image` writes inside the workspace and nowhere else — it
  runs in the harness process, but the path it writes is still checked, because a
  prompt-chosen filename is member-influenced input.
- **AC-5** With no generation model configured, `generate_image` is not in the
  tool list at all.

## Out of scope

Audio and video. `Attachment.Kind` is an enum so they are additive, but nothing
routes them in v1.

Image editing / variations endpoints.

A media store with reference-counting and cleanup policies, as picoclaw's
`pkg/media` has. v1 writes files into the workspace, which is already the durable,
per-user, size-bounded place the agent's own outputs live.

---

## Implementation status (2026-09-10)

| Requirement | State |
|---|---|
| R1, R2 | **done** — `domain.Attachment`, `wireMessage.Content` as `any`, the string form kept for text-only turns |
| R3 | **done** — picoclaw's `image_model` / `image_model_fallbacks`. The per-AGENT override of R3 is **not** built: this harness runs one agent per container, so `agents.list[].model.image_*` has nothing to address here. picoclaw's defaults-only limitation is real and is not a limitation of this design |
| R4 | **done** — routed on the WINDOW carrying an image, not on the last message |
| R5, R5.1 | **done**, and it is the feature. Mutation-checked twice: removing the degradation, and forgetting to strip |
| R6 | **done** — `internal/adapter/tool/imagegen` |
| R7 | **done** — `image_gen_model` / `image_gen_model_fallbacks`, new keys with no picoclaw equivalent |
| R8 | **done** — absent from the tool list when unconfigured |
| AC-1, AC-2, AC-3, AC-4, AC-5 | **asserted by test** |

**The inbound path, and why it is not the one the spec assumed.** A member's
image reaches this stack by being uploaded into their workspace; the proxy's turn
request carries a plain string and no media. Rather than change the turn format
picoclaw shares, the image is read from where it already is: `load_image` takes a
workspace path, and the loop turns the result into a synthetic user message the
vision chain can see. The harness ingress accepts inline attachments too, so a
caller that does carry bytes is served — neither path is the other's fallback.

**Not verified against a real provider.** No image has been sent to a real vision
model from this harness. R5's degradation is exercised against a scripted
provider returning picoclaw's own refusal strings, which is the right test for
the routing and is not evidence about a live endpoint.

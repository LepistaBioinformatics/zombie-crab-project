# picoclaw + local patches.
#
# Four independent patches, each upstreamable on its own. They are applied in the
# order below and that order is now load-bearing: context-routed-agent and
# handled-tool-summary both touch pkg/agent/pipeline_execute.go (different hunks,
# a dozen lines apart), so handled-tool-summary is generated against a tree with
# the other three already applied.
#
# WHY dispatch-selector-glob.patch EXISTS
#
# picoclaw matches agents.dispatch selectors by exact string equality
# (pkg/routing/route.go, ruleMatchesView). On the pico channel the only selector
# that varies is `chat`, and the session key derives from that same value — so
# "which agent answers" and "which conversation this is" are one knob. Routing a
# whole project's conversations to one agent therefore needs one dispatch rule
# per conversation, written into config.json and reloaded each time.
#
# dispatch-selector-glob.patch adds `*` support to the six string selectors, so a
# single static rule covers a family of chats. See
# crab/crab-shell-proxy/.specs/features/agent-projects/ for the full reasoning.
#
# WHY vision-unsupported-glm.patch EXISTS
#
# picoclaw already knows how to turn "this model cannot see images" into an
# actionable error naming agents.defaults.image_model — isVisionUnsupportedError
# in pkg/agent/llm_media.go. Its patterns miss ZhipuAI/GLM, which rejects the
# multipart payload by enumerating the content types it accepts and never
# mentions images:
#
#   {"error":{"code":"1210",
#     "message":"messages.content.type is invalid, allowed values: ['text']"}}
#
# Unrecognised, the call falls through to the generic retry path and the turn ends
# with no answer. That alone would be a bad afternoon; what makes it permanent is
# that the media reference stays in the session history, so every later turn in
# that conversation fails identically. Observed in production 2026-08-10 — see
# crab/crab-shell-proxy/.specs/features/agent-projects-scope-fixes/b4-observation.md
# for the full trace.
#
# It makes the failure LEGIBLE, not survivable: the main turn path
# (pkg/agent/pipeline_llm.go:282) returns the actionable error rather than
# retrying without the image, so a conversation that already carries an image
# reference stays broken. Only askSideQuestion strips media and retries.
#
# WHY context-routed-agent.patch EXISTS
#
# picoclaw's default context manager reads a conversation's history from the
# DEFAULT agent's session store instead of the one the turn was routed to
# (pkg/agent/context_legacy.go, GetDefaultAgent()). Every AgentInstance owns a
# session store rooted at its own workspace, so agents with different workspaces
# have disjoint stores — and a named agent gets its own workspace, which is
# picoclaw's own default.
#
# The result in this stack: every conversation inside a PROJECT (agent-projects
# gives each project its own agent) is answered with NO history, on every turn
# after the first. The write goes to workspace-<project>/sessions/; the read
# looks the same key up in workspace/sessions/, where it never existed.
# SessionStore reports a missing key as an empty history rather than an error, so
# the turn runs on nothing and no log line records a fault. Members meet it as an
# agent that greets them mid-conversation and says "esta é a primeira mensagem
# que recebo nesta sessão", while the webapp still renders the full transcript
# from the proxy's durable file.
#
# The patch threads the routed agent's id through the ContextManager interface —
# AssembleRequest, CompactRequest and (since the follow-up) ClearRequest — and
# resolves it in both managers, falling back to the default agent when unset, so a
# single-agent deployment is bit-identical to before. See
# .specs/features/project-chat-context-loss/investigation.md for the full trace.
#
# Clear was excluded from the first cut and is now in. It is the DESTRUCTIVE one:
# /clear on a non-default agent emptied a session under that key in the DEFAULT
# agent's store — destroying an unrelated conversation if one shared the key, doing
# nothing if none did — and reported success either way, so the member was told
# their history was gone while it sat untouched. Fixing it meant breaking the
# interface method's signature, which is why it waited for a change of its own.
#
# One coupling to know about on a tag bump: the test this patch adds
# (pkg/agent/context_routed_agent_test.go) uses `simpleMockProvider`, a helper
# defined in UPSTREAM's own pkg/agent/agent_test.go. If upstream renames it, this
# patch still applies cleanly and then fails to COMPILE — the error will name the
# helper, not the patch.
#
# WHY handled-tool-summary.patch EXISTS
#
# A turn whose output was delivered BY A TOOL — `send_file`, or anything else that
# sets ResponseHandled — ends without an LLM follow-up. picoclaw writes
# "Requested output delivered via tool attachment." into the session and calls
# setFinalContent("") (pkg/agent/pipeline_execute.go, the allResponsesHandled
# branch), so **nothing at all reaches the channel**: the sentence is in the
# transcript and the member never sees it.
#
# For a human on Telegram that is a missing footnote. For this stack it is a hang.
# The Pico Protocol has no "turn over" frame — crab-shell-proxy infers completion
# from "plain assistant content arrived AND typing stopped" — so a turn that never
# publishes plain content never finalizes. Ask the agent for a file and the chat
# spins for the full turnIdleTimeout (600s here) and then reports a FAILURE for a
# turn that worked. Traced in
# crab/crab-shell-proxy/.specs/features/delivery-turn-never-finalizes/investigation.md.
#
# The patch publishes that same sentence on the same path Finalize already uses
# when the final answer must reach the channel outside SendResponse
# (`!SendResponse && AllowInterimPicoPublish`), so nothing changes for the channels
# whose caller publishes finalContent, and the transcript and the conversation stop
# disagreeing.
#
# The proxy ALSO defends itself — a delivery with no plain message finalizes after
# a short settle window rather than the idle budget — and that stays: the proxy
# must not hang for ten minutes because a harness ended a turn quietly, whatever
# the harness does next. This patch is what makes the common case instant instead
# of merely bounded.
#
# HOW TO GET RID OF THIS
#
# Both patches are written to be upstreamable as-is (tests + docs, no zombie-crab
# content). Once they are merged and released by sipeed, delete this whole
# directory and point `picoclawImage` back at the stock tag. Nothing else in the
# stack knows the difference.
#
# WHY A PINNED TAG AND NOT A BRANCH
#
# The patch is a diff against known bytes. Pinning means `git apply` fails loudly
# on an upgrade, which is exactly what should happen: the ~15 changed lines need
# to be re-checked against the new upstream, not silently skipped or
# fuzzy-applied. Bump PICOCLAW_TAG deliberately, and re-run the routing tests.
#
# WHERE THE PUBLISHED IMAGE COMES FROM
#
# This image no longer has to be built by hand:
# .github/workflows/release-picoclaw-glob.yml publishes it to
# ghcr.io/lepistabioinformatics/picoclaw as `<version>-glob` (plus `latest`), so a
# deploy that pulls every other image can pull this one too. The workflow always
# passes PICOCLAW_TAG explicitly -- resolving "latest" to a concrete release tag
# first, never handing a moving ref to the clone below.
#
# The ARG default therefore governs only a local `docker build` and a rebuild
# triggered by editing the patches. That case wants the pin, not the newest
# release: a patch edit must be validated against the bytes the patch was written
# for. Keep it a concrete tag.

ARG PICOCLAW_TAG=v0.3.1

# ============================================================
# Stage 1: apply the patch and build
# Mirrors upstream docker/Dockerfile; only the clone + apply is ours.
# ============================================================
FROM golang:1.25-alpine AS builder

ARG PICOCLAW_TAG

RUN apk add --no-cache git make

WORKDIR /src

RUN git clone --depth 1 --branch ${PICOCLAW_TAG} \
      https://github.com/sipeed/picoclaw.git /src

COPY dispatch-selector-glob.patch /tmp/dispatch-selector-glob.patch
COPY vision-unsupported-glm.patch /tmp/vision-unsupported-glm.patch
COPY context-routed-agent.patch /tmp/context-routed-agent.patch
COPY handled-tool-summary.patch /tmp/handled-tool-summary.patch
# --verbose so a failed apply names the hunk; no fuzz, no 3-way. A patch that no
# longer applies cleanly is a signal, not an inconvenience.
RUN git apply --verbose /tmp/dispatch-selector-glob.patch
RUN git apply --verbose /tmp/vision-unsupported-glm.patch
RUN git apply --verbose /tmp/context-routed-agent.patch
# LAST, deliberately: its hunks in pipeline_execute.go were generated against the
# tree the three patches above produce.
RUN git apply --verbose /tmp/handled-tool-summary.patch

RUN go mod download

# These tests ARE the acceptance check for this image: a build cannot produce an
# image whose dispatch matching is broken, nor one that fails to recognise the
# vision refusal this deployment's model actually returns. Each patch ships the
# test that covers it.
RUN go test -tags goolm,stdjson ./pkg/routing/...
RUN go test -tags goolm,stdjson -run TestIsVisionUnsupportedError ./pkg/agent/...
# The `no tests to run` guard is not paranoia: `go test -run` exits 0 when its
# regex matches NOTHING ("ok ... [no tests to run]"), so a renamed test or a typo
# here turns the gate into decoration that passes forever. Fail loudly instead.
RUN set -e; \
    out="$(go test -tags goolm,stdjson \
      -run 'TestLegacyAssemble_ReadsRoutedAgentSessionStore|TestLegacyAssemble_EmptyAgentIDFallsBackToDefault|TestLegacyCompact_CompressesRoutedAgentSessionStore|TestLegacyClear_EmptiesRoutedAgentSessionStore|TestLegacyClear_EmptyAgentIDFallsBackToDefault|TestLegacyClear_NilRequestIsAnErrorNotAWipe' \
      ./pkg/agent/...)"; \
    printf '%s\n' "$out"; \
    ! printf '%s\n' "$out" | grep -q 'no tests to run'
RUN set -e; \
    out="$(go test -tags goolm,stdjson \
      -run 'TestHandledToolSummaryReachesTheChannel|TestProcessMessage_MediaToolHandledSkipsFollowUpLLMAndFinalText' \
      ./pkg/agent/...)"; \
    printf '%s\n' "$out"; \
    ! printf '%s\n' "$out" | grep -q 'no tests to run'

RUN make build

# ============================================================
# Stage 2: runtime — identical to upstream's
# ============================================================
FROM alpine:3.23

RUN apk add --no-cache ca-certificates tzdata curl

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:18790/health || exit 1

COPY --from=builder /src/build/picoclaw /usr/local/bin/picoclaw
COPY --from=builder /src/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

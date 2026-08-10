# picoclaw + local patches.
#
# Two independent patches, each upstreamable on its own. Neither touches a file
# the other does, so they apply in either order.
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
# --verbose so a failed apply names the hunk; no fuzz, no 3-way. A patch that no
# longer applies cleanly is a signal, not an inconvenience.
RUN git apply --verbose /tmp/dispatch-selector-glob.patch
RUN git apply --verbose /tmp/vision-unsupported-glm.patch

RUN go mod download

# These tests ARE the acceptance check for this image: a build cannot produce an
# image whose dispatch matching is broken, nor one that fails to recognise the
# vision refusal this deployment's model actually returns. Each patch ships the
# test that covers it.
RUN go test -tags goolm,stdjson ./pkg/routing/...
RUN go test -tags goolm,stdjson -run TestIsVisionUnsupportedError ./pkg/agent/...

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

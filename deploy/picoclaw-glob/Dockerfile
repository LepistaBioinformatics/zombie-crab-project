# picoclaw + dispatch-selector globs.
#
# WHY THIS EXISTS
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
# HOW TO GET RID OF THIS
#
# The patch is written to be upstreamable as-is (tests + docs, no zombie-crab
# content). Once it is merged and released by sipeed, delete this whole
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
# --verbose so a failed apply names the hunk; no fuzz, no 3-way. A patch that no
# longer applies cleanly is a signal, not an inconvenience.
RUN git apply --verbose /tmp/dispatch-selector-glob.patch

RUN go mod download

# The routing tests ARE the acceptance check for this image. Running them here
# means a build cannot produce an image whose dispatch matching is broken.
RUN go test -tags goolm,stdjson ./pkg/routing/...

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

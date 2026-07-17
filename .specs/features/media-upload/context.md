# media-upload — Discussion Context (gray-area decisions)

Let users upload media and send it to the agent. **Cross-repo** (crab-shell-proxy
+ chat-webapp).

## Grounded constraint

The Pico Protocol turn the proxy speaks to picoclaw is **text-only**: the send
frame is `{type:"message.send", session_id, payload:{content:<string>}}` with "no
extra payload fields" (`internal/pico/turn.go`), and `RunTurn(..., userContent
string, ...)` + `extractText` drop any non-text content part. So media cannot be
streamed inline through the protocol without changing picoclaw itself.

## CTX-MU-01: workspace-file approach (not protocol multimodal)

**Decision (discuss 2026-07-16):** the webapp uploads the file to a proxy
endpoint that **stores it in the user's workspace** (reusing the existing
per-user workspace mount, like agent-customization does for secrets). The chat
turn then **references the stored path** (text — protocol-compatible), and a
vision-capable model or a file-reading skill reads it from the workspace. This
needs **no picoclaw-core / Pico Protocol change** — it works in our stack
(webapp + proxy). Whether the agent *acts on* the media is the user's domain (a
vision model and/or a reader skill); this feature's job is to get the file into
the workspace and tell the agent where it is.

Rejected: extending the Pico Protocol payload with media (touches the
third-party picoclaw image + uncertain support).

## Open design decisions (resolve in design.md — sensible defaults proposed)
- Accepted media types (images + common docs?) and a size cap.
- The reference format injected into the message `content` (how the agent learns
  the path).
- Uploads location: under the current workspace (`workspace/uploads/`), and
  whether keyed per-conversation (`session_id`) or per-workspace.
- GC of old uploads (likely deferred).

## Out of scope
- Changing picoclaw or the Pico Protocol.
- Guaranteeing the agent "understands" the media (depends on the model/skill).
- Non-workspace media stores (S3 etc.).

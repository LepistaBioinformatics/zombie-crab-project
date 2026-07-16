# media-upload Specification

Builds on `context.md` (CTX-MU-01). **Scope: Complex, cross-repo** (crab-shell-proxy
+ chat-webapp). Let users attach media in a chat; the file is stored in their
agent workspace and the turn references its path so the agent/skill can read it.

## Problem Statement

Users can only send text to the agent. There is no way to hand the agent an
image or document. The Pico Protocol is text-only (context.md), so media reaches
the agent as a **file in the workspace** referenced by the (text) turn.

## Goals
- [ ] A proxy endpoint that stores an uploaded file in the caller's workspace
      (authorized like chat), returning a workspace-relative path.
- [ ] A webapp attach control in the composer: upload, show attached chips, and
      on send include the path reference in the message so the agent knows.
- [ ] The agent can read the file from its workspace (a vision model/skill — the
      user's domain; out of our control to guarantee comprehension).

## Out of Scope
| Item | Reason |
| --- | --- |
| Pico Protocol / picoclaw changes | Text-only; workspace-file approach (CTX-MU-01) |
| Guaranteeing the agent interprets the media | Depends on the model/skill |
| External object storage | Store in the per-user workspace |
| GC of old uploads | Deferred |

---

## User Stories

### P1: Upload a file to the workspace ⭐ MVP
**Story**: I attach a file in a chat; it is stored where my agent can read it.
**Acceptance Criteria**:
1. WHEN `POST /v1/media` is called with a valid profile, `tenant_id`+`subs_acc_id`,
   passing the chat write-access chain, and a file THEN the proxy SHALL store it
   under the caller's workspace uploads dir and respond `200` with a
   workspace-relative `path`; a failing chain ⇒ `403`; oversized/rejected type ⇒
   `400`/`413`; no profile ⇒ `401`.
2. WHEN stored THEN the filename SHALL be sanitized (no traversal) and made
   unique; the file SHALL land inside the current workspace (agent-readable), not
   escape it.
3. WHEN the file exceeds the configured size cap or is a disallowed type THEN it
   SHALL be rejected before storage.

### P1: Attach & send from the composer ⭐ MVP
**Story**: I pick a file, see it attached, and send it with my message.
**Acceptance Criteria**:
1. WHEN I attach a file THEN the composer SHALL upload it via the BFF and show an
   attached chip (name; remove control); a failed upload shows the real error.
2. WHEN I send THEN the message the agent receives SHALL include a reference to
   the stored path(s) (text — protocol-compatible) so a skill/model can locate
   the file; the visible chat shows the attachment too.
3. WHEN no file is attached THEN the composer behaves exactly as today.

### P2: Honest errors
1. A proxy `4xx` (403/400/413) surfaces its real reason, not "connectivity".

---

## Requirement Traceability
| ID | Requirement | Component | Status |
| --- | --- | --- | --- |
| MU-01 | `POST /v1/media` stores upload in the workspace uploads dir; returns path | `crab-shell-proxy/internal/httpapi` + `docker`/`config` | Pending |
| MU-02 | Sanitize filename (no traversal) + unique; keep inside the workspace | proxy | Pending |
| MU-03 | Size cap + allowed-type validation (reject before storage) | proxy | Pending |
| MU-04 | Chat-chain authz (tenant/subs/role/write) on `/v1/media` | proxy | Pending |
| MU-05 | mycelium route `/v1/media` (POST, write) | `mycelium/config.standalone.toml` (parent) | Pending |
| MU-06 | Composer attach control + upload via BFF + chips | webapp `app/chat/composer.tsx` | Pending |
| MU-07 | On send, include the stored path reference in the message | webapp composer/chat-view | Pending |
| MU-08 | BFF `POST /api/media` proxy + honest errors | webapp `app/api/media` | Pending |
| MU-09 | `className` via cva variants | webapp | Pending |

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

---

## Success Criteria
- [ ] A user attaches an image, sends it; the file is in the workspace uploads
      dir (verifiable in the container) and the turn references its path.
- [ ] Traversal/oversized/disallowed uploads are rejected; unauthorized ⇒ 403.
- [ ] Sending without an attachment is unchanged.
- [ ] `docker build` (proxy) + `next build` (webapp) green.

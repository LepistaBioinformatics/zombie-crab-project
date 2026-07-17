# media-upload Tasks

Cross-repo. Gates: proxy `docker build --network=host .` (vet + tests); webapp
`next build`. Runtime: upload via `:18080` with a hand-crafted profile, inspect
the workspace uploads dir in the container. `[P]` = parallelizable.

---

## Proxy (this project's Go/config domain)

### T01 — `POST /v1/media` store + validate + authz — MU-01..04
- **What:** handler with the chat write-chain authz + account-switching guard;
  multipart `file`; stream to `UserWorkspace/workspace/uploads/<uid>-<sanitized>`
  enforcing the size cap while copying; extension/type allowlist; sanitize name
  (no `..`, safe charset); MkdirAll + chown to picoclawUser; return `{path,name,size}`.
  Add `MediaMaxBytes`/`MediaAllowedExts` to `internal/config`.
- **Done when:** unit/httptest: 200 stores under uploads with a safe unique name;
  403 unlicensed; 400 bad type / traversal name; 413 oversized; file lands inside
  the workspace. `docker build` green.
- **Depends on:** — (reuses tenant-scoped-workspaces manager/config)

### T02 — mycelium `/v1/media` route — MU-05  (parent repo)
- **What:** `[[picoclaw-*.path]]` `/v1/media`, `POST`, protectedByRoles write,
  secretName per agent.
- **Done when:** TOML valid; `docker compose config -q` ok; gateway (rebuilt)
  routes it. **Depends on:** T01

---

## Webapp (front agent or this agent — coordinate)

### T03 — BFF `POST /api/media` — MU-08
- **What:** `app/api/media/route.ts`: getSession (401), isInstance(role) (400),
  forward multipart to `/picoclaw-<role>/v1/media` with the JWT; `upstreamError`.
- **Done when:** forwards; a proxy 4xx surfaces its real reason. **Depends on:** T01

### T04 — Composer attach + upload + chips — MU-06
- **What:** attach button (`accept` = allowlist) in `composer.tsx`; on select →
  `POST /api/media` (ids from fragment) → pending-attachments state + chip
  (name/remove); uploading + error states. **Depends on:** T03

### T05 — On-send path reference + visible attachment — MU-07
- **What:** on send, append `[anexo: <path>]` per attachment to the message text
  sent to `/api/chat/<role>`; render the attachment in the chat message; clear
  attachments after send; no-attachment send unchanged. **Depends on:** T04

### T06 [P] — cva convention — MU-09
- **What:** new components use class-variance-authority variants; no inline
  conditional/interpolated className. **Depends on:** within T04/T05

### T07 — Verify
- **What:** proxy build green; webapp `next build` green; runtime: attach an image
  → stored under `workspace/uploads/` (verify in container) + turn carries the
  path; traversal/oversized/type rejected; unauthorized 403; plain send unchanged.
- **Done when:** spec §Success Criteria observed. **Note:** live path needs the
  gateway rebuilt (routes `/v1/media`). **Depends on:** T01–T06

---

## Dependency graph
```
T01 ─┬─ T02
     └─ T03 ─ T04 ─ T05 ─┐
              T06 (within)├─ T07
                          ┘
```

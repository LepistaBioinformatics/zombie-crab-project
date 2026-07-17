# media-upload Design

Builds on `context.md` (CTX-MU-01) + `spec.md` (MU-01..09). Cross-repo.

## Proposed defaults for the open design decisions (context.md)
- **Types:** a config allowlist — images (`png,jpg,jpeg,webp,gif`) + common docs
  (`pdf,txt,md,csv`). Reject others (`400`).
- **Size cap:** config, default 10 MiB (reject `413`).
- **Reference in the message:** the webapp appends a line to the turn text, e.g.
  `\n\n[anexo: uploads/<file>]` (Portuguese, matches the UI) — a skill/model reads
  that path from the workspace. Protocol stays text-only.
- **Location:** `UserWorkspace(...)/workspace/uploads/<uid>-<sanitized-name>`
  (inside the current workspace, agent-readable). `uid` keeps names unique.
- **GC:** deferred (out of scope).

## 1. Proxy `POST /v1/media` (MU-01..04)
`internal/httpapi`: resolveAgent + `Resolver.Resolve` + account-switching guard +
the chat write chain (`WithWriteAccess().OnTenant().WithRoles([agent.Key]).OnAccount()`)
— identical gate to chat (`403` on fail). Accept `multipart/form-data` (a `file`
part) — stream to disk, enforcing the size cap while copying (reject `413` past
the cap without buffering the whole body). Validate the extension/content-type
against the allowlist (`400`). Sanitize the filename (reuse the secrets
safe-charset + no-`..` validation) and prefix a `uid` for uniqueness. Write under
`UserWorkspace(cfg.ContainerDataRoot, t, s, role, u)/workspace/uploads/`
(MkdirAll; chown to `picoclawUser` so the agent reads it). Respond
`{ path: "uploads/<uid>-<name>", name, size }` (path relative to the workspace
root the agent sees). `config`: `MediaMaxBytes`, `MediaAllowedExts`.

## 2. mycelium route (MU-05, parent)
`[[picoclaw-*.path]]` for `/v1/media`, `methods=["POST"]`,
`group = { protectedByRoles = [{ name = "<agent>", permission = "write" }] }`,
secretName per agent. Gateway rebuild to take effect.

## 3. BFF `POST /api/media` (MU-08)
`app/api/media/route.ts`: `getSession` (401), `isInstance(role)` (400), forward
the multipart body to `/picoclaw-<role>/v1/media` with `Authorization: Bearer
<token>` via `fetchMycelium`; `upstreamError` for real 4xx (413/400/403), never
the connectivity mask on a gateway answer. Returns the proxy's `{path,...}`.

## 4. Composer + send (MU-06, MU-07)
`app/chat/composer.tsx`: an attach button (file input, `accept` = the allowlist).
On select → `POST /api/media` (multipart) with `tenant_id/subs_acc_id/role` from
the fragment → on success push `{path,name}` into a pending-attachments state and
render a chip (name + remove). On failure show the real error. On **send**: the
message text sent to `/api/chat/<role>` is the user's text plus a reference line
per attachment (`[anexo: <path>]`), so the agent turn (text) carries the paths;
the visible chat message renders the attachment (image preview from the local
file/`path`). No attachment → unchanged send.

## 5. States + convention (MU-02, MU-03 surfacing, MU-09)
Uploading spinner on the chip; error text on reject (size/type/authz) with the
real message; `className` via class-variance-authority variants.

## 6. Component / file map
| Concern | Location |
| --- | --- |
| `POST /v1/media` handler (store + validate + authz) | `crab-shell-proxy/internal/httpapi/handlers.go` |
| Media config (`MediaMaxBytes`, `MediaAllowedExts`), uploads path | `crab-shell-proxy/internal/config` |
| uploads dir under the workspace (mkdir/chown) | `crab-shell-proxy/internal/docker` (provision/manager) |
| `/v1/media` gateway route | `mycelium/config.standalone.toml` (parent) |
| BFF `/api/media` | `webapp/app/api/media/route.ts` |
| Composer attach + chips + on-send reference | `webapp/app/chat/composer.tsx` (+ chat-view) |

## 7. Risks
- **R1 — path traversal / escape:** sanitize the filename (no `..`, safe charset)
  and always join under the workspace uploads dir; never trust the client name.
- **R2 — size/DoS:** enforce the cap **while streaming** (don't buffer the whole
  upload); reject early. mycelium's `gatewayTimeout` still bounds the request.
- **R3 — agent comprehension is not guaranteed:** the feature delivers the file +
  the path; whether the agent *uses* it needs a vision model or a reader skill
  (user's domain) — state this, don't over-promise.
- **R4 — ownership split:** proxy tasks (MU-01..05) are this project's Go/config
  domain; webapp tasks (MU-06..09) may go to the front agent — coordinate.
- **R5 — GC deferred:** uploads accumulate in the workspace; note it.

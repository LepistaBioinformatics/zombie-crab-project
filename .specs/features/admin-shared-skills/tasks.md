# admin-shared-skills — Tasks

Depends on the implemented `admin-shared-content` plumbing. Two submodules
(`crab/crab-shell-proxy` Go, `crab/crab-exoskeleton-webapp` Next) + the gateway
config (`fungi/mycelium`). Each submodule gets its own feature branch
`feat/admin-shared-skills`.

Legend: `[P]` = parallelizable with siblings.

## Proxy — crab/crab-shell-proxy

### T1: Config builders + skill store
- **What:** Add `TenantSharedSkillsDir`/`SubscriptionSharedSkillsDir` to
  `internal/config/config.go`. New `internal/docker/skills.go` with `SkillMeta`,
  `sharedSkillsDir`, `ListSharedSkills`, `ReadSharedSkillDoc`,
  `WriteSharedSkillDoc`, `WriteSharedSkillZip`, `ArchiveSharedSkill`,
  `DeleteSharedSkill`, plus `sanitizeSkillName`, `parseSkillFrontmatter`, and
  the zip-hardening extractor. Reserve name `shared-content`.
- **Where:** `internal/config/config.go`, `internal/docker/skills.go`,
  `internal/docker/skills_test.go`.
- **Reuses:** `identity.SanitizeID`, `chownTree`, `Scope`, `config.*SharedFilesDir`
  layout, `MediaMaxBytes`.
- **Done when:** all store ops work on a temp dir; validation + zip hardening
  reject bad input writing nothing.
- **Tests:** `sanitizeSkillName` (valid/invalid/reserved/changed), frontmatter
  (missing file, missing name/description, quoted), doc round-trip, zip extract
  good + reject traversal/symlink/oversize/too-many-entries, archive readable,
  delete idempotent.
- **Gate:** `go test ./internal/... && go build ./...`.

### T2: Cascade mounts + precedence (depends T1)
- **What:** In `internal/docker/manager.go` `create`, compute the effective
  skill set for `(tenant, subscription)` — subscription overrides tenant by
  name, skip `shared-content` — and append one RO bind per skill
  `<hostSharedSkillsDir>/<name>:<mountDest>/workspace/skills/<name>:ro`
  (ensure/chown source dirs, mirror the shared-files loop). Extract
  `effectiveSkills(scope...)` as a testable pure-ish helper.
- **Where:** `internal/docker/manager.go`, `internal/docker/manager_test.go`.
- **Reuses:** managed-skill mount block, `RestartScope`.
- **Done when:** a created container's `Binds` include the merged skill set with
  correct precedence; no `shared-content` collision.
- **Tests:** `effectiveSkills` precedence (subscription over tenant, dedup,
  skip reserved).
- **Gate:** `go test ./internal/... && go build ./...`.

### T3: HTTP handlers + routes (depends T1, T2)
- **What:** In `internal/httpapi/admin.go` add `handleAdminSkillsList`,
  `handleAdminSkillsDoc`, `handleAdminSkillsArchive`, `handleAdminSkillsPost`
  (multipart: `scope`/`tenant_id`/`subs_acc_id`/`name` + `body` XOR `file`),
  `handleAdminSkillsDelete`; authorize via `authz.AuthorizeSharedScope` right
  after `s.adminScope`; call `RestartScope` after write/delete. Register the 5
  routes in `internal/httpapi/handlers.go` (mirror the shared block).
- **Where:** `internal/httpapi/admin.go`, `internal/httpapi/handlers.go`.
- **Reuses:** `handleAdminSharedPost`/`Content` shapes, `MaxBytesReader`.
- **Done when:** routes compile and enforce authz; happy-path unit/handler test
  for list+create(editor)+doc.
- **Gate:** `go test ./... && go build ./...`.

## Gateway — fungi/mycelium

### T4: Register skill routes [P after T3 contract known]
- **What:** Add `[[picoclaw-alpha.path]]` and mirrored `[[picoclaw-beta.path]]`
  blocks for `/v1/admin/skills` (GET,POST,DELETE), `/v1/admin/skills/doc` (GET),
  `/v1/admin/skills/archive` (GET) — `group="protected"`, matching `secretName`,
  `acceptInsecureRouting=true`.
- **Where:** `fungi/mycelium/config.standalone.toml` (and the prod/base config
  if it carries the same admin routes — check and mirror).
- **Done when:** TOML parses; routes present for both agents.
- **Gate:** config loads (proxy/gateway boot or a TOML lint).

## Webapp — crab/crab-exoskeleton-webapp

### T5: Client API [P]
- **What:** Add `SkillMeta` + `listSharedSkills`, `sharedSkillDoc`,
  `saveSharedSkillDoc`, `uploadSharedSkillZip`, `sharedSkillArchiveUrl`,
  `deleteSharedSkill` to `lib/admin.ts` (reuse `scopeParams`/FormData).
- **Where:** `lib/admin.ts`.
- **Done when:** `tsc --noEmit` clean; functions target `/api/admin/skills*`.
- **Gate:** `npx tsc --noEmit`.

### T6: BFF routes (depends T5 contract)
- **What:** `app/api/admin/skills/route.ts` (GET/POST/DELETE via `proxyAdminJson`,
  rebuilding FormData for POST), `app/api/admin/skills/doc/route.ts` (GET text),
  `app/api/admin/skills/archive/route.ts` (GET stream, mirror shared/content).
- **Where:** those three files.
- **Reuses:** `requireSession`, `proxyAdminJson`, `forwardAdmin`, the
  `shared/route.ts` + `shared/content/route.ts` shapes.
- **Done when:** `tsc --noEmit` clean.
- **Gate:** `npx tsc --noEmit`.

### T7: Skills panel + tab (depends T5, T6)
- **What:** `app/admin/shared-skills-panel.tsx` (clone shared-files-panel: list
  with description + files badge; New-skill inline `Textarea` editor writing
  SKILL.md; Upload .zip; Preview; Download; Delete via `ConfirmDialog`). Wire a
  `"skills"` tab into `app/admin/admin-screen.tsx` (`Tab` union + `TABS` entry +
  render branch).
- **Where:** `app/admin/shared-skills-panel.tsx`, `app/admin/admin-screen.tsx`.
- **Reuses:** `shared-files-panel.tsx`, `Button`/`IconButton`/`Alert`/`Spinner`/
  `Badge`/`Textarea`/`ConfirmDialog`.
- **Done when:** `tsc --noEmit` + `next build` pass; tab renders for managers.
- **Gate:** `npx tsc --noEmit`; production `next build` (use a temp `distDir` if
  a root-owned `.next` blocks it).

## Verification

### T8: Full gates
- Proxy: `go build ./... && go test ./...`.
- Webapp: `npx tsc --noEmit && yarn build`.
- Gateway: config parses.

## Traceability

| Task | Requirements |
| --- | --- |
| T1 | FR-2..FR-6, NFR-3/4/5 |
| T2 | FR-7..FR-10 |
| T3 | FR-1, FR-3..FR-6, NFR-1 |
| T4 | FR-1 (transport), NFR-1 |
| T5,T6 | FR-11, FR-12 (client/BFF) |
| T7 | FR-12 |
| T8 | all (gates) |

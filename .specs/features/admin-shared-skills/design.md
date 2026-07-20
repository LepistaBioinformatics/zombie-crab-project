# admin-shared-skills — Design

Mirrors `admin-shared-content` end-to-end (scope model, tiers, authz, BFF,
cascade) and adds a **skills** content type. Only the storage/mount layer is
genuinely new (skills are directory-shaped and support zip upload); everything
else is a direct clone of the shared-files plumbing.

## Storage layout (proxy)

New `internal/config/config.go` builders (mirror the files/secrets ones):

```go
func TenantSharedSkillsDir(root, tenantID string) string        // <root>/tenants/<t>/shared/skills
func SubscriptionSharedSkillsDir(root, tenantID, subsAccID string) string
                                                                // <root>/tenants/<t>/subscriptions/<s>/shared/skills
```

A skill is a **directory** `.../shared/skills/<skill-name>/` containing
`SKILL.md` (+ optional `references/` etc.). `<skill-name>` is a validated slug.

## Skill store (new `internal/docker/skills.go`)

```go
type SkillMeta struct {
    Name        string `json:"name"`
    Description string `json:"description"`
    Size        int64  `json:"size"`        // total bytes of the skill dir
    ModifiedAt  string `json:"modifiedAt"`
    HasFiles    bool   `json:"hasFiles"`    // more than just SKILL.md
}

func (m *Manager) sharedSkillsDir(scope Scope) string
func (m *Manager) ListSharedSkills(scope Scope) ([]SkillMeta, error)
func (m *Manager) ReadSharedSkillDoc(scope Scope, name string) (string, SkillMeta, error) // SKILL.md text
func (m *Manager) WriteSharedSkillDoc(scope Scope, name, body string) error                // editor mode
func (m *Manager) WriteSharedSkillZip(scope Scope, name string, r io.Reader) error          // upload mode
func (m *Manager) ArchiveSharedSkill(scope Scope, name string, w io.Writer) error           // stream .zip
func (m *Manager) DeleteSharedSkill(scope Scope, name string) error
```

- **Name validation:** `sanitizeSkillName(raw)` — must be a non-empty slug
  matching `^[a-z0-9][a-z0-9._-]{0,63}$` (lowercased), rejecting `shared-content`
  (reserved for the managed skill) and any name that changes under sanitization.
- **Frontmatter validation:** `parseSkillFrontmatter(skillMD) (name, description string, err)`
  — reads the leading `---`…`---` block, requires non-empty `name` and
  `description`. No new YAML dependency: scan fenced lines for `name:` /
  `description:` (values may be quoted). Reject if `SKILL.md` missing or either
  field empty.
- **Editor mode (`WriteSharedSkillDoc`)**: `MkdirAll(dir/<name>, 0700)`,
  validate frontmatter of `body`, write `SKILL.md` (0600), leave any existing
  supporting files untouched, `chownTree`.
- **Upload mode (`WriteSharedSkillZip`)**: read into a size-capped buffer, open
  with `archive/zip`, **harden** each entry (reject absolute paths, `..`
  segments, symlinks/irregular modes; enforce caps below), require a top-level
  `SKILL.md` with valid frontmatter, then atomically replace `dir/<name>`
  (extract to a temp sibling dir, then `RemoveAll`+`Rename`), `chownTree`.
- **Delete**: `os.RemoveAll(dir/<name>)` (idempotent).
- **Archive (download)**: walk `dir/<name>`, stream a zip to `w`.

**Zip hardening caps (NFR-3):** total uncompressed ≤ `MediaMaxBytes` (10 MiB),
entries ≤ 200, per-file ≤ `MediaMaxBytes`, nesting depth ≤ 8. Any breach → error,
nothing written.

## Cascade & precedence (proxy `internal/docker/manager.go`)

picoclaw discovers workspace skills at `workspace/skills/<name>/SKILL.md`; the
managed skill already binds at `workspace/skills/shared-content:ro`. Admin skills
are **additive per-skill RO binds** at `workspace/skills/<name>:ro`.

- In `create`, after the managed-skill mounts, compute the **effective skill
  set** for the container's `(tenant, subscription)`:
  1. list subscription-scope skills of `S`;
  2. add tenant-scope skills of `T` whose name is **not** already provided by
     subscription (subscription-over-tenant precedence, FR-8);
  3. skip the reserved name `shared-content`.
- Ensure each source dir exists + chowned (mirror the tenant/subs shared-files
  loop), then append one bind per skill:
  `<hostSharedSkillsDir>/<name>:<mountDest>/workspace/skills/<name>:ro`.
- **Propagation (FR-10):** editing an existing mounted skill's files is live
  (RO bind reflects host writes; picoclaw mtime-tracks). Adding or removing a
  skill *name* changes the bind set, so create/delete calls invoke the existing
  `RestartScope(scope)` to stop/start affected containers with the new binds —
  the same mechanism shared-files writes already use. No image rebuild.
- **Collision with a user's own skill of the same name:** the admin RO bind at
  `workspace/skills/<name>` takes precedence (governance) — documented; the
  reserved `shared-content` name is additionally protected.

## HTTP API (proxy `internal/httpapi/admin.go` + `handlers.go`)

Mirror the shared-files handlers (`s.adminScope`, `authz.AuthorizeSharedScope`
right after scope resolution). New routes:

```
GET    /v1/admin/skills            -> handleAdminSkillsList     (list SkillMeta)
GET    /v1/admin/skills/doc        -> handleAdminSkillsDoc      (SKILL.md text; preview + editor load)
GET    /v1/admin/skills/archive    -> handleAdminSkillsArchive  (stream .zip download)
POST   /v1/admin/skills            -> handleAdminSkillsPost      (create/replace)
DELETE /v1/admin/skills            -> handleAdminSkillsDelete    (delete by name)
```

`handleAdminSkillsPost` (multipart, mirror `handleAdminSharedPost`): fields
`scope`, `tenant_id`, `subs_acc_id`, `name`, and **either** `body` (editor
`SKILL.md` text) **or** `file` (zip). Discriminate by presence of `file`.
Authorize, then call `WriteSharedSkillDoc` or `WriteSharedSkillZip`; on success
call `RestartScope`. Same `MaxBytesReader`/`ParseMultipartForm` limits as files.
`handleAdminSkillsDoc`/`Archive` set `Content-Type`/`Content-Disposition` like
`handleAdminSharedContent`.

## Gateway (fungi/mycelium `config.standalone.toml`)

Add `[[picoclaw-alpha.path]]` **and** mirrored `[[picoclaw-beta.path]]` blocks
(`group="protected"`, `secretName="picoclaw-alpha-authorization-header"`/beta,
`acceptInsecureRouting=true`):
- `/v1/admin/skills` — `["GET","POST","DELETE"]`
- `/v1/admin/skills/doc` — `["GET"]`
- `/v1/admin/skills/archive` — `["GET"]`

## Webapp (crab-exoskeleton-webapp)

- **`lib/admin.ts`** — new `SkillMeta` type + `listSharedSkills(scope)`,
  `sharedSkillDoc(scope, name)` (text), `saveSharedSkillDoc(scope, name, body)`
  (editor POST), `uploadSharedSkillZip(scope, name, file)` (zip POST),
  `sharedSkillArchiveUrl(scope, name)`, `deleteSharedSkill(scope, name)`. Reuse
  `scopeParams`/FormData patterns.
- **BFF routes** mirroring shared: `app/api/admin/skills/route.ts` (GET/POST/
  DELETE via `proxyAdminJson`), `app/api/admin/skills/doc/route.ts` (GET text),
  `app/api/admin/skills/archive/route.ts` (GET stream, like shared/content).
- **`app/admin/shared-skills-panel.tsx`** — clone of `shared-files-panel.tsx`:
  list skills (name + description + size + a "files" badge when `HasFiles`);
  "New skill" opens an inline markdown editor (`Textarea`) writing `SKILL.md`;
  "Upload .zip" via hidden file input; each row has Preview (opens the SKILL.md
  in a read-only view/editor), Download (`sharedSkillArchiveUrl`), and Delete
  (`ConfirmDialog`). Reuse `Button`/`IconButton`/`Alert`/`Spinner`/`Badge`.
- **`app/admin/admin-screen.tsx`** — add `"skills"` to the `Tab` union and a
  `{ key: "skills", label: "Shared skills", icon: <Wrench size={16}/> }` entry
  in `TABS` (ungated, alongside files/secrets), plus a render branch
  `: tab === "skills" ? (<SharedSkillsPanel scope={selected} />)`.

## Testing

- **Proxy (Go, `_test.go`):** `sanitizeSkillName` (valid/invalid/reserved);
  `parseSkillFrontmatter` (missing SKILL.md, missing fields, quoted values);
  `WriteSharedSkillDoc` round-trips SKILL.md; `WriteSharedSkillZip` extracts a
  good zip and **rejects** traversal/symlink/oversize/too-many-entries zips
  (nothing written); precedence: `effectiveSkills` picks subscription over
  tenant by name and skips `shared-content`; `ArchiveSharedSkill` produces a
  readable zip; `DeleteSharedSkill` idempotent.
- **Webapp:** no component-test harness beyond the vitest added earlier; verify
  `tsc --noEmit` + a production `next build`. Pure helpers in `lib/admin.ts`
  (e.g. a `scopeParams` addition) get a vitest unit test if logic is added.

## Out of scope

Agents/subagents (AD-011, CTX-ASK-01); user-scope skills; instance-scope UI;
editing supporting files via the browser editor (zip only); versioning.

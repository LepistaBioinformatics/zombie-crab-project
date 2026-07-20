# admin-shared-skills — Specification

## Summary

Let managers inject **harness-native skills** into workspaces from the admin
screen, at **tenant** and **subscription** scope, following the exact
`admin-shared-content` pattern (scope-aware CRUD in the proxy → read-only cascade
into every user container below the publishing scope). Skills are picoclaw's
`SKILL.md`-based capability directories. Two authoring modes: an in-browser
markdown **editor** (single `SKILL.md`) and a **zip upload** (a full skill
directory with `references/` and other supporting files).

**Explicitly out of scope: agents/subagents.** Per AD-011, picoclaw agents are
config-registered entities (the `config.json` `agents` block + per-agent
workspace + `dispatch`/`spawn`), not injectable markdown files; admin-provisioned
agents are deferred to a separate future feature.

## Context

- Reuses the tiers, scope model, authorization, BFF, and cascade machinery of
  the implemented `admin-shared-content` feature (see its spec/design). This
  feature adds a **skills** content type alongside shared files and secrets.
- picoclaw skill discovery (verified, AD-011): `~/.picoclaw/workspace/skills/<name>/SKILL.md`
  (workspace) → `~/.picoclaw/skills` (global) → builtin. A skill is a directory
  named by the skill, containing `SKILL.md` (YAML frontmatter `name` +
  `description`, then a markdown body) and optional supporting files/subdirs.
- The proxy already mounts one operator-managed skill read-only at
  `workspace/skills/shared-content` (`managed_skills.go`); admin-shared skills
  are **additive** alongside it.

## Tiers (authority, highest → lowest)

Unchanged from `admin-shared-content`: Instance → Tenant → Subscription → User.
A caller is authoritative over a target scope iff its tier is at/above the
scope's tier **and** within the same branch (same tenant / same subscription).

## Scopes (where skills live)

- **Tenant scope** — skills published by a Tenant tier, cascaded to every user
  container under tenant `T`.
- **Subscription scope** — skills published by a Subscription tier (or above,
  within branch), cascaded to every user container under subscription `S`.
- No user-scope skills (end users don't self-publish skills in v1).

## Functional requirements

### Authoring & storage

- **FR-1** A Tenant-tier (or Instance) caller can **create / list / view / edit /
  delete** skills in the **tenant scope** of `T`. A Subscription-tier caller (or
  above, within branch) can do the same in the **subscription scope** of `S`.
  Authorization reuses the `admin-shared-content` tier-vs-target check.
- **FR-2** A skill is stored as a **directory** keyed by scope and skill name,
  containing at minimum a `SKILL.md`. Supporting files/subdirectories
  (e.g. `references/`) are preserved.
- **FR-3 (editor mode)** The caller can create/edit a skill by supplying the
  **`SKILL.md` body text** directly (no file upload). This writes/overwrites
  only `SKILL.md` in that skill's directory; existing supporting files are left
  untouched.
- **FR-4 (upload mode)** The caller can create/replace a skill by uploading a
  **zip archive** of the skill directory. The archive is validated and extracted
  server-side, preserving `references/` and other files.
- **FR-5 (validation)** A skill is rejected (4xx, nothing written) if: it has no
  `SKILL.md`; the `SKILL.md` frontmatter lacks `name` or `description`; the skill
  name is not a safe slug; or (upload) the zip contains unsafe paths (absolute,
  `..` traversal, symlinks) or exceeds size/entry limits.
- **FR-6** Skill content is **readable/previewable** by managers of that scope
  and above — listing returns skill metadata (name, description, size,
  modified-at, source mode) and viewing returns the `SKILL.md` content and the
  file manifest. (Skills are not secrets; the write-only privacy carve-out does
  not apply.)

### Cascade (down, read-only)

- **FR-7** Tenant-scope skills of `T` are mounted **read-only** into every user
  container under `T`; subscription-scope skills of `S` are mounted **read-only**
  into every user container under `S`, at picoclaw's workspace skill-discovery
  path so the harness loads them like any workspace skill.
- **FR-8 (precedence)** When the same skill **name** exists at more than one
  level, the **most-specific** wins for a given container: subscription-scope
  overrides tenant-scope, which overrides the operator-managed/builtin skill of
  the same name. Exactly one directory per skill name is presented to a
  container. (Exact mechanism decided in design.)
- **FR-9** Cascaded skills are kernel-enforced read-only (`:ro` bind); the agent
  cannot modify, rename, or delete them.
- **FR-10 (propagation)** A create/edit/delete becomes effective in a target
  container following the same discipline as shared files/secrets (no
  container *recreate*; stop/start only where required; picoclaw already
  mtime-tracks skill content at runtime where applicable).

### Discovery & UI

- **FR-11** The admin **scopes** endpoint (from `admin-shared-content`) is
  reused/extended so the UI knows which scopes the caller may administer for
  skills.
- **FR-12** `chat-webapp`'s admin screen gains a **Skills** tab (visible only to
  callers with manage authority), scoped by the existing scope tree, to: list
  skills for a scope; create via editor; create/replace via zip upload; preview
  `SKILL.md`; download the skill; and delete. Mirrors the existing shared-files
  panel UX.

## Non-functional requirements

- **NFR-1** All authorization is enforced **server-side** in the proxy from the
  injected profile; the webapp/BFF never decides authority.
- **NFR-2** Cascade is single-source-of-truth via read-only bind mounts.
- **NFR-3** Zip extraction is hardened against path traversal, symlink escape,
  and zip-bombs (entry count, total-size, and per-file-size caps).
- **NFR-4** Skill names are sanitized/validated to safe slugs before use as
  directory names (reuse `identity.SanitizeID`-style discipline).
- **NFR-5** No new runtime dependency in the webapp beyond what shared-files use;
  proxy zip handling uses the Go stdlib (`archive/zip`).

## Out of scope

| Item | Reason |
| --- | --- |
| **Agents/subagents injection** | AD-011: picoclaw agents are config-registered, not files. Separate future feature. |
| User-scope (end-user self-published) skills | Only managers publish in v1. |
| Instance-scope skills UI | Instance tier provisions via the same store if needed, but no dedicated UI in v1 (consistent with shared-content). |
| Editing supporting files (references/) via the browser editor | Editor edits `SKILL.md` only; supporting files come via zip upload. |
| Skill versioning / history | Same deferral as shared-file versioning. |
| Live hot-reload guarantees beyond picoclaw's existing behavior | Propagation follows the shared-content discipline. |

## Acceptance criteria (EARS)

- **AC-1 (create via editor)** WHEN a Subscription-tier caller (within branch)
  POSTs a skill to subscription scope `S` with a name and a `SKILL.md` body whose
  frontmatter has `name`+`description` THEN the system SHALL create
  `<subscription S skills dir>/<name>/SKILL.md` and respond `201`.
- **AC-2 (create via upload)** WHEN the same caller uploads a zip containing
  `SKILL.md` + `references/foo.md` THEN the system SHALL extract the tree under
  `<... skills dir>/<name>/` preserving `references/foo.md`, and respond `201`.
- **AC-3 (validation)** WHEN a skill is submitted without a `SKILL.md`, or its
  frontmatter lacks `name`/`description`, or (upload) the zip has a `../` entry
  THEN the system SHALL respond `4xx` and write nothing.
- **AC-4 (authorization)** WHEN a caller lacks authority over the target scope
  (wrong branch or lower tier) THEN the system SHALL respond `403` and write
  nothing.
- **AC-5 (cascade)** WHEN a tenant-scope skill exists for `T` THEN every user
  container under `T` SHALL expose it read-only at the workspace skill path such
  that `/list skills` inside the container includes it, and the agent cannot
  write to it.
- **AC-6 (precedence)** WHEN a skill name exists at both tenant and subscription
  scope for a given container THEN that container SHALL see the
  **subscription-scope** version only.
- **AC-7 (preview/list)** WHEN a manager lists/views skills for a scope they
  administer THEN the system SHALL return skill metadata and the `SKILL.md`
  content.
- **AC-8 (delete)** WHEN a manager deletes a skill in a scope they administer
  THEN the system SHALL remove that skill directory and it SHALL no longer
  cascade to containers below.

## Requirement traceability

| ID | Requirement | Status |
| --- | --- | --- |
| FR-1..FR-6 | Authoring, storage, validation, preview | Spec |
| FR-7..FR-10 | Read-only cascade, precedence, propagation | Spec |
| FR-11..FR-12 | Scopes discovery + admin Skills tab | Spec |
| NFR-1..NFR-5 | Server-side authz, RO cascade, zip hardening, slug safety | Spec |

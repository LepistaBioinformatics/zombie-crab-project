# admin-shared-skills — Context (user decisions)

Decisions captured during the discuss phase (2026-07-20).

## CTX-ASK-01: Scope is skills only; agents deferred

picoclaw agents are config-registered, not injectable files (see project
`STATE.md` AD-011, verified against upstream source/docs). The user chose to
ship **skills only** at tenant/subscription scope now, and treat
admin-provisioned agents as a **separate future feature** with its own design.

**Why:** skills fit the read-only file-cascade pattern exactly; agents do not
(they need config merge + workspace/routing/spawn provisioning).

## CTX-ASK-02: Tenant + subscription scope, same pattern as files/secrets

The feature reuses `admin-shared-content`'s tiers, authorization, BFF, and
cascade. Skills are a new content type beside shared files and secrets, at the
same two scopes (tenant, subscription).

## CTX-ASK-03: Two authoring modes — editor and upload

- **Editor mode:** an in-browser markdown editor that writes a single `SKILL.md`
  (frontmatter `name`+`description` + body). No supporting files.
- **Upload mode:** a zip of the whole skill directory, extracted server-side,
  preserving `references/` and any other supporting files/subdirs.

**Why:** the editor is the fast path for simple skills; the zip covers skills
that need supporting files. (User: "no modo edição na tela somente SKILL.md;
se for upload pode ser com pasta references e outras se precisar".)

## CTX-ASK-04: Skills are readable/editable/previewable (not write-only)

Unlike secrets, skill content is manager-visible: list returns metadata, view
returns the `SKILL.md` content and file manifest, and the skill is downloadable.
The user-privacy carve-out (never return bytes) applies only to user-scope
private content, which this feature does not touch.

## CTX-ASK-05: Depth — full pipeline through implementation

The user chose Spec → Design → Tasks → Implement for this feature (verify per
task). A checkpoint for user review is taken after Tasks, before Execute.

## Open design questions (to resolve in design.md)

- **Mount mechanism & precedence (FR-7/FR-8):** picoclaw discovers workspace
  skills at `workspace/skills/<name>/`. Options for cascading tenant +
  subscription skills without collisions: (a) proxy composes a single merged
  read-only skills view per container applying subscription-over-tenant
  precedence by name; (b) map scopes to picoclaw's separate skill *sources*
  (workspace vs global `~/.picoclaw/skills`). Decide in design; must not collide
  with the user's own `workspace/skills` or the managed `shared-content` skill.
- **Editor `SKILL.md` frontmatter validation** location (BFF vs proxy) — proxy
  is authoritative (NFR-1) but the editor may pre-validate for UX.
- **Zip hardening limits** (max entries, max total size, max per-file) — set
  concrete numbers in design.

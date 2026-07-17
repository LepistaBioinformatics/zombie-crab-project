# managed-skills — Specification

## Summary

An immutable, operator-managed picoclaw **skill** injected into every agent
container's workspace, complementing `admin-shared-content`. It tells the agent
where manager-provisioned shared files and secrets live, how to load them, and
that it must never copy secrets elsewhere. The agent cannot alter it, and any
attempted change is discarded on restart.

## Grounding (verified against the picoclaw binary)

picoclaw loads skills from `workspace/skills/<name>/SKILL.md`
(`github.com/sipeed/picoclaw/pkg/skills`); a SKILL.md is required YAML
frontmatter (`name`, `description`) + a Markdown body, optionally with a
`references/` subdir. This is the standard claw/claude-code skill format.

## Functional requirements

- **FR-1** A managed skill `shared-content` is present at
  `workspace/skills/shared-content/SKILL.md` in every agent container, authored
  by the operator (shipped embedded in the proxy binary).
- **FR-2** Its content documents: the read-only shared-file locations
  (`workspace/.shared/tenant/`, `workspace/.shared/subscription/`), the secret
  sources (shared secrets as env; the user's own `workspace/.secrets/` sinks),
  how to load each, and explicit rules never to copy/echo/log/relocate secret
  values.
- **FR-3 (immutable)** The skill is bind-mounted **read-only** — the agent
  cannot modify, rename, or delete it (kernel-enforced, mirroring the
  `.secrets:ro` mount).
- **FR-4 (restored on restart)** The mount source is materialized from the
  proxy's embedded copy and is root-owned; every container (re)start remounts
  the canonical version, so even a hypothetical edit never survives a restart.

## Non-functional

- **NFR-1** Single source of truth: one embedded copy, materialized once per
  proxy process to `<root>/managed-skills/`, bind-mounted into every container —
  no per-user duplication.
- **NFR-2** Additive to the container spec; does not overlay or hide the agent's
  own seeded `skills/` (only the `shared-content` subdir is mounted).

## Implementation
- `crab-shell-proxy/internal/docker/managed/skills/shared-content/SKILL.md` —
  embedded content.
- `internal/docker/managed_skills.go` — `//go:embed` + `materializeManagedSkills`.
- `internal/config/config.go` — `ManagedSkillsDir(root)`.
- `internal/docker/manager.go` — materialize once (`sync.Once`) + RO bind
  `<root>/managed-skills/shared-content → workspace/skills/shared-content:ro`.

## Out of scope
- Per-agent or per-tenant skill variation (one global managed skill in v1).
- Operator-editable managed-skill content via the admin UI (it is proxy-shipped;
  changing it means updating the embedded copy and redeploying).

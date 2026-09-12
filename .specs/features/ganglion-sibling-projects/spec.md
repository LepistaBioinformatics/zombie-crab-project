# ganglion-sibling-projects

Move a ganglion project's workspace from `workspace/projects/<id>` to
`workspace-<id>`, a sibling of the main workspace, so both harnesses lay a
per-user directory out the same way (`.claude/rules/harness-layout.md`).

## Why the current layout exists, and why it goes

`ganglion-projects` slice A put a project under the workspace on purpose, and the
reason is written in `config.GanglionProjectWorkspace`: the ganglion binds one
directory, so a subdirectory of it needs **no new bind**, and therefore no
container recreate — which matters for an agent that under `scale-to-zero` may
not be running when a project is created.

That reason was real and it is not enough. The cost it bought was a second
layout, and a second layout costs more than a recreate:

- `config.WorkspaceSegment` branches on the harness, so every caller of
  `SessionsDir`, `PublicDir` and the media code inherits the branch. A caller
  that forgets it does not fail — it reads a directory that never exists and
  reports that the member has no history (this already happened twice: the
  scoped-fixes defect, and `/v1/cron/tasks` reading `config.CronFile` for a
  ganglion agent).
- picoclaw's own tooling resolves `<workspace>/../workspace-<id>` independently
  (`resolveAgentWorkspace`), so the sibling name is a fact about the stack rather
  than a convention the proxy is free to restate.

And the recreate it avoided is nearly free for the harness that has this problem:
the ganglion runs `scale-to-zero` with a 15s idle timeout, so its container is
created per turn anyway.

## Requirements

**FR-1** — A ganglion project's workspace is `<user dir>/workspace-<id>` on the
host: the same path `config.ProjectWorkspace` already returns for picoclaw.
`GanglionProjectWorkspace` is deleted rather than made to agree — two functions
that must return the same string are one function.

**FR-2** — `config.WorkspaceSegment(harness, project)` stops branching on the
harness. It keeps its signature: the caller still has to know which agent it is
addressing for other reasons, and a parameter removed today is a parameter
re-threaded through thirty call sites tomorrow.

**FR-3** — A ganglion container gets **one bind per workspace**: `workspace/` at
`<mount>/workspace`, plus `workspace-<id>` at `<mount>/workspace-<id>` for every
project the member has. Nothing above them is mounted.

This is what keeps the ganglion's confinement while adopting picoclaw's layout.
picoclaw mounts the whole user dir and relies on `restrict_to_workspace`; the
ganglion has no such setting — its only tool is `/bin/sh -c <string>`, with no
path argument to refuse — so the container boundary is the confinement, and
proxy-owned state (`.schedules.json` above all) must stay outside it.

**FR-4** — The bind set changing recreates the container. The existing
`ganglionBindDrift` check already does this; it must see the project binds.

**FR-5** — The harness resolves a project root as
`<workspace>/../workspace-<id>`, mirroring picoclaw's own derivation. Every
consumer of `domain.ProjectRoot` — the shell's working directory, `load_image`,
`generate_image`, the skills prompt — follows it with no change of its own.

**FR-6** — The harness's transcript and window stores take the project's
workspace rather than a `Projects` root under the main one. `sessions/` and
`windows/` live inside `workspace-<id>` exactly as they do inside `workspace/`.

**FR-7** — The shell's sandbox root becomes the **turn's** root, not always the
main workspace.

This is a tightening, not a consequence. Today a turn inside a project runs
under a Landlock ruleset rooted at the main workspace, so `cd ../other-project`
is reachable; a project exists to keep a subject apart, and the filesystem was
not enforcing it. With sibling workspaces the sandbox must move anyway, and the
right place to move it to is the narrower one.

**FR-8** — An existing `workspace/projects/<id>` subtree is **migrated** to
`workspace-<id>` on the next ensure, once, and the empty `projects/` directory is
removed. Same shape as `MigratePublicDir`, which exists for the same reason: a
member who already has transcripts must not lose them to a rename.

**FR-9** — The proxy's project seeding, sweeping and deletion follow the new
path. `removeProjectWorkspace` already removes both shapes; after FR-8 there is
only one, and the legacy branch stays only as long as the migration does.

## Non-functional

**NFR-1** — A ganglion agent with zero projects is unaffected: same bind, same
paths, same requests. The regression bar for every slice of this feature.

**NFR-2** — No new dependency in the harness; `go.mod` stays at zero requires.

## Out of scope

The memory graph. It is reached over MCP with the project in a header
(`crab-shell-proxy#48`) and has no filesystem path in the container at all, so a
directory move does not touch it.

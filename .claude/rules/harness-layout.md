# Harness layout

**Every harness lays its per-user directory out the way picoclaw does.** A path
that means one thing under picoclaw means the same thing under any other harness
this stack spawns.

This is not a compatibility shim for picoclaw's benefit. picoclaw happens to be
the harness that defined the shape, but the shape is now the stack's: the proxy
reads and writes these directories from outside the container, and it is a single
set of functions doing it (`internal/config`'s path helpers, `internal/history`,
`internal/docker`'s media and project code). One layout is what lets those stay
one implementation instead of branching per harness — and a branch that is
*missing* does not fail, it reads an empty directory and reports that the member
has no history, no files and no scheduled tasks.

## The layout

```
<user dir>/                       the proxy's, NOT necessarily mounted
├── config.json                   harness configuration, proxy-written
├── .security.yml                 picoclaw only
├── .projects.json                proxy-owned: which projects exist
├── .schedules.json               proxy-owned: scheduled tasks (ganglion)
├── .crab-owner.json              proxy-owned: who this workspace belongs to
├── workspace/                    THE MAIN AGENT
│   ├── AGENT.md SOUL.md HEARTBEAT.md USER.md
│   ├── memory/  public/  sessions/  ...
└── workspace-<project-id>/       ONE PER PROJECT, A SIBLING OF workspace/
    ├── AGENT.md SOUL.md HEARTBEAT.md USER.md
    └── memory/  public/  sessions/  ...
```

**A project workspace is a SIBLING of the main workspace, never a child of it.**
`workspace-<id>`, not `workspace/projects/<id>`.

The name is not a preference. picoclaw derives a named agent's workspace as
`<defaults.workspace>/../workspace-<id>` when the agent config does not set one
(`pkg/agent/instance.go`, `resolveAgentWorkspace`), so its own tooling resolves
that path independently of anything the proxy writes. A second harness that put
projects somewhere else would make `config.WorkspaceSegment` two functions
pretending to be one.

## What this does NOT mean

**It does not mean every harness mounts the same thing.** The layout is what the
paths ARE; the bind set is a separate decision, and the two harnesses differ
there for a reason worth keeping:

- picoclaw mounts the **whole user dir**. Its own `restrict_to_workspace` keeps
  the agent inside `workspace/`, so proxy-owned state can sit beside it.
- the ganglion mounts **each workspace separately** — `workspace/` and one bind
  per `workspace-<id>` — and nothing above them. It has no
  `restrict_to_workspace`: its only tool is `/bin/sh -c <string>`, with no path
  argument to refuse, so **the container boundary is the confinement**. Proxy
  owned state has to be on the other side of it rather than merely adjacent.

That difference is load-bearing. `.schedules.json` is a standing instruction to
the proxy to wake a container and run a turn; inside a ganglion bind, a turn
steered by untrusted text could write one. The layout is shared; the mount is
not.

## When adding a harness

Read `internal/config`'s path helpers first. If the new harness cannot produce
this layout, the answer is a bind per directory (what the ganglion does), not a
second layout and not a segment function that branches on the harness name.

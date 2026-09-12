# harness-filesystem-parity

A survey of every place the ganglion's directory, file and configuration layout
differs from picoclaw's, and what each difference costs.

Written against `.claude/rules/harness-layout.md`, which says the layout is
shared and the bind set is not. This document is the audit that rule implies:
what still diverges, and which divergences are defects rather than decisions.

## How this was established

By comparing two running systems, not by reading code alone:

- picoclaw: the live `crabshell-alpha-*` container's `/data/.picoclaw`.
- ganglion: the `gamma` agent's on-disk user directory, plus the harness's own
  path constants and the proxy's ganglion writers.

Every finding below names the evidence. Where a claim could not be established
from a running system it says so.

---

## The two trees, as observed

```
picoclaw  ~/.picoclaw/                 ganglion  <mount>/  (+ user dir above it)
├── config.json                        ├── .ganglion-config.json     D-1
├── .security.yml                      ├── (env instead)             KEEP
├── .projects.json                     ├── .projects.json            ok
├── .crab-owner.json                   ├── (absent)                  D-2
├── (n/a)                              ├── .schedules.json           KEEP
├── (n/a)                              ├── credential.key            KEEP
├── memory-graph-<project>/            ├── memory-graph[-<project>]/ ok
├── skills/                            ├── (absent here)             D-3
├── logs/                              ├── (absent)                  info
├── workspace/                         ├── workspace/
│   ├── AGENT SOUL HEARTBEAT USER.md   │   ├── AGENT SOUL HEARTBEAT  D-4
│   ├── memory/MEMORY.md               │   ├── MEMORY.md             D-5
│   ├── memory/{FILE_DELIVERY,…}.md    │   ├── (absent)              D-6
│   ├── public/                        │   ├── (absent)              D-7
│   ├── .shared/{tenant,subscription}  │   ├── (absent)              D-8
│   ├── cron/jobs.json                 │   ├── (above the bind)      KEEP
│   ├── .secrets/                      │   ├── (env instead)         KEEP
│   ├── skills/                        │   ├── shared-skills/        D-3
│   ├── sessions/sk_v1_<64>.jsonl      │   ├── sessions/<32>.jsonl   D-9
│   │   + .meta.json                   │   │   (no meta)             D-9
│   ├── state/state.json               │   ├── (absent)              info
│   └── (n/a)                          │   └── windows/              info
└── workspace-<id>/                    └── workspace-<id>/           ok (fixed)
    ├── AGENT SOUL HEARTBEAT USER.md       ├── AGENT SOUL HEARTBEAT  D-4
    ├── memory/  public/  sessions/        ├── memory/ public/ …
    ├── skills/                            ├── (per-workspace now)   ok
    ├── .artifacts/mcp                     ├── (absent)              info
    └── (n/a)                              ├── PROJECT.md  windows/  info
                                           └── media/                D-10
```

---

## Divergences

### D-1 — the configuration file has a different name

`config.json` (picoclaw) against `.ganglion-config.json` (ganglion), both in the
user directory, both written by the proxy.

**Cost:** every path helper that names the file branches, and
`admin-instance-config` — the admin editor that repairs one instance's
`config.json` — reads the picoclaw name unconditionally. An admin opening a
ganglion instance's configuration sees the wrong file or none.

**Fix:** one name. `config.json` is the one to keep: it is what the admin surface
already reads and what picoclaw's own tooling writes. The ganglion reads whatever
`GANGLION_CONFIG_FILE` points at, so this is a constant on the proxy side and an
env value in the compose file — no harness change.

**Not just a rename:** the file is bound READ-ONLY into the ganglion at
`<mount>/config.json` and NOT bound at all into picoclaw (it lives inside the
wide bind). The rename must not move it inside any ganglion bind — see the rule.

### D-2 — no owner marker

picoclaw's user dir carries `.crab-owner.json`; the ganglion's does not.

**Cost:** `ownerEmail(userDir)` reads it, and `ListSubscriptionUsers` uses that to
label a member in the admin surface. A ganglion workspace lists with an empty
email. Confirmed by reading the function, not observed in the UI.

**Fix:** write it on the ganglion provision path. `provision()` writes it for
picoclaw; `provisionGanglion` does not.

### D-3 — the admin's shared skills land in a different place, under a different name

picoclaw: `<mount>/skills` (beside the workspace) AND `workspace/skills`.
ganglion: `workspace/shared-skills`, and now one per project workspace.

**Cost:** the two harnesses index skills from different paths, so the managed
skills feature has two implementations of "where skills are". A skill an admin
publishes is found by both today only because each side hardcodes its own answer.

**Fix is NOT a straight rename.** `ganglionSkillsDest` documents why it is inside
the workspace: the harness renders a skills index with PATHS, and the shell's
Landlock root is the workspace — an index outside it points at files the agent
cannot open. picoclaw has `restrict_to_workspace` and a path-taking file tool, so
it can read from beside the workspace. The layouts can agree on the NAME
(`skills/`) with the ganglion keeping it inside each workspace; they cannot agree
on the location without giving the ganglion a second readable hierarchy.

### D-4 — USER.md is seeded for picoclaw and absent for the ganglion

Three persona files are MOUNTED read-only on both harnesses (`PersonaMounted`:
`AGENT.md`, `SOUL.md`, `HEARTBEAT.md`). `USER.md` is deliberately not one of
them — the agent writes what it learns about the member there, so a read-only
bind would silently disable that write. It is SEEDED instead, from
`config.WorkspaceSeed`, on the picoclaw provision path.

The ganglion has no seed step, so its main workspace has no `USER.md` at all.
Confirmed on disk: `workspace/` has none. (The `workspace-test/` that does is the
pre-sibling scaffold, not something the ganglion wrote.)

**Cost:** an operator's injected `USER.md` reaches a picoclaw member and not a
ganglion one, and a ganglion agent has nowhere conventional to record what it
learns about the member — which is the same gap D-5 describes for its own memory.

**Fix:** seed `USER.md` on the ganglion provision path, from the same source.

**While confirming this, a second fact worth writing down:** `personaBinds`
hardcodes `mountDest + "/workspace/" + name`, so the persona lands in the MAIN
workspace only. For picoclaw that is incomplete — each project is a separate
agent and picoclaw seeds its own persona per project workspace. For the ganglion
it is CORRECT: one agent, one persona, and a project turn reading the main
workspace's `AGENT.md` is the intended behaviour, not an oversight. Anyone
extending persona binds to project workspaces must not do it for the ganglion.

### D-5 — MEMORY.md sits at the workspace root, not under memory/

picoclaw: `workspace/memory/MEMORY.md`. ganglion: `workspace/MEMORY.md`, and
`workspace-<id>/MEMORY.md` for a project.

**This one is documented as a divergence in the code that causes it.**
`skills.MemoryFileName`'s comment says picoclaw's memory is
`<workspace>/memory/MEMORY.md` and then reads a different path.

**Cost:** the proxy's managed-memory writer targets `workspace/memory/`. A
ganglion agent's memory is therefore invisible to anything the proxy does with
memory, and an admin-managed memory document cannot reach it (see D-6).

**Fix:** read and write `memory/MEMORY.md`. One constant in the harness plus a
migration for the file already at the root.

### D-6 — the managed memory documents are not mounted

picoclaw's `workspace/memory/` carries `FILE_DELIVERY.md`, `CONTEXT_RECOVERY.md`
and `MEMORY_ROUTING.md`, bound in by `managedContentBinds`. The ganglion gets
none of them.

**Cost:** real and member-visible. `FILE_DELIVERY.md` is what tells an agent to
write deliverables into `public/attachments/` — the only place the member's
interface lists. A ganglion agent has never been told that, which is a plausible
cause of "the agent says it made a file and I cannot find it".

**Fix:** `managedContentBinds` takes a mount destination; it is harness-agnostic
already. Add it to `ganglionBinds`, after D-5 so the destination exists.

### D-7 — the main ganglion workspace has no public/

Seeded for every ganglion PROJECT (`ganglionProjectDirs`) and for every picoclaw
workspace, but not for the ganglion's own.

**Cost:** probably none today — `internal/docker/media.go` does `MkdirAll` before
writing, so the first upload creates it. The divergence is that the directory's
existence is a side effect of an upload rather than part of the workspace, so an
agent told to write into `public/attachments/` before any upload has happened
writes into a directory that is not there.

**Fix:** seed it with the workspace. One line, and it removes an ordering
dependency nobody would look for.

### D-8 — the admin's shared FILES are not mounted

picoclaw's `workspace/.shared/` holds four binds: tenant, tenant-agent,
subscription, subscription-agent. The ganglion gets none.

**Cost:** `admin-shared-content` is inert for ganglion agents. An admin publishing
a document to a subscription reaches picoclaw members and silently not ganglion
ones — the failure `harness_gate.go` exists to prevent, in a feature that has no
gate row.

**Fix:** either mount them (`sharedMounts` is built the same way) or add a
`featureSharedContent` row to the gate so the surface refuses honestly. Mounting
is better and is the same shape as D-6.

### D-9 — transcripts are named differently and carry no meta

picoclaw: `sk_v1_<64 hex>.jsonl` plus `<same>.meta.json`.
ganglion: `<safe(conversation id)>.jsonl`, no meta.

**Cost:** already paid, twice. `internal/history` carries a whole second read
path for the ganglion's naming, and `crab-shell-proxy#45` fixed a member-visible
blank conversation caused by the two sides disagreeing about that name.
`history.WriteCronMeta` exists because the proxy has to write the meta the
ganglion never will.

**Fix: do NOT unify this.** It is the one divergence worth keeping, because
picoclaw's name is a hash of a value the proxy already owns and the ganglion's is
the value itself — the ganglion's is the better design and the reader already
handles both. What SHOULD change is that this is written down as a decision
rather than surviving as an accident. It is the reason `harnessBasename` exists
and the reason it must never be "simplified".

### D-10 — media/ exists only for ganglion projects

`ganglionProjectDirs` seeds `media/`; picoclaw has no such directory, and the
ganglion's main workspace does not either.

**Cost:** `imagegen.MediaDirName` writes generated images there, so it is the
harness's own directory and picoclaw has no equivalent feature. The divergence is
that it is seeded for projects and not for the main workspace.

**Fix:** seed it with both, or with neither and let `imagegen` create it. Same
class as D-7.

---

## Not divergences, though they look like it

- **`windows/`, `PROJECT.md`, `.artifacts/`, `state/`, `logs/`** — each exists on
  one side because only that side has the feature. Parity is not "the same files"
  but "the same path means the same thing".
- **`memory-graph[-<project>]/`** — shared code (`memgraph.Dir`), already
  identical. picoclaw's main graph is simply absent for a user who has none.
- **`.secrets/` and `.security.yml`** — the ganglion takes credentials from the
  environment. Deliberate, recorded in `ganglionEnv`.
- **`cron/jobs.json` vs `.schedules.json`** — deliberate and load-bearing: the
  proxy is the ganglion's scheduler, so a store inside the bind would let a turn
  schedule its own future turns. `.claude/rules/harness-layout.md` states it.

---

## Found while surveying, and not a layout question

**B-1 — a request with no conversation id writes `_.jsonl`.**

`httpsse.request.sessionID` falls back to the body and then to `""`, and
`jsonl.safe("")` returns `"_"`. The store writes a valid-looking transcript under
a name nothing reads back.

Observed: `workspace/sessions/_.jsonl` exists in the gamma workspace and holds
real turns ("diga apenas: OLA_SUBAGENTE", Sep 10 15:38). Its content predates the
current binary, so it is evidence that this HAS happened, not that the path that
produced it is still reachable the same way — the sub-agent runner now uses an
in-memory store and a named conversation.

The fallback itself is still there. A turn with no id should be refused at the
ingress, the way an invalid project already is.

---

## Recommended order

The fixes are small and mostly independent; the order that matters is D-5 before
D-6, because the managed memory documents need `memory/` to exist.

| | Change | Where | Size |
|---|---|---|---|
| 1 | D-5 `memory/MEMORY.md` + migration | harness | small |
| 2 | D-6 managed memory binds | proxy | small |
| 3 | D-8 shared content binds | proxy | small |
| 4 | D-7, D-10 seed `public/` and `media/` | proxy | trivial |
| 5 | D-2 owner marker | proxy | trivial |
| 6 | D-1 config file name | proxy + compose | small |
| 7 | B-1 refuse an empty conversation id | harness | trivial |
| 8 | D-3 skills naming | both | medium, design needed |
| 9 | D-4 seed `USER.md` | proxy | trivial |

D-9 is deliberate and closed: no work, a decision record.

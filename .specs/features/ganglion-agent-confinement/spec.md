# ganglion-agent-confinement

**Status:** Specified. Date: 2026-09-10. Size: Medium — design is inline, no `tasks.md`.

## Why

picoclaw confines its agent to the workspace and keeps credentials where the agent
cannot read them. The ganglion harness was built for streaming, durability and token
accounting, and **shipped without an equivalent**. This spec states exactly what the gap
is, which parts of it can be closed, and which part of picoclaw's mechanism is
structurally unavailable here and must be replaced rather than copied.

Nothing here is cross-tenant. The container boundary holds: one per-user directory, uid
1000, no docker socket. What is exposed is exposed to the member who owns the container —
and, through the agent, to anyone who can talk that agent into printing it.

## What picoclaw does, verified

Three layers, and the second only works because of the first.

**1. `restrict_to_workspace`.** `defaulttemplate/picoclaw/config.json`:

```json
"restrict_to_workspace": true,
"allow_read_outside_workspace": false
```

picoclaw's tools take path arguments, resolve them, and refuse anything outside
`<mount>/workspace`.

**2. Credentials sit one level above `workspace/`,** and layer 1 is what hides them.
`.security.yml` holds `model_list.<model>.api_keys` and the pico channel token at
`<mount>/.security.yml`. So does the rest of the proxy's control plane —
`.projects.json`, `.crab-owner.json`, `config.json`. `agent-projects/context.md` is
explicit that this is deliberate: an agent that could edit `.projects.json` could route a
peer's conversations to itself.

**3. The container environment carries no secret at all.** Verified on the live alpha
container:

```
PICOCLAW_GATEWAY_HOST=0.0.0.0
HOME=/data
PATH=...
```

Three variables. The deploy-level key `PICOCLAW_ALPHA_API_KEY` is read by the proxy and
written into `.security.yml` — it never enters the container as environment.

## What ganglion does today, verified

### F-1 — The provider key and the bearer are in the container environment

`docker inspect` of the live gamma container:

```
GANGLION_TOKEN=pico-d…
GANGLION_API_KEY=sk-0b2…
GANGLION_BASE_URL=https://api.deepseek.com/v1
```

`internal/adapter/tool/exec` builds `exec.Command("/bin/sh", "-c", …)` and never sets
`cmd.Env`. Go's contract: *"If Env is nil, the new process uses the current process's
environment."* So `env` inside the shell tool prints both. Confirmed with a probe binary
reproducing the exact construction, not only by reading the stdlib doc.

`GANGLION_API_KEY` resolves from `apiKeyEnv` in the proxy's `config.yaml`, which is
**per agent, not per user**. Every member on `gamma` shares one DeepSeek key, and it is
sitting in each of their containers' environment. picoclaw has the same shared key with
the same blast radius — the difference is entirely in where it is put.

### F-2 — There is no path confinement, and the code says there is

`exec.Tool` sets `cmd.Dir = t.Workdir`. That is the working directory, not a boundary:
`cat /etc/hostname`, `ls /`, `cd ..` all succeed. Confirmed with the same probe.

The package doc comment claims otherwise:

> What this package still owns is keeping a command from reaching outside the workspace
> root, because a tool that can be talked into reading /proc or the mounted secrets is a
> tool that eventually will be.

**It owns no such thing.** This is the single worst line in the harness: this project's
recurring failure is contracts nobody can verify from where they are written, and this
one asserts a control that does not exist, to a reader with no way to notice.

### F-3 — The bearer token file is inside the mount, above the workdir

`provisionGanglion` writes `<userDir>/.crab-ganglion.json` (0600, chowned to the agent's
own uid), and the bind is `hostDir:/data/.ganglion` read-write. The workdir is
`/data/.ganglion/workspace`. So `cat ../.crab-ganglion.json` reads it.

That path — proxy-owned state one level above `workspace/` — is *exactly* the slot
picoclaw's `restrict_to_workspace` protects. Ganglion adopted the layout without the
mechanism that made it safe.

## Not regressions — parity with picoclaw, out of scope

Recorded so a later reader does not re-open them as findings:

- **The agent can rewrite its own transcript.** `sessions/*.jsonl` and `windows/` live
  under `workspace/`, so the shell tool can edit them and defeat the append-only
  invariant. picoclaw's sessions are under its workspace too.
- **The agent can reach the proxy over the network.** Both harnesses join
  `m.cfg.Network`. Reachability is not authorization; F-1 is what would turn it into one,
  and F-1 is fixed here.

## Prospective, not live — a constraint on FR-7

`GANGLION_TOKEN` is used twice: the ingress bearer the proxy presents to the harness, and
the outbound bearer the approver presents to `GANGLION_APPROVAL_ENDPOINT`. With F-1 the
agent can read it, so an agent could dial the approval endpoint itself.

**This is not exploitable today** — the proxy-side endpoint does not exist (FR-7, OQ-3
open) and `GANGLION_GATED_TOOLS` is empty, so `Request` short-circuits with
`Allowed: true, "not gated"` and never dials out. Fixing F-1 also closes this. It is
recorded as a **design constraint**, not a vulnerability:

> **DC-1.** The approvals endpoint must not treat a harness-presented bearer as
> authorization for a decision. The harness presents *identity*; the proxy decides from
> its own state and mycelium's account id. A token the agent can read is not an
> authorization token.

## Requirements

| ID | Requirement |
|---|---|
| FR-1 | The shell tool runs with an explicit environment allowlist. No provider key, no bearer. |
| FR-2 | The `exec` package doc describes what it actually enforces. |
| FR-3 | Proxy-owned per-user state is not reachable from inside the container. |
| FR-4 | An existing container created with the old bind is recreated, not left running. |
| NFR-1 | No change to picoclaw's container path. |

## AC

- **AC-1** — `env` in the shell tool prints neither `GANGLION_API_KEY` nor
  `GANGLION_TOKEN`; the harness itself still reaches the provider.
- **AC-2** — A test asserts the allowlist by name, so adding a variable to `ganglionEnv`
  does not silently widen the tool's view.
- **AC-3** — `cat ../.crab-ganglion.json` from the workdir finds nothing.
- **AC-4** — A container carrying the old bind is recreated on the next turn.

> **Superseded in part by Phase 2 (below).** The section that follows concluded
> that no confinement was achievable and that the container was the only boundary.
> That was wrong in one specific way: it considered only tool-layer path checks.
> Landlock is a kernel mechanism an unprivileged process can apply to itself, and
> it makes a real confinement possible. The reasoning about *path checks* stands
> and is why one was not built; the conclusion drawn from it did not.

## Design — why the picoclaw mechanism cannot be copied

`restrict_to_workspace` is a **tool-layer path check**. It works because picoclaw's tools
take a path argument to resolve and refuse.

**Ganglion's only tool is `/bin/sh -c <arbitrary string>`. There is no path argument to
check.** Any blocklist of `..`, `/etc`, `/proc` is defeated by
`$(echo L2V0Yw== | base64 -d)`, and shipping one would produce something that reads like
security and is not. Parity is not a matter of porting the flag, and the next reader must
not assume it is.

What replaces it is **the container boundary itself** — which is what `exec`'s own first
paragraph already, correctly, says:

> The container is per-user and holds only that member's workspace, so the isolation
> boundary is the container itself -- not a sandbox inside it.

That sentence is true, and F-1 and F-3 are the two places the deployment broke it by
putting things inside the container that the boundary was supposed to keep out. The fix
is to make the statement true again, not to build a second boundary inside the first.

### Three changes

1. **`cmd.Env` allowlist** (`exec.go`) — `PATH`, `HOME`, `TERM`, and nothing else. One
   field. Closes F-1 and DC-1 together. Independent of the rest.
2. **Bind `workspace/` instead of the user dir** (`ganglion.go`) — the token file then
   stays on the host, outside the container. Closes F-3.
3. **The doc comment** — closes F-2, and is the change most likely to matter in a year.

Change 2 needs the drift check (FR-4): bind sets are fixed at create time, so the running
gamma container keeps the old wide mount until something recreates it. `personaBindDrift`
already exists for precisely this class of bug and the workspace bind joins it.

### Do not "restore parity" by moving the secrets into a file

picoclaw's answer to F-1 is *put the credential in a file the agent cannot read*. Copying
that here would make things **worse**, and the reason is the same one that makes change 1
possible at all:

- picoclaw can hide a file, because `restrict_to_workspace` refuses the path.
- ganglion cannot hide anything inside the mount — the shell tool `cat`s whatever the
  filesystem holds. A `.security.yml` equivalent would be one `cat ..` away, and, unlike
  an environment variable, **there is nothing to remove it from**.

A secret in the environment is removable from the child process. A secret in a mounted
file is not. So for this harness the environment is the *safer* channel, and the fix is
to scrub the child rather than to relocate the secret. A reader chasing parity with
picoclaw will want to invert this; it would reopen F-1 with no way to close it again.

## Execution

Implemented, uncommitted. Three files changed plus tests.

**`crab-ganglion-harness/internal/adapter/tool/exec/exec.go`** — `cmd.Env = scrubEnv(os.Environ())`
against a `passThrough` allowlist (`PATH`, `HOME`, `TERM`, `LANG`, `TZ`). An allowlist
rather than a denylist of secret-looking names: the proxy decides what enters the
container, so a denylist would need editing in a second repository on every addition, and
forgetting fails silently. The package doc now states that it does **not** confine, why it
cannot, and that the container is the boundary.

**`crab-shell-proxy/internal/docker/ganglion.go`** — `ganglionWorkspaceBind` binds
`<hostDir>/workspace` at `<mountDest>/workspace` instead of the whole user dir;
`ganglionWorkspaceDrift` joins `personaBindDrift` and `imageDrift` so a container created
with the old bind is recreated rather than kept forever. The bind set moved into
`ganglionBinds`, for the reason `ganglionEnv` was split out: the drift checks read it back
and nothing else can prove the two agree without a daemon.

**`crab-shell-proxy/internal/config/config.go`** — unrelated to this feature, and a broken
test on `main` from `f4c3183`: `ganglionUnprovisioned` returned "required model API key
environment variable is unset" without naming the variable, which is the one thing the
disable-instead-of-exit design exists to say. Now names it. `TestLoadDisablesAGanglionAgentWhoseKeyIsUnset`
was failing before this change and passes after.

### Evidence

| Claim | How it was checked |
|---|---|
| Secrets were in the live container's env | `docker inspect crabshell-gamma-… .Config.Env` — `GANGLION_API_KEY=sk-0b2…`, `GANGLION_TOKEN=pico-d…` |
| picoclaw's env carries none | same command on `crabshell-alpha-…` — three variables, no secret |
| `cmd.Env == nil` inherits, `cmd.Dir` does not confine | probe binary reproducing `exec.go`'s exact construction |
| The fix works and the test would catch its removal | `TestSecretsAreNotVisibleToACommand` passes; with `cmd.Env` assignment removed it fails naming the secret |
| No regression | `internal/docker`'s failing set is byte-identical to baseline (10, all `lchown … operation not permitted`, the pre-existing sandbox limit); every other package green in both repositories |
| The artefact builds | `docker build` green — the Dockerfile runs `go vet` and `go test` |
| The narrowed mount actually works | `docker run` with only `workspace` bound: the harness reaches `listening on :18800`, and from inside, `/data/.ganglion` is root-owned holding nothing but a writable `workspace` |
| Narrowing does not cause a recreate every turn | `TestGanglionBindsDoNotLookLikeDrift` — `personaBindDrift` counts persona mounts under the prefix `<mountDest>/workspace/`, and the new bind's destination has no trailing slash, so it is not counted. Asserted against the exact list `createGanglion` builds, not a hand-written one |

### Not verified live

**The scrub** is proven by unit test and by the probe, **not** by a turn on a running
container: that needs a rebuilt proxy image so the drift check fires and recreates gamma.
The harness dev image is rebuilt; the proxy is not.

**AC-4** is the predicate, not the path. `ganglionWorkspaceDrift` is tested directly and
against the real bind set, but the composite recreate in `ensureGanglionRunning` runs only
in `TestEnsureRunningRecreatesOn…`, which is inside the pre-existing `lchown` failure set
and does not execute in this environment. What is proven is that the predicate answers
true for the old bind and false for the new one.

### Still open

**DC-1** — carried into `crab-ganglion-harness` FR-7 / OQ-3, which has no code yet.


---

# Phase 2 — real confinement, and encrypted credentials

**Status:** Specified and implemented. Date: 2026-09-10. Size: Large.

Requested directly: *"Implemente a restrição de workspace como padrão, sem outra opção
e a encriptação das variáveis."*

## What changed the answer

Phase 1 said a workspace restriction was unavailable to this harness. Two findings
overturned that.

### F-4 — the environment scrub did not close F-1

Phase 1's fix keeps the provider key out of a command's own environment. It does not
keep the command from reading it. PID 1 is the harness, it holds the key, and it runs as
the same uid:

```
$ env -i PATH=... /bin/sh -c 'cat /proc/1/environ | tr "\0" "\n" | grep GANGLION'
GANGLION_API_KEY=sk-secret-in-pid1
```

Run in the real image, with a genuinely empty child environment. **F-1 was not closed by
Phase 1**, and nothing in Phase 1's test suite could have said so — every test asserted
the child's *own* environment.

### F-5 — a kernel mechanism exists that an unprivileged process may use

Landlock. Confirmed in the deployment's own container: **ABI version 8**, no
`CAP_SYS_ADMIN`, no privileged flag, no change to Docker's seccomp profile. The harness
runs as uid 1000 and could not `chroot` or `unshare`; it can Landlock itself.

## Requirements

| ID | Requirement |
|---|---|
| FR-5 | Every shell command runs inside a Landlock domain. No configuration disables it. |
| FR-6 | `/proc` is denied, closing F-4. |
| FR-7 | The workspace is fully usable — create, read, edit, rename, delete. |
| FR-8 | Landlock unavailable is a **boot** failure, not a per-turn one. |
| FR-9 | A credential may be written `enc://…`; a plain value still works. |
| FR-10 | Resolving `enc://` requires **two factors of different kinds** — one environment, one file. |
| FR-11 | The key file is unreachable from the agent. |
| FR-12 | A failed decryption is a boot failure naming what to fix. |

## AC

- **AC-5** — `cat /proc/1/environ` from a command returns permission denied.
- **AC-6** — `cat $(echo <base64 path> | base64 -d)` fails too: the mechanism is not a
  string check.
- **AC-7** — Re-invoking the sandbox helper with root `/` does not widen the domain.
- **AC-8** — `echo > a.txt`, `mkdir`, `mv`, `rm` all work in the workspace.
- **AC-9** — Sealing the same plaintext twice yields different ciphertext.
- **AC-10** — Either factor alone decrypts nothing.
- **AC-11** — The agent can reach neither factor.

## Why not picoclaw's mechanism, restated now that both exist

picoclaw's `restrict_to_workspace` is tool-layer path validation. Its own documentation:

> "There's no indication of kernel-level isolation (chroot, namespaces, seccomp,
> landlock) — the sandbox relies entirely on application-level validation within
> PicoClaw itself."

and its `exec` tool is additionally guarded by *"41 dangerous command patterns"* as
regexes. For tools that take a path argument, that is reasonable. For
`/bin/sh -c <arbitrary string>` it is not: `$(echo L2V0Yw== | base64 -d)` is `/etc`.

**What ganglion now runs is stronger than the mechanism it was asked to reach parity
with.** Recorded plainly so nobody later reads "ganglion has no `restrict_to_workspace`"
and adds the weaker check beside the stronger one.

## Evidence — Phase 2

All of it in the real image, with the harness as PID 1.

| Claim | Result |
|---|---|
| Landlock is available in this container | ABI 8; harness logs `sandbox: landlock ABI 8` at boot |
| `/proc/1/environ` before | `GANGLION_API_KEY=sk-secret-pid1` |
| `/proc/1/environ` through the sandbox | `Permission denied` |
| A volume outside the workspace | `Permission denied` |
| The same path, base64-obfuscated | `Permission denied` — no string was inspected |
| Re-invoking the helper with root `/` | still `Permission denied`; Landlock domains only narrow |
| The workspace | write, `mkdir`, `mv`, read, `rm` all succeed |
| `/dev/null` and a system binary | work |
| enc:// with both factors | boots |
| enc:// with the passphrase only | `read the credential key file …: no such file or directory` |
| enc:// with the key file and a wrong passphrase | `did not decrypt: wrong passphrase, wrong key file, or the value was altered` |
| The agent going after factor 1 | `/data/.ganglion/credential.key` → `Permission denied` |
| The agent going after factor 2 | `/proc/1/environ` → `Permission denied` |
| The agent going after the plaintext in memory | `/proc/1/maps` → `Permission denied` |

## What the sandbox does NOT protect

**The transcript.** `sessions/*.jsonl`, `windows/` and the scale-to-zero sidecar all live
under `workspace/`, so a command has full write access to them and can still defeat the
append-only invariant. That was true in Phase 1, it is picoclaw parity, and it stays
scoped out — but "restricted to the workspace" invites the opposite assumption, so it is
stated here. Protecting the transcript would mean moving it out of the workspace, which
is a different feature with a reader on the other side of it.

## Two things this does NOT do

**Encryption does not hide the key from the harness.** The process presents it to the
provider, so it holds plaintext in memory for as long as it runs. What encryption
protects is the credential *at rest* — dokploy's environment editor, `deploy/*/.env`,
`docker inspect`, backups of any of them. What keeps it from the **agent** is the scrub
and the Landlock domain, not the cipher.

**One factor is not encryption.** A passphrase in the environment beside the ciphertext
in the environment is ceremony: one `docker inspect` yields both. The key file exists to
be a different *kind* of thing, and it is bound outside the workspace so the agent cannot
turn it back into one.

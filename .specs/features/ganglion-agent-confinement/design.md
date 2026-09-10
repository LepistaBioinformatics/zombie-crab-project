# ganglion-agent-confinement — Design (Phase 2)

**Status:** Implemented. Date: 2026-09-10. Reads `spec.md`.

Phase 1's three changes are described in `spec.md` and need no design. These two do.

## D-1 — how Landlock reaches the child

Landlock restricts the **calling thread** and everything it later forks or execs. The
harness must NOT be restricted: it writes transcripts under a directory the agent may not
reach. So the domain has to be applied between fork and exec, and `os/exec` offers no
hook there.

**Chosen: the binary re-execs itself.**

```
crab-ganglion __sandbox_exec <workspace> /bin/sh -c <the agent's command>
        │
        └─ main() branches on argv[1] BEFORE reading any configuration
           ├─ landlock.ABI()      — fail closed if absent
           ├─ landlock.Restrict() — the domain
           └─ syscall.Exec("/bin/sh", …) — replaces this process entirely
```

Rejected alternatives:

- **`runtime.LockOSThread` + restrict + fork from that thread.** Works in principle, but
  it permanently sacrifices a runtime thread and couples the confinement to Go's
  scheduler internals. A future Go release could move where `forkAndExecInChild` runs.
- **A separate helper binary.** A second artefact to build, ship, version and keep in
  step with the ruleset. The re-exec is the same bytes by construction.

### Why an argv-reachable mode is not a hole

The sandboxed shell can execute `/usr/local/bin/crab-ganglion` — `/usr` is in the
ruleset. So an agent can invoke the helper itself, with any root it likes.

**Landlock domains only ever narrow.** A thread already inside a domain that restricts
itself again gets the *intersection*, never a replacement. Tested, not assumed: re-running
the helper with root `/` from inside the sandbox still cannot read a file the first domain
denied.

That property is what makes the design safe, so it is asserted by
`TestReinvokingTheSandboxCannotWidenIt` rather than left as a comment.

## D-2 — the ruleset

| Hierarchy | Access | Why |
|---|---|---|
| the workspace | everything the ABI offers | it must behave like an ordinary filesystem |
| `/usr` `/bin` `/sbin` `/lib` `/etc` | read + execute | run `grep`, read a library; never write |
| `/dev` | read + write | `> /dev/null`, `/dev/urandom` |
| **everything else** | denied | `/proc` above all |

`/proc` is the one that matters and the one that would have been forgotten: it is not a
place anybody thinks of as a secret store, and `/proc/1/environ` is the whole of F-4.

### `/tmp` is deliberately absent

It was granted at first, and a test caught what that means: granting `/tmp` grants
everything any other process left in `/tmp`. The container's `/tmp` happens to be empty,
which is precisely the reasoning that ages badly.

Tools that want scratch space get `TMPDIR=<workspace>/.tmp` instead. "Restricted to the
workspace" then means what it says, with no second writable hierarchy to remember.

Two consequences, both checked rather than assumed:

- **No reader sees it.** `internal/history` opens `<workspace>/sessions` and looks up
  files inside it *by name*; nothing in the proxy walks the workspace root. `.tmp` is a
  sibling of `sessions/`, one level above anything that enumerates.
- **It is cleared at boot**, beside the partial recovery. Nothing else removes what a
  command leaves there, and the volume survives scale-to-zero — so without this it grows
  for the life of the agent. Boot rather than per-turn: a scale-to-zero agent boots
  often, and a running one keeping its scratch for the length of a session is what a
  `/tmp` does anyway.

### ABI negotiation

Access-right bits and the attribute struct size both grew across ABI versions 1–6.
Requesting a bit the kernel does not know fails the whole `create_ruleset` with `EINVAL`,
which would read as *"Landlock is missing"* on a kernel that has it. So the mask and the
struct size are both derived from the version the kernel reports.

Zero dependencies: three syscalls in the architecture-independent range (444–446), raw,
no `golang.org/x/sys`.

## D-3 — failing closed, at boot

"No option" means there is no setting that disables the sandbox. That makes an
unavailable Landlock a deployment that must not serve turns.

**Checked in `main`, not at the first tool call.** This stack has repeatedly paid for the
other choice — a persona path pointing at nothing, three unset variables — each surfacing
mid-conversation as behaviour nobody could attribute. The harness now logs
`sandbox: landlock ABI 8` at startup, or exits naming the cause.

The composition root is also the only place the shell tool is built, and it always sets
`Self`. There is no branch and no configuration reaching it — `TestTheShellToolIsAlwaysSandboxed`
guards that, because every other sandbox test builds its own `Tool` and would keep passing.

## D-4 — enc:// , and why two factors of different kinds

```
enc://base64( salt[16] || nonce[12] || AES-256-GCM ciphertext )

fileHash = SHA256(key file)
ikm      = HMAC-SHA256(key: fileHash, message: passphrase)
aesKey   = HKDF-SHA256(ikm, salt, "ganglion-credential-v1", 32)
```

Deliberately the same shape as picoclaw's, so the two harnesses do not need two mental
models. `crypto/hkdf` is in the standard library as of Go 1.24, so this stays
dependency-free.

**The two factors are of different kinds on purpose:**

| Factor | Where | Reached by |
|---|---|---|
| passphrase | `GANGLION_KEY_PASSPHRASE` | reading the environment |
| key file | a read-only bind at `<mountDest>/credential.key` | reading the volume |

Both as environment variables would mean one `docker inspect` yields the plaintext, and
the encryption would be decoration. The key file is bound **beside** the workspace, not
inside it — the workspace is the only hierarchy the Landlock ruleset grants, so the agent
can reach neither factor. `TestTheCredentialKeyFileIsOutOfTheAgentsReach` asserts the
placement, since that is what the whole scheme rests on.

### Resolved at load, fatal on failure

Same reasoning as `GANGLION_BASE_URL`: a wrong passphrase should be a boot failure naming
the variable, not a 401 from the provider on some member's first message. The proxy needs
no decryption at all — an agent's `apiKeyEnv` is an opaque string to it, so ciphertext
travels through unchanged.

### The proxy side

Two additions, and a third drift case:

- `CRAB_GANGLION_KEY_PASSPHRASE` — environment only, never `config.yaml`, which is in git.
- `ganglionKeyFile` — a host path; empty means encryption is not in use and nothing is
  bound or forwarded.
- `ganglionBindDrift` gains the key file, so switching encryption on reaches members
  already on the harness instead of leaving them booting against a value they cannot
  resolve.

## What is still true from Phase 1

The container is still the outer boundary and the narrowed bind still matters: Landlock
confines the *shell tool*, not the harness, and the harness is what must not have the
proxy's state within reach. The two controls are layered, not alternatives.

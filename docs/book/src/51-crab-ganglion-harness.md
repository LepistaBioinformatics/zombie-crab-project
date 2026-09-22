# crab-ganglion-harness

The ganglion is the agent runtime this project wrote for itself, and the harness
this book teaches. This page describes it as a component: what runs inside an
agent container, what that program is allowed to do, and how the repository is
organised.

## What it is

A *harness* is the program that runs inside a member's agent container. It holds
the conversation, calls the model, runs whatever tools the model asks for, and
writes the transcript to disk. `crab-shell-proxy` starts one such container per
member and speaks to it; what happens inside is the harness's business.

`crab-ganglion-harness` is that program, written in Go. Its `go.mod` declares
the module, a Go version, and nothing else: the harness has no third-party
dependencies at all, and the whole thing compiles to one static binary. It
serves HTTP with Server-Sent Events natively, so the proxy's runner for it needs
no protocol translation — `internal/ganglion/turn.go` in the proxy notes that
this is why it has no analogue of the 500-millisecond guess that picoclaw's
runner needs to tell when a turn has ended.

> The other harness is picoclaw, a third-party project this stack started on. It
> is still fully supported and it is on its way out: an agent that declares no
> `harness:` key now gets this one, not that one. [Harnesses](./11-harnesses.md)
> covers the comparison; write `harness: "ganglion"` explicitly in every agent you
> create rather than leaning on the default.

## What it is responsible for

**Serving one turn per request.** The HTTP surface is two routes and no more:
`POST /v1/chat/completions` runs a turn, and `GET /health` answers `{"status":"ok"}`
for the proxy's health check. The turn ends when the handler returns.

**Streaming the work while it happens.** As the agent uses its tools, narration
and reasoning arrive on a progress channel. The answer is different: a frame is
buffered and classified once it is complete, then sent in one piece. The reason
is written down in the specification, because it looks like a regression if you
do not know it. Whether an iteration's text is narration or the final answer
depends on how the frame ends, and that is not knowable before the stream
finishes — the proxy measured seven turns out of a hundred and twelve delivering
a whole reply in the same frame that carried a trailing tool call. Emitting
optimistically and correcting afterwards would make the reply visibly rewrite
itself.

**Bounding a turn.** The only limit on a single turn is how many times it may go
back for another tool. A turn that reaches the cap stops and says so rather than
failing silently. Two places set it and the first wins:
`agents.defaults.max_tool_iterations` in the mounted `config.json`, which is the
surface an administrator actually has, and `GANGLION_MAX_ITERATIONS` on the
container, which defaults to 12. The harness prints the number in force *and*
where it came from at boot, because `12` looks identical whether an operator set
it, the file set it, or nothing did.

**Running tools, confined.** The tool that matters is `shell`. Before running a
command, the binary re-executes itself in a sandbox mode, applies a Landlock
domain, and only then executes the command. The workspace is read-write; `/usr`,
`/bin` and `/sbin` are read-execute; everything else, `/proc` included, is
denied — which is what stops a command from reading `/proc/1/environ` and with
it the harness's own provider key. If the kernel cannot provide a Landlock
domain, the harness refuses to boot rather than serving turns unconfined.

Other tools are registered only when the configuration supports them:
`load_image` and `set_reasoning_depth` are always present, `web_search` and
`web_fetch` appear when a search provider is configured, `generate_image` when
an image model is, and `subagents` and `research` when sub-turns are enabled.
Anything an operator mounted over MCP is added on top. Each boot log line says
which of these were switched on.

**Persisting the conversation.** The transcript is append-only JSONL under
`workspace/sessions`, and the context window is a separate derived artifact. A
conversation that has a transcript and no window — the state every conversation
migrated from picoclaw arrives in — has its window rebuilt from the transcript,
so the member does not see their history on screen while the agent answers as
though the conversation had just begun. A rebuilt window says how much of the
transcript it left behind, rather than starting mid-conversation with nothing
marking the cut.

**Shortening the window without losing anything.** The window holds only the
most recent messages — a fixed count, not yet a configuration key — and
everything it drops is still in the transcript, except for one thing that never
reached it. A **tool result** is written to the window and nowhere else, because
the member never saw it, so the window used to be its only copy: dropping it
destroyed the bytes rather than merely shortening the context. And it is the
largest thing there — one `sh` result can be 64 KiB, which the budget counts as
a single message.

So a large result is **parked** on the way in: the whole output goes to a file
under the turn's own workspace and the message keeps its first and last lines,
its size and the path. The agent can read the rest back with the shell whenever
it wants it. Once the result is a few iterations old, compaction replaces even
the excerpt with the path alone — recent tool output is context, old tool output
is a filename. Nothing here calls a model.

A turn that dropped messages records that it did, once, as an entry the member
sees as a divider in the transcript and the model never sees at all. The count
and the note ride in it; what the member scrolls through is untouched.

**Reading back what left the window.** The agent is told how many messages are
missing — that note is delivered as a system message — and `search_history` is
how it goes and reads one: a case-insensitive search over the conversation's own
transcript, capped, quoting each match in its surroundings and saying how far
back it sits. Nothing is summarized and no second model is called; the cost of
compaction moves to the turns that actually reach back, rather than being paid
on every turn that does not.

Parked outputs are the one thing here that is swept. A conversation keeps its
most recent ones and older files are deleted — far more than a window can hold
pointers to, so nothing the agent might still follow is removed. It is the only
place this harness deletes what it wrote, and it is deliberate: a transcript
entry is the member's and may never be shortened, while a parked result is the
agent's scratch.

**Keeping the layout the stack expects.** Everything lives under the `workspace`
segment, because that is where the proxy looks from outside the container. A
project's files go in `workspace-<id>`, a sibling of `workspace/`, never a child
of it; the harness migrates a subtree left at the old path on boot. See
[Agents, workspaces and projects](./12-agents-and-workspaces.md).

## What it is not responsible for

It does not start, stop or provision anything, including itself. Container
lifecycle, volumes and their ownership, secrets materialization, mycelium
identity and authorization, the model registry, the admin API, projects and
scheduled tasks all stay in
[crab-shell-proxy](./50-crab-shell-proxy.md). The harness specification lists
this as permanently out of scope.

It does not decide who may approve a gated action. The harness has the
`Approver` port and the mid-turn suspension behind it, and its adapter calls
back to the proxy, which owns member identity — the harness only asks.

That round trip is complete now: the proxy answers at `/v1/approvals`, the member
answers from the chat client, and the turn stays suspended until they do or until
the harness gives up waiting. With `GANGLION_APPROVAL_ENDPOINT` unset the loop
still installs an allow-all approver, which is what a deployment that cannot mint
the scoped token falls back to — so the flag is what switches the gate on, not
whether the other half exists. See
[Scheduled tasks](./22-scheduled-tasks.md), the first feature to use it.

It has **no `.secrets/` directory**. Credentials reach this harness as
environment variables. A value that must not sit in plaintext can be encrypted
first — `crab-ganglion encrypt` reads the plaintext on stdin, never as an
argument, and prints the `enc://` value to paste into the deployment's
environment.

## How it is built and tested

This is the only one of the four repositories with a pull-request gate that runs
the test suite. `.github/workflows/ci.yml` runs, on every pull request and every
push to `main`:

```
gofmt -l . | tee /dev/stderr | (! read)
go vet ./...
go test -race ./...
go build ./...
```

`-race` is deliberate rather than habitual: the SSE writer has two writers by
construction, the turn and the heartbeat, and interleaved output would corrupt a
frame the client is in the middle of parsing.

The same tests run a second time inside the Dockerfile, before the binary is
linked, so the image cannot be built without them passing. `release.yml` builds
with the layer cache switched off for exactly that reason — replaying the tests
from a cache would make a green run stop being evidence that they ran for these
bytes.

The runtime image is Alpine rather than distroless, and the Dockerfile explains
that this was found by running it: distroless has no `/bin/sh`, so the shell
tool could never succeed. The container runs as uid 1000, which matches what the
proxy chowns each member's volume to, and listens on port 18800.

> **Every published image is addressed by the commit that produced it.** There
> is no `:latest` and no `:main`; `release.yml` publishes
> `ghcr.io/lepistabioinformatics/crab-ganglion:sha-<commit>` and nothing that is
> ever rebuilt. That is this stack's own scar: the proxy's `EnsureImage` returns
> early when a name resolves locally, and the harness image is not a compose
> service, so a rebuilt tag can leave a host running old bytes indefinitely with
> nothing in the logs. It happened once, for three weeks.

The consequence for a deployment is that the image reference is a decision
somebody makes. `docker-compose.prod.yaml` sets no `CRAB_GANGLION_IMAGE` and
supplies no default, so a production deployment has to name a digest or a
`sha-` tag explicitly before a ganglion agent can start. The development compose
file takes the other route: a build-only `ganglion-image` service builds the
harness from the submodule and tags it `zombie-crab/crab-ganglion:dev`, and the
proxy waits for it. Because that build runs the harness's own test suite, a
failing test stops the development stack from coming up. See
[Deployment](./40-deployment.md).

## How the code is laid out

The repository is hexagonal, and the shape is enforced by tests rather than by
convention.

```
cmd/crab-ganglion/main.go   the composition root: the only place adapters meet
internal/domain/            entities, the ports, pure policy — standard library only
internal/runtime/           the turn loop, compaction, sub-agents
internal/config/            environment and the mounted config.json
internal/adapter/           one directory per adapter
internal/secret/            the enc:// resolver
internal/skillfile/         reading skill files
```

`internal/domain/arch_test.go` holds two rules. The first fails if the domain
package imports anything outside the standard library, because the moment the
domain imports an HTTP client or a provider SDK the loop stops being testable
without them. The second fails if one adapter imports another, which is what keeps a second provider or a second ingress a new file
rather than a refactor.

The adapters are grouped by what they drive: `httpsse` is the way in;
`provider/openai` and `provider/router` are the way out to a model;
`store/jsonl` and `store/window` are the transcript and the derived context;
`tool/*` is one directory per tool; `approver/proxy`, `telemetry/otlp`,
`mcp`, `skills` and `evolution` are the rest. Adding a tool is a file plus a
registration line in `main.go` — not a change to the loop, the port or the
registry.

The specification for all of this lives in the product repository, at
`.specs/features/crab-ganglion-harness/`, along with the design notes and the
requirement identifiers that the code comments cite.

## Where to go next

[Harnesses](./11-harnesses.md) compares the two runtimes and explains what the
proxy does when a feature is not available on one of them.
[Configuration](./03-configuration.md) covers the environment this container
reads. [Working on the stack](./60-development.md) has the commands.

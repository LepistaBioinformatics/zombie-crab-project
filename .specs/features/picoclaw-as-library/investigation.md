# picoclaw-as-library — Feasibility Investigation

**Status:** Investigation (pre-spec). No implementation, no commitment.
**Date:** 2026-08-12. **picoclaw analysed:** `v0.3.1` (the tag this stack pins), MIT.

**Question, as asked:** the stack runs picoclaw as the harness, and reaching it required a
proxy that translates WebSocket into REST. Can that REST layer instead be implemented *by
extending picoclaw* — so that zombie-crab carries only extension code, with picoclaw consumed
as a library?

**Verdict:** **Yes for the turn surface, no for the rest of the proxy — and the split is not
close.** picoclaw ships a public, tested, out-of-tree channel extension API; a REST channel
compiled against `picoclaw/pkg` is a supported use of it, not a fork. But that touches roughly
**400 lines deleted outright plus a few hundred rewritten, out of 23,422** (§0 breaks this into
two numbers). The remainder is not protocol translation — it is the orchestration of picoclaw
*from outside*, for which no seam exists or could exist, because picoclaw is the thing being
orchestrated.

One qualification on "feasible", resolved in §3 rather than deferred: picoclaw serializes turns
**per session key** and caps parallel turns at `agents.defaults.max_parallel_turns`, **default
1**. That is a deployment knob, not a design blocker — but a REST surface inherits it, and a
second request for a conversation already mid-turn is folded into that turn as a *steering
message*, not answered separately.

The migration is still worth considering, for a reason that has nothing to do with line count:
it **removes a timing heuristic from the turn boundary**. See §5.

---

## 0. The framing correction that matters most

The request describes `crab-shell-proxy` as "a proxy that translates websocket to REST". That is
an accurate description of `internal/pico` — and `internal/pico` is 404 lines out of 23,422.

Non-test Go under `internal/` + `cmd/`, measured at `8845230`:

| Package | LOC | Moves into picoclaw? |
|---|---:|---|
| `internal/docker` | 8,932 | **No** — container lifecycle, scale-to-zero, volumes, provisioning |
| `internal/httpapi` | 6,827 | **Partly** — turn endpoints yes; `/alpha/v1/admin/...` no |
| `internal/registry` | 2,126 | **No** — model inventory across users/agents |
| `internal/memgraph` | 1,423 | **No** |
| `internal/config` | 810 | **No** — proxy's own config |
| `internal/history` | 738 | **No** — see §6.2 |
| `internal/mcpserver` | 574 | **No** |
| `internal/restart` | 424 | **No** |
| **`internal/pico`** | **404** | **Yes — this is the whole of it** |
| `internal/projects` | 307 | **No** |
| `internal/identity` | 193 | **No** — mycelium profile → account id |
| `internal/mcptoken` | 177 | **No** |
| `internal/cron` | 166 | **No** |
| `internal/turn` | 105 | Stays as the seam (§7) |
| `internal/authz` | 90 | **No** |
| `cmd/crab-shell-proxy` | ~126 | **No** |
| **Total** | **23,422** | |

**Two numbers, not one.** `internal/pico` is what gets **deleted outright**: 404 LOC, 1.7%. The
`internal/httpapi` row is deliberately "Partly", and that part was measured rather than waved at —
the turn-serving files are `handlers.go` (1,465, *mixed*: it also registers every admin route),
`sse.go` (196), `attachments.go` (113) and `turn_registry.go` (103). Call it **~400–900 LOC
rewritten** rather than deleted: the OpenAI request/response shaping and the SSE writer either
move into the channel or are re-pointed at the new runner, while `handlers.go`'s routing table and
`turn_registry.go` (which correlates memory-graph writes to conversations — a proxy-side concern)
stay. So: **~404 deleted, ~400–900 rewritten, of 23,422.** The 1.7% figure is the deletion, and
should not be quoted as the whole change.

The distinction that produces this table: **the turn surface can move into picoclaw; the control
plane cannot.** A container's own agent has no business starting, stopping, or provisioning
containers — including its own — and no picoclaw seam offers it. `README.md`'s central claim
("one real container per user") lives entirely in the "No" rows.

**"Only extension code in zombie-crab" is therefore not reachable.** What *is* reachable is
"zombie-crab's harness-facing code becomes extension code" — a real and defensible goal, just a
much smaller one than the phrasing suggests.

---

## 1. The topology this document assumes (decided, 2026-08-12)

Two readings of "picoclaw as a lib" were on the table. The requester chose **A**.

**A — in-container extension (chosen).** A new Go module imports `picoclaw/pkg`, registers a
REST channel out-of-tree, and builds a binary that **replaces the stock picoclaw binary as the
per-user image**. The proxy keeps every orchestration responsibility and drops `internal/pico`.

```
Client ──REST──▶ crab-shell-proxy ──REST──▶ crab-picoclaw   (1 container per user)
                  docker lifecycle,          = picoclaw/pkg + crab REST channel,
                  registry, admin, authz       compiled into one binary
```

The isolation model is untouched: same container per `(agent, user)`, same volume, same non-root
uid. Only the wire between proxy and container changes, and what speaks the far end of it.

**B — single-process embed (rejected).** picoclaw imported into `crab-shell-proxy` itself, one
process serving every user, separated by `agents.dispatch` on chat id. This is technically
reachable — the dispatch glob patch already routes families of chats to agents — which is exactly
why it needs rejecting out loud rather than by silence. It is the "one shared process for
everybody, separated by a key in a map" model that `crab-shell-proxy/README.md` rejects in terms
it does not hedge: *"It looks isolated. It isn't… a data breach waiting for a bad day."* Adopting
B reverses the project's stated security posture. Secondary, but real: `gateway.Run` installs
signal handlers, writes a PID file, and takes over the global logger — it expects to *be* the
process, and would fight the proxy's own `main`.

Everything below assumes A.

---

## 2. The extension API is real, public, and tested

This is the load-bearing finding. picoclaw does not merely *permit* out-of-tree channels by
accident of package layout — it has a documented hook, with a test that names the use case.

**2.1 Registering a new channel type** — `pkg/config/config_channel.go:691`:

```go
func RegisterChannelSettings(channelType string, prototype any)
```

`pkg/config/register_channel_settings_test.go` covers it, and its comment is explicit:

> verifies the public registration hook makes a previously-unknown channel type valid and
> decodable — **the behavior out-of-tree channels rely on (they call RegisterChannelSettings
> from init())**.

The second test drives the full path — a config carrying an unknown type passes
`InitChannelList` and `GetDecoded()` returns the out-of-tree settings struct. Without this the
whole idea would be dead: channel types would be a closed enum and any `crab_rest` block in
`config.json` would fail validation as "unknown type".

**2.2 Registering the implementation** — `pkg/channels/registry.go`:

```go
func RegisterFactory(name string, f ChannelFactory)
func RegisterSafeFactory[S any](channelType string, ctor func(*config.Channel, *S, *bus.MessageBus) (channels.Channel, error))
```

Both public. `RegisterSafeFactory` is the ergonomic form and its doc comment shows the `init()`
pattern.

**2.3 Serving HTTP from a channel** — `pkg/channels/webhook.go`:

```go
type WebhookHandler interface {
    WebhookPath() string
    http.Handler
}
```

> Manager discovers channels implementing this interface and registers them on the shared HTTP
> server.

Mounted at `pkg/channels/manager.go:1137`. **This is how a REST channel gets routes** — it does
not need its own listener or port; it mounts `/v1/...` on the gateway's existing server, exactly
as the pico channel mounts `/pico/`. `channels.HealthChecker` (`HealthPath` + `HealthHandler`)
is available the same way.

**2.4 Running the whole thing** — `pkg/gateway/gateway.go`:

```go
func Run(debug bool, homePath, configPath string, allowEmptyStartup bool) (runErr error)
```

Public, and it blank-imports every in-tree channel. An out-of-tree `main` is therefore roughly:

```go
import (
    _ "github.com/LepistaBioinformatics/crab-picoclaw/channel"  // ours; init() registers
    "github.com/sipeed/picoclaw/pkg/gateway"
)
func main() { gateway.Run(debug, home, cfgPath, allowEmpty) }
```

`cmd/picoclaw/internal/gateway/command.go` — upstream's own caller — is 91 lines of Cobra
plumbing around this single call. The CLI surface under `cmd/picoclaw/internal/` is *not*
importable (Go's `internal` rule), but nothing worth having lives there: the runtime is all in
`pkg/`.

**2.5 Inbound and outbound** — verified against the pico channel:

- Inbound: the channel builds `bus.InboundContext{Channel, ChatID, ChatType, SenderID,
  MessageID, Raw}` and calls `BaseChannel.HandleInboundContext(...)`. `ChatID` is a free-form
  string the channel picks (`pico.go:1195` uses `"pico:" + sessionID`), so a REST channel can key
  it on whatever conversation id the request carries.
- Outbound: the Manager calls `Send(ctx, bus.OutboundMessage)` on the channel named in
  `OutboundMessage.Channel`, addressed by `ChatID`. Media arrives separately via
  `SendMedia(ctx, bus.OutboundMediaMessage)`.
- Streaming: `StreamingCapable.BeginStream(ctx, chatID) (bus.Streamer, error)`, where
  `Streamer` is `{Update, Finalize, Cancel}`. The pico channel implements it
  (`pico.go:514`), so the path is exercised in production today.

**Conclusion of §2:** a `crab` REST channel is a supported extension. Confidence: high — every
symbol above was read in `v0.3.1`, not inferred.

---

## 3. What the REST channel would have to do

A sketch, to size the work rather than to design it:

| Concern | Mechanism |
|---|---|
| Routes | `WebhookPath()` returning `/v1/`, `ServeHTTP` dispatching `chat/completions`, `models`, `sessions/history` |
| Auth | Bearer check in `ServeHTTP`; token from the registered settings struct (same shape as `PicoSettings`' token) |
| Request → agent | build `InboundContext` with `ChatID` derived from the request's conversation id, call `HandleInboundContext` |
| Agent → response | per-`ChatID` pending-request table; `Send`/`BeginStream` resolve against it |
| Streaming | `BeginStream` returns a `Streamer` writing SSE chunks to the held `http.ResponseWriter`; `Finalize` closes the stream |
| Progress (thoughts, tool calls) | today inferred from `kind` on the wire; in-process these are distinct calls, so they map to SSE events without string sniffing |
| Attachments | `SendMedia` → SSE event carrying the media ref, resolved against the gateway's own media route |

### 3.1 Concurrency and cancellation — resolved, with one behavioural catch

This was the item that could have downgraded the verdict, so it was read rather than deferred.
`pkg/agent/agent.go:180–245` is explicit:

- **Turns are serialized per session key, concurrent across session keys.** The inbound loop
  claims `sessionKey` in `activeTurnStates` via `LoadOrStore` with a placeholder sentinel (the
  comment names the TOCTOU race it closes), then spawns a worker goroutine.
- **Total parallel turns are capped by a semaphore**, `workerSem`, sized from
  `cfg.Agents.Defaults.MaxParallelTurns` — **defaulting to 1** when unset
  (`pkg/agent/agent_init.go:61-75`). A REST channel inherits this. It is a config knob, but a
  deployment that leaves it at the default gets one turn at a time *for the whole agent*,
  regardless of how many conversations are open.
- **A second message for an already-active session is not a second turn.** It is enqueued as a
  **steering message** folded into the running turn (`enqueueSteeringMessage`, consumed at
  `turn_coord.go:115`). For an OpenAI-compatible endpoint this is the catch: two concurrent
  `POST /v1/chat/completions` for the same conversation cannot both be answered as independent
  completions. The channel must reject, queue, or explicitly document the merge.
- **Stop exists**: `tryHandleStopCommand` / `takePendingStop` (`pkg/agent/agent_stop.go`), keyed
  on session — the hook a client-disconnect reaper would use.

**Consequence for the design in the table above:** holding an `http.ResponseWriter` open per
in-flight `ChatID` is sound, because distinct conversations *are* distinct session keys and do run
concurrently. The proxy's own `internal/httpapi/turn_registry.go` already documents the same
property from the outside — *"Nothing serializes turns per workspace. Two tabs on two
conversations of the same agent are concurrent."* The two accounts agree.

**Still unexamined:** whether a mid-turn client disconnect cleanly reaps the pending entry without
wedging the agent. The `takePendingStop` machinery is clearly the right lever; it was not traced
end to end.

---

## 4. What stays in `crab-shell-proxy`, permanently

Not a matter of effort — there is no seam, because these are things done *to* a container:

- **`internal/docker`** — ensure/stop per-`(tenant, subscription, agent, user)` containers, idle
  scale-to-zero, volume provisioning + chown, secrets, skills, persona, model migration.
- **`internal/identity` + `internal/authz`** — mycelium profile → account id. The unforgeable key
  the whole isolation claim rests on is injected by the gateway *in front of* the proxy.
- **`internal/registry`** — model inventory and resolution across users and agents.
- **`internal/httpapi`'s admin half** — `/alpha/v1/admin/...`, ~6.8k LOC of which only the turn
  endpoints are in scope.
- **`internal/memgraph`, `internal/projects`, `internal/cron`, `internal/mcpserver`,
  `internal/restart`.**

Per the monorepo `CLAUDE.md`, these are the proxy's own REST API and stay REST regardless.

---

## 5. The actual argument for doing this

Not line count. **The turn boundary stops being a guess.**

`internal/pico/turn.go`'s own header documents what it is:

> a direct port of `picoclaw-openai-proxy/server.js`'s runTurn, including its **empirically-tuned
> completion logic**: picoclaw wraps EVERY outbound message (including inter-iteration
> "tool_calls" indicators) in its own typing.start/typing.stop pair, so typing.stop alone never
> means "turn over". We only finalize once real (non-thought / non-tool_calls) content has
> arrived AND typing has stopped, after a short grace window; any new typing.start cancels a
> pending finalize.

`const graceWindow = 500 * time.Millisecond`.

That is a race, tuned rather than solved: a turn whose next tool call starts >500 ms after the
previous one stops typing gets finalised early. In-process, the same event is a **method call** —
`Streamer.Finalize(ctx, content)` — delivered by the Manager at the exact moment the turn ends.
No window, no cancellation dance, no `kind`-string sniffing to tell narration from answer.

Secondary gains, smaller but real:

- **One less protocol hop.** Today: OpenAI JSON → Pico frames → WS → agent, and back. After:
  OpenAI JSON → agent.
- **Upstream drift becomes a compile error.** Today the pico protocol is mirrored in hand-written
  structs (`internal/pico.Frame`, `Payload`, `Attachment`, `ToolCall`); a field rename upstream is
  discovered in production. Compiled against `picoclaw/pkg`, it is discovered by `go build`.
- **The patches get a better home.** See §6.1.

---

## 6. Two residuals "extension only" cannot absorb

### 6.1 The local patches

`deploy/picoclaw-glob/` carries two patches applied via `git apply` in a Dockerfile against a
pinned tag. **Neither is reachable from an extension point** — verified:

| Patch | Touches | Exported hook? |
|---|---|---|
| `dispatch-selector-glob.patch` | `ruleMatchesView` (unexported) in `pkg/routing/route.go`; adds `selectorMatches`/`globMatch` | **None.** `pkg/routing` exports only `NewRouteResolver` and `ResolveRoute` — no matcher injection. |
| `vision-unsupported-glm.patch` | `isVisionUnsupportedError` (unexported) `pkg/agent/llm_media.go:37`, called at `pipeline_llm.go:282` and `turn_coord.go:565` | **None.** No error-classifier registration. |

So "zombie-crab holds only extension code" is false while these exist, whichever topology wins.
Three options, and the migration makes the middle one materially better than today:

1. **Upstream them.** Both were written to be upstreamable (tests + docs, no zombie-crab
   content). Best outcome, not under this project's control.
2. **`replace` directive to a thin fork.** Once crab owns the build, `go.mod`'s `replace` points
   `github.com/sipeed/picoclaw` at a fork carrying the two commits. This is *strictly better than
   the status quo*: version resolution and drift detection move into Go's tooling, where an
   upstream bump is a normal merge, instead of `git apply --verbose` failing inside a Docker
   layer. The Dockerfile's own comment concedes the current mechanism is a tripwire, not a
   solution.
3. **Keep the overlay.** Works, but a patched clone and a Go module dependency on the *same*
   upstream would have to be kept at the same tag by hand — the worst of both.

Recommendation if this proceeds: **(2)**, with (1) attempted in parallel.

### 6.2 Session durability

picoclaw's sessions are **in-memory SQLite and reset on restart** — the reason `continuous` mode
exists, and the reason `internal/history` maintains a proxy-side append-only
`durable/<sessionKey>.jsonl` that folds forward live transcripts so a scale-to-zero cycle cannot
erase them.

This is a property of picoclaw's **agent core**, not of its transport. Moving REST inside does not
touch it. `internal/history` (738 LOC) stays exactly as it is. Worth stating plainly because
"picoclaw as a library" can sound like it fixes persistence, and it does not.

---

## 7. Migration path, if this proceeds

The proxy already has the right seam, which is why this can be incremental rather than a cutover.
`internal/turn` defines a harness-neutral `Request`/`Sink`, and `internal/httpapi/handlers.go:231`
consumes it through one interface:

```go
// Turner runs one conversational turn (satisfied by *pico.Client).
type Turner interface { ... }
```

A REST runner is a **drop-in second implementation of `Turner`**. Sketch:

1. New repo/module `crab-picoclaw` (or a directory in this monorepo): channel + `main`, importing
   `picoclaw/pkg`. Build produces the per-user image.
2. New `internal/restturn` in the proxy implementing `Turner` against it. `internal/pico` stays
   live and untouched throughout.
3. `internal/docker.Manager.endpoint()` (`manager.go:166`, currently hardcoding
   `ws://%s:%d/pico/ws`) grows a harness-conditional scheme. `Target.Harness` already exists.
4. Instance config (`internal/docker/instance_config.go`) writes the `crab_rest` channel block
   into `config.json` alongside — or instead of — `pico`.
5. Flip one agent to the new image; compare. **Delete `internal/pico` only after that.**

Both runners can coexist behind `Agent.harness`, which is the same seam the withdrawn Hermes work
left dormant (`.specs/features/hermes-removal/DECISION.md`, OD-1 Option A). This proposal is a
second, much cheaper user of that seam — the runtime is the same picoclaw, so none of the reasons
Hermes was withdrawn (heavyweight image, 180 s startup, turns near the 60 s `gatewayTimeout`)
apply.

---

## 8. Sizing — low confidence, stated as a range

No implementation was attempted, so treat these as orders of magnitude:

| Piece | Rough size | Confidence |
|---|---|---|
| REST channel (routes, auth, inbound, `Send`, `BeginStream`/SSE, media) | 600–1,000 LOC + tests | Medium |
| `main` + build + image | ~100 LOC + Dockerfile | High |
| Proxy `Turner` implementation | 200–400 LOC | Medium |
| Proxy plumbing (endpoint scheme, instance config, harness flag) | ~200 LOC across 3 files | Medium |
| Patch relocation to `replace` fork | Small, mostly process | Medium |
| **New code, total** | **~1,100–1,700 LOC** | Medium |
| **Deleted at the end** | `internal/pico`, 404 LOC | High |

**The code does not shrink — it grows and moves.** Roughly 1,100–1,700 new lines against 404
deleted is **2–4× more code**, in a new build artefact this project must own, plus the ~400–900
rewritten in `internal/httpapi` (§0). This is the direct answer to the goal as stated ("only
extension code in zombie-crab"): the extension is *additional* code living in a *new* place, not
a replacement for what exists.

**The return is the removed heuristic and the compile-time coupling (§5), paid for with more
code, not less.** If the actual goal is less code to maintain, this does not deliver it, and that
should be settled before a spec is written.

---

## 9. Open questions for the spec phase

1. Turn concurrency and cancellation in `pkg/channels/manager.go` / `pkg/agent` (§3).
2. Does the OpenAI-compatible surface stay byte-identical across the switch? The webapp and
   mycelium both sit in front of it; any drift is a user-visible regression.
3. Does `/v1/sessions/history` move into the channel, or stay proxy-side reading the volume? §6.2
   argues it stays — the durable fold-forward is a proxy responsibility — but a channel *can* read
   picoclaw's own session store directly, which may be better.
4. Upstream posture: is a PR to sipeed/picoclaw for the two patches in scope, or explicitly not?
5. Image build ownership: does `crab-picoclaw` live in this monorepo as a third submodule, or as a
   directory under `crab/`?

---

## 10. Summary

- **Extending picoclaw with a REST channel is genuinely feasible.** The out-of-tree channel API
  (`RegisterChannelSettings` + `RegisterFactory` + `WebhookHandler`) is public, tested, and
  documented for exactly this. MIT licence, no fork required for the channel itself.
- **It deletes 404 lines (1.7%) and rewrites ~400–900 more.** Everything else orchestrates
  containers from outside and has no picoclaw seam, by construction.
- **"Only extension code in zombie-crab" is not achievable** — not because of the REST layer, but
  because container orchestration, mycelium identity, the model registry, and the admin API are
  the proxy's own product, not picoclaw glue. The two local patches (§6.1) are a second, smaller
  reason: neither is reachable from an extension point.
- **The case for doing it anyway is the turn boundary**: a 500 ms tuned grace window replaced by
  `Streamer.Finalize`, plus upstream drift becoming a compile error.
- **The case against is that it costs more code, not less** — ~1,100–1,700 new against 404
  deleted — and adds a build artefact this project must own.
- **One inherited constraint to plan around:** `max_parallel_turns` defaults to 1, and same-session
  concurrent requests merge as steering rather than answering independently (§3.1).
- **Next step, if approved:** a spec covering §7's migration path and §9's open questions — not
  implementation.

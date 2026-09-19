# ganglion-agent-scheduling — Context

Decisions the project owner made before the specification was written, and the
evidence each was weighed against.

---

## D-1 — The agent gets it, but only after an approver exists

**Asked for:** a way for the agent to create scheduled tasks from inside the chat
environment, and to know about it from the start.

**Chosen:** the agent, sequenced behind `ganglion-approval-endpoint`.

**Why the sequencing is not administrative.** The harm the boundary was built
against is *unobserved persistence*: a fired task delivers to nobody, runs
unattended for up to thirty minutes, and exists specifically to wake a container
that scale-to-zero has stopped. A turn talked into something by injected text and
able to write a schedule buys itself re-entry that outlives the conversation.

The approver answers that shape rather than bounding it. The loop asks
synchronously, emits a heartbeat while waiting, and **denies on timeout** (DEC-4).
An unattended turn has no member watching, so its approval request goes
unanswered and is refused; a member who asked for a task in conversation is right
there to allow it. The dangerous case fails closed by construction.

That property is why approval is a prerequisite and not a mitigation bolted on:
without an endpoint, `Client.Request` short-circuits `Allowed: true, "not gated"`
before it builds a body, and "this tool requires approval" would be a sentence
with no enforcer — the exact failure AD-025 D-2 recorded when it made
`evolution.apply` a boot failure instead.

**Rejected — member-only, through the UI.** It closes the gap the book itself
calls "the honest state of things" and touches no boundary. Still worth doing;
the owner wanted the agent path. Kept out of scope here rather than folded in,
because it needs five gateway blocks to stop being `GET`-only plus a form, and
each half is verifiable alone.

**Rejected — agent now, bounds only.** It would ship the capability and leave the
harm shape reachable, with quotas standing in for a control that does not exist.

## D-2 — FR-B4 stays: a fired task still delivers to nobody

**Chosen:** agent-created tasks behave exactly like member-created ones. Nothing
is delivered into a conversation; the Tasks panel is where a member reads what a
run produced.

**The alternative and why it lost.** Making an agent-created task report back
would attack the same "nobody is watching" problem from the other side, and would
arguably be a better mitigation than any quota. But FR-B4 was an explicit owner
decision on 2026-09-10, and reversing it for one class of task would give the
panel two behaviours distinguished by a field most readers will not know exists.
With approval in front, the visibility argument is answered earlier: a member saw
the task before it existed.

## D-3 — All four missing bounds, because none exists

**Chosen:** a per-workspace task ceiling, a higher minimum interval for
agent-created recurring tasks, a provenance field, and a rate limit on creation.

**What was actually there.** Nothing. The create appends unconditionally and no
code counts `len(jobs)`. The proxy's only rate limiter governs model connectivity
probes. No constraint exists on what a scheduled prompt may contain. The single
lifecycle-aware bound is `MinEveryMs = 60000`, and its stated reason transfers
whole: every fire may cold-start a stopped container, so a short interval is a
request to keep an agent permanently warm by the back door.

**Provenance is the one that makes the others work.** The store records nothing
about who wrote a task, and the write path assumes the member did — *"Trusted
verbatim from the member, refused only for shape."* Without the field, an
agent-authored task is indistinguishable from a member's in the store, in the API
and in the panel; a bound that applies to one author has no author to apply to,
and the panel cannot be honest about what it is showing.

**Deliberately not added: a content filter on the scheduled prompt.** It was
available and was left out. A filter on natural language is a promise that cannot
be kept, and offering one would substitute for the control that actually works.

## D-4 — Tools on the MCP server that already exists

**Chosen:** the proxy's existing MCP server gains three tools. No second server,
no CLI, no new credential.

**Why this is not the shortcut it first appeared to be.** The two authentication
systems are disjoint: `mcptoken.Verify` has exactly one caller, and no cron route
touches it. This is writing a new path, not reusing one. What makes it the right
path is the shape: the token already carries `tenant/subs/role/user[/project]`
under an HMAC verified before the payload is read, and **no tool there takes a
scope parameter** — a caller structurally cannot name another member's workspace.
Container-originated writes over MCP are already how the memory graph works; the
"no write route" note on the REST surface says MCP *is* the write path, not that
container writes are forbidden.

**Rejected — a second, dedicated MCP server.** Cleaner semantically, and it costs
a second hard boot dependency: an unreachable MCP server fails the container's
boot, which would take a member's ordinary conversation down over a scheduling
outage.

**Rejected — a CLI baked into the image.** It fails softly, which is genuinely
better, but it needs a credential path that does not exist. The only one matching
the design is the proxy writing a scoped file into the bind, on the
`credential.key` pattern — and the alternative, adding names to the `exec` tool's
`passThrough` allowlist, is precisely the change that allowlist's own comment
argues against, because anything there is readable by arbitrary model-authored
shell.

A note for whoever reads the `ganglion-mcp-token-indirection` spec looking for a
template: it is marked RECORDED with nothing implemented and no work scheduled.
The shipped precedent for handing a container something scoped is
`credential.key`, not that spec.

---

## The fact that shaped every answer

The mycelium profile header is **decoded, never verified**. The agent bearer token
is the only real gate, and whoever holds one can assert any account id — it is the
gate on chatting *as any member of any tenant*. That is why no container holds
one, and why no design here proposes putting one there. A scoped MCP token is a
different object: it names one workspace, it is verified, and the endpoint accepts
no scope argument that could widen it.

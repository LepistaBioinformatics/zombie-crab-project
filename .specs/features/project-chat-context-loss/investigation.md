# project-chat-context-loss — Investigation

**Status:** Investigation (pre-fix). Root cause identified, no change made.
**Date:** 2026-08-28. **picoclaw analysed:** `v0.3.1` (the tag this stack pins) and
upstream `main` at the same date — the defect is byte-identical in both.

**Reported symptom:** the agent answers one message, and the next message — typically a
short one ("?", "pense melhor", a single digit) — is answered as if the conversation had
just started. Asked how many messages were exchanged, it replies *"esta é a primeira
mensagem que recebo nesta sessão"*. The webapp keeps rendering the full transcript.

**Verdict: this is an upstream picoclaw bug, not a zombie-crab implementation defect.**
picoclaw's default context manager reads a conversation's history from the **default
agent's** session store instead of from the agent the turn was routed to. zombie-crab
contributes only the configuration that exposes it: `agent-projects` gives every project
its own picoclaw agent, and a named agent gets its own workspace — therefore its own
session store. Every conversation inside a project is affected, on **every** turn after
the first. Conversations on the main agent are unaffected *by this defect* — for the
default agent the guess is correct — but that half is deduced from the code, not
observed on today's deployment; see §2's note on the control and §6 step 0.

---

## 1. The defect

`pkg/agent/context_legacy.go:23`:

```go
func (m *legacyContextManager) Assemble(_ context.Context, req *AssembleRequest) (*AssembleResponse, error) {
	agent := m.al.registry.GetDefaultAgent()      // <-- not the routed agent
	if agent == nil {
		return &AssembleResponse{}, nil
	}
	history := agent.Sessions.GetHistory(req.SessionKey)
	summary := agent.Sessions.GetSummary(req.SessionKey)
	...
```

`AssembleRequest` carries **only** `SessionKey`, `Budget` and `MaxTokens`
(`context_manager.go:34`). The interface has no way to say *which agent* — so the
implementation guesses, and guesses `main`.

Three facts turn that guess into total amnesia:

1. **Session stores are per agent, rooted at the agent's workspace.**
   `instance.go:129` — `sessionsDir := filepath.Join(workspace, "sessions")`, then
   `initSessionStore(sessionsDir)` per `AgentInstance`. Two agents with different
   workspaces are two disjoint stores.
2. **Writes go to the routed agent.** `turn_state.go:278` binds `ts.session =
   agent.Sessions` from the agent the router picked, and every message is appended there.
3. **Reads go to `main`.** `pipeline_setup.go:23` is the only source of a turn's
   history, and it calls `ContextManager.Assemble`.

So a project turn writes into `workspace-<project>/sessions/sk_v1_<key>.jsonl` and then
looks that same `sk_v1_<key>` up in `workspace/sessions/`, where it has never existed.
`GetHistory` on an unknown key returns an empty slice — not an error — so the turn
proceeds with a system prompt and one user message, and nothing anywhere logs a problem.

The same `GetDefaultAgent()` appears three more times in the file and makes the rest of
the legacy manager equally agent-blind:

| Line | Function | Consequence for a project conversation |
|---|---|---|
| `context_legacy.go:27` | `Assemble` | **History is always empty.** The reported bug. |
| `context_legacy.go:66` | `Clear` | `/clear` wipes the *main* agent's session under that key, never the project's. |
| `context_legacy.go:78` | `maybeSummarize` | Reads an empty history, so the threshold never trips: project sessions are **never summarized**. |
| `context_legacy.go:116` | `forceCompression` | Same — emergency compression is a no-op there. |

`context_seahorse.go:33` resolves its SQLite path off `GetDefaultAgent()` too, but that
one is benign-to-useful: it yields a single engine keyed by session key, shared by every
agent. See §5, option B.

---

## 2. Evidence — the bug is already recorded on disk

No instrumentation was needed; the live container had captured a clean reproduction.
`crabshell-alpha-e5bc87e15c74fc6c`,
`/data/.picoclaw/workspace-chat-ux/sessions/sk_v1_4f99c46e….jsonl` (22 entries, one
conversation, `meta.json` `count: 22`, one stable `sk_v1_` key throughout):

```
 1 user      13:06:57 | Enriqueça informações sobre bacterias fixadoras de nitrogenio
 …            (15 entries: web_search, web_fetch, memory-graph writes, final answer)
17 user      13:07:51 | ?
18 assistant 13:07:53 | Olá! 👋 Sou a Eva, sua assistente. Como posso ajudar você hoje?
19 user      13:08:19 | Quantas mensagens trocamos nessa sessão?
20 assistant 13:08:22 | … Esta é a primeira mensagem que recebo nesta sessão.
21 user      13:17:19 | ?
22 assistant 13:17:22 | Olá! 👋 Sou a Eva, sua assistente natural. …
```

`sk_v1_acc8478b….jsonl` in the same workspace rules out "the agent only forgets after a
long agentic turn":

```
 1 user  13:01:50 | Qual a melhor hipótese sobre a teoria das cordas
…
11 user  13:03:00 | Qual a que você mais gosta?      -> generic answer, string theory never mentioned
13 user  13:03:32 | Pense sobre                      -> "não tenho contexto do que estamos discutindo"
17 user  13:04:27 | Pense melhor                     -> "não tenho contexto do que estamos discutindo"
```

**Control (same container, default agent), with a caveat that matters:**
`/data/.picoclaw/workspace/sessions/sk_v1_a2da581f….jsonl` opens on the follow-up
*"Pesquise mais fundo"* and the agent answers *"Vou aprofundar a pesquisa sobre
caixões…"* — it carried the topic across turns, and its `meta.json` holds a real
summary, so history and summarization did run there.

The caveat: every file under `workspace/sessions/` is from **Aug 18**, while
`workspace-chat-ux/` was created **Aug 28 13:01**. That control therefore predates the
multi-agent configuration and may well have run when `main` was the only agent — in which
case the default agent *was* the routed agent and the defect could not have fired.
It is consistent with the diagnosis, not independent proof of it. The claim "main chats
still work" rests on the code path (`GetDefaultAgent()` returns the routed agent when the
route is the default one) and is cheap to confirm — §6 step 0.

---

## 3. "Short messages" is a symptom of visibility, not the trigger

Length has nothing to do with it. Every follow-up turn in a project chat is
context-free; a long, self-contained follow-up still gets a usable answer, so the loss is
invisible. A short or anaphoric one ("?", "pense melhor", "1") has no content of its own
to answer from, and the amnesia surfaces immediately. The two transcripts above show the
same loss behind both a one-character message and a full sentence.

---

## 4. Ruled out, with the evidence that ruled it out

| Candidate | Why not |
|---|---|
| Session-key drift between turns | One `sk_v1_` key for all 22 entries; `meta.json` `scope.values.chat` constant, `count` monotonic. |
| Container restart between turns (`internal/history`'s "picoclaw loses earlier turns on a restart") | `docker inspect` — `RestartCount: 0`, `StartedAt` before the whole conversation. |
| The proxy's `graceWindow = 500ms` finalizing early, next POST folded as a **steering message** | Folding produces *no second answer*, not an answer without context. Every user message here got its own reply. |
| `max_parallel_turns` / turn serialization | Would delay a turn, never empty its history. |
| Context compaction / `summarize_message_threshold: 20` | §1: for a project session the summarizer reads the same empty history and never fires. `sk_v1_acc8478b` lost context at message 11, far below any threshold. |
| `tools.filter_min_length: 8` (the one length-sensitive branch in picoclaw) | Redacts secrets in long content; does not touch history. |
| zombie-crab dropping history on the wire | The proxy never sends history — it sends `lastUserContent` only (`handlers.go:668`) and holds no agent-side conversational state. There is nothing there to drop. |

---

## 5. Options

**A and B are mutually exclusive, not complementary.** `resolveContextManager`
(`turn_coord.go:336`) returns exactly one manager — `context_manager.go:13` states it:
*"Exactly ONE ContextManager is active per AgentLoop, selected by config."* Setting
`context_manager: "seahorse"` means `legacyContextManager` is never constructed and
patch A becomes dead code, while seahorse's own agent-blindness (§5B caveats) goes
unfixed. Applying both is strictly worse than applying A alone.

A also recovers conversations that have already lost their memory: the history was
always **written** correctly into the project workspace — the defect is read-only — so
fixing the read makes existing transcripts visible again on the next turn. B starts those
chats from zero, because `bootstrapSession` replays only the default agent's sessions.

### A — Third local patch in `deploy/picoclaw-glob/` (recommended) — **IMPLEMENTED**

Shipped as `deploy/picoclaw-glob/context-routed-agent.patch`, wired into the Dockerfile
after the other two. What it does:

- add `AgentID` to `AssembleRequest` (`context_manager.go:34`) and `CompactRequest`;
- populate it from the routed agent at all eight call sites:
  - `Assemble` — `pipeline_setup.go:23`, `pipeline_setup.go:67`, `pipeline_llm.go:371`,
    `turn_coord.go:397`;
  - `Compact` — `pipeline_setup.go:55`, `pipeline_llm.go:359`, `pipeline_execute.go:836`,
    `pipeline_finalize.go:71`;

`Compact` is not optional. With only `Assemble` fixed, history returns but is never
summarized or compacted — `maybeSummarize` and `forceCompression` keep reading the
default agent's empty store and no-op. The turn still completes, because
`trimHistoryToFitContextWindow` (`pipeline_setup.go`) pares the assembled history down to
the window in memory, but it re-does that on every turn, persists nothing, and the
conversation pays a growing token bill until it hits the ceiling.

- in `context_legacy.go`, resolve `registry.GetAgent(req.AgentID)` and fall back to
  `GetDefaultAgent()` when it is empty, so single-agent deployments are untouched.

**`Clear` needs a decision of its own.** `ContextManager.Clear(ctx, sessionKey string)`
(`context_manager.go:30`) takes a bare string — there is no request struct to widen — and
its only caller is `agent_command.go:336`, which already has `opts` in hand. Fixing the
`/clear` row of §1's table therefore means changing that signature too (an interface
break, and the seahorse implementation with it). Either widen it in the same patch, or
scope the patch to `Assemble`/`Compact` and state that `/clear` in a project chat stays
broken — but do not leave it implied.

Three tests ship with it in `pkg/agent/context_routed_agent_test.go`, and the Dockerfile
runs them as a build gate like the other two patches':

| Test | Pins |
|---|---|
| `TestLegacyAssemble_ReadsRoutedAgentSessionStore` | history comes from the routed agent's store, and the default agent's store never held the conversation |
| `TestLegacyAssemble_EmptyAgentIDFallsBackToDefault` | an empty **and** an unknown `AgentID` both resolve to the default agent — so a caller that names no agent keeps the pre-patch behaviour, and a stale route costs no answer |
| `TestLegacyCompact_CompressesRoutedAgentSessionStore` | compaction shrinks the routed agent's session and leaves the default agent's untouched (compaction is destructive; aiming it at the wrong agent drops a conversation for good) |

Verified before shipping: with the resolution reverted to `GetDefaultAgent()` the first
test fails with `expected 2 messages …, got 0` — the empty history that *is* the bug —
and the third with `got 6 of 6`. The full `./pkg/agent/...` suite passes with the patch
applied, and all three patches apply cleanly to a fresh `v0.3.1` in Dockerfile order (no
two touch the same file).

This fits the directory's existing discipline — upstreamable as-is, tests included, no
zombie-crab content — and is the only option that also restores summarization for project
chats. It is a bigger patch than the two already there (it crosses the interface), so it
needs a re-read on every `PICOCLAW_TAG` bump.

### B — `agents.defaults.context_manager: "seahorse"` (no patch)

The seahorse manager keeps one SQLite engine keyed by session key
(`context_seahorse.go`), ingests through `turnState.ingestMessage` with the routed
session key, and assembles from that same engine — so it is agent-agnostic by accident of
shape, and project chats would retain context with a config change alone.

Ingest coverage was checked rather than assumed: `ingestMessage`
(`turn_state.go:679`) is called for the root/user message (`pipeline_setup.go:127`), the
assistant message (`pipeline_llm.go:654`), tool results (`pipeline_execute.go:332`,
`:720`), the iteration summary (`pipeline_execute.go:826`), the final message
(`pipeline_finalize.go:53`) and steering-folded messages (`turn_coord.go:161`) — the whole
turn, not a subset.

Caveats, all real:

- The DB lives at the **default agent's** `sessions/seahorse.db`, so project conversation
  content leaves the project workspace (still inside the user's own container, so the
  isolation claim holds, but the project boundary does not).
- `bootstrapSession` only replays the **default agent's** existing sessions at startup, so
  history already written into project workspaces stays invisible; context accumulates
  only from the switch onward.
- `newSeahorseContextManager` takes its summarization `CompleteFn` from
  `GetDefaultAgent()`'s `Provider`/`Model` (`context_seahorse.go:33-45`) — the same
  agent-blindness, one layer over. A per-project model override would be summarized with
  the main agent's model.
- It swaps a battle-tested summarizer for a newer one across the whole deployment, main
  agent included.

### C — Report upstream

Worth doing regardless of A or B: the defect is in `sipeed/picoclaw` `main` today and
hits any multi-agent configuration where agents have distinct workspaces, which is
picoclaw's own default for a named agent. A fix upstream retires whichever of A/B is
adopted.

### Not an option

Pointing every project agent at the main workspace would fix history by destroying the
per-project workspace, memory graph and persona that `agent-projects` exists to provide.

---

## 6. How to verify

**Step 0 — close the gap in §2, before any fix.** In a **no-project** chat (main agent),
send a message with a distinctive fact, then send `?`. If the agent keeps the fact, the
verdict is observed rather than deduced and the scope is exactly "project chats". If it
*also* forgets, the routed-agent defect is real but is not the whole story, and neither
option below would fix what the member is actually hitting — reopen §4.

**After a fix:**

The agent containers are the proxy's, not compose's, and they outlive a redeploy — but
`Manager.EnsureRunning` already checks `imageDrift` (`internal/docker/projects.go:416`)
and recreates a container whose image no longer matches `PicoclawImage`. So rebuilding
`zombie-crab/picoclaw:0.3.1-glob` is enough; the next message in any conversation swaps
the container. No `docker rm` needed. History survives the swap:
`JSONLStore.GetHistory` reads the session file on every call (`pkg/memory/jsonl.go:654`),
so an existing conversation should get its memory *back*, not start over.

1. Open the conversation that was already broken. Send `?`.
2. Pass: the reply engages with what was discussed before. Fail: the agent introduces
   itself.
3. Then a fresh check: new message with a distinctive fact, then `?`.
4. Then confirm the machinery, not just the answer: after >20 entries the project
   session's `meta.json` must acquire a non-empty `summary` and a `skip` offset — before
   the patch it never did, which is the same defect seen from the other side.

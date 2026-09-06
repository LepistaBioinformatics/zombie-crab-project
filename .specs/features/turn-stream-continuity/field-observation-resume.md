# Field observation — a resumed turn stops updating at the first transcript growth

**Date:** 2026-09-05. **Status:** traced in code, **fixed** (see "What shipped"), **not yet
reproduced or re-checked under instrumentation**.
**Relates to:** this feature's Group C (re-attach), T-08 (the gate that decides whether Group C
is built), and `resume-turn-after-reload` (the path this is about).

## What the member reported

> "Quando o usuário solicita uma atividade grande e atualiza a tela enquanto o bot ainda está
> processando, a SSE cai e as novas mensagens só chegam quando o usuário atualiza."

Reload during a long turn. The turn keeps running — that part works, and `resume-turn-after-reload`
picks it up. What does not work is that the conversation stops updating again almost immediately,
and the rest of the turn only appears on **another** reload.

## The chain, in code

`resumeIfActive` (`app/chat/turn-store.ts`) reads a transcript baseline, probes `/active`, marks
the turn running and then hands over to `recover()` — the recovery poll built for a **cut stream
on an open page**. Its exit condition is a single line:

```ts
if (length > baseline) return; // the turn landed; the painter will pull it
```

That condition is right for the case it was written for: the stream was cut *near the end* of a
turn, so the next thing to appear in the transcript is the reply. It is wrong for a resume, where
the turn may be at its beginning and the next thing to appear is a **tool step**.

And intermediate messages do appear mid-turn. picoclaw's `JSONLStore.AddFullMessage` →
`addMsg` **appends the line to the session file immediately** (`pkg/memory/jsonl.go:586`); `Save`
is a separate flush, not what makes a message visible. The proxy's history handler runs
`history.SyncDurable` before every read (`handlers.go:929`), so the webapp's own
`transcriptLength` sees each step land while the turn is still working.

So: first step persists → `length > baseline` → `recover` returns → `finally` runs
`finishIfDrained` → `running: false`, painter repaints once, tracking stops. The turn continues
for minutes with nobody watching, and the member's only way back in is a reload — which starts
the same three-second cycle over.

**Deduced, not observed:** the timing above assumes the first persisted step arrives well before
the reply. That is the normal shape of an agentic turn and matches the member's account of seeing
"os passos que executou" after a reload, but no instrumented run has been done. Confirming it
costs one long turn with `docker exec -u 0 <harness> wc -l <session>.jsonl` sampled during it.

## Why this is worth separating from Group C

Group C (re-attach to the live turn's frame log) is the complete answer and it is a two-repo
feature gated on T-08. This defect is one condition in one function: a resume that keeps polling
until the proxy says the turn is **no longer active** — repainting on each growth instead of
returning at the first — would close the reported gap using only endpoints that already exist
(`/v1/turns/active`, `/v1/sessions/history`). It is worth pricing separately before Group C is
committed to, and it does not compete with it: Group C makes the resumed view live, this makes it
last as long as the turn does.

It also changes what T-08 measures. T-08 counts turns whose stream was cut after the heartbeat
shipped; a member who reloads is a cut that the heartbeat can never prevent, and today's recovery
under-serves it for reasons that have nothing to do with the wire.

## What shipped (2026-09-05)

`crab-exoskeleton-webapp/app/chat/turn-store.ts`, one optional parameter and one branch:

- `recover(sid, ctx, preRead, stillActive?)`. Without the probe — a stream cut on an open
  page — behaviour is unchanged: the first growth is the reply, and it returns.
- With it — the resume path, which now passes `() => readActive(sid, ctx)` — each growth
  repaints through the existing painter (`onReplyDone`) and re-baselines, and the loop ends
  when the proxy says the turn is no longer active. `clearCompleted` no-ops while `running`
  is true, so repainting mid-turn pulls the new steps without touching the bands.
- `turn_lost` is now set only if **nothing** ever arrived. A resumed turn that kept
  producing and simply outlived the eleven-minute budget was not lost, and saying so would
  be the "success shown as a failure" this path exists to avoid.

**Test:** `turn-store.test.ts` → *"repaints on every transcript growth instead of stopping
at the first"*. Watched it fail first (`painted.length` was 1: one repaint, at the end of a
resume that gave up three seconds in). The transcript grows 4 → step → nothing → step →
reply while `/active` stays true, then flips false.

Whole webapp suite green (1379 tests), `next build` clean, `tsc --noEmit` unchanged (the
five pre-existing errors are in unrelated test files and are identical with the change
stashed).

**Not done:** the live re-check — reload during a long turn and watch the steps land
without touching the page — and the instrumented confirmation that steps persist mid-turn
(`wc -l` on the session `.jsonl`). The fix does not depend on the second one being timed:
if steps did NOT land mid-turn the new loop would simply behave like the old one.

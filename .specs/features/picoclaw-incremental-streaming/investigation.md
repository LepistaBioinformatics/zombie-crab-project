# picoclaw-incremental-streaming — Feasibility Investigation

**Status:** Investigation (pre-spec). No implementation, no commitment.
**Date:** 2026-08-27.
**Written alongside:** `.specs/features/turn-stream-continuity/` — read its `spec.md`
DEC-8 first for why this is a *separate* feature and not part of that one.
**picoclaw in production:** `ghcr.io/lepistabioinformatics/picoclaw:0.3.1-glob` — upstream
`v0.3.1` plus this repo's two patches (`deploy/picoclaw-glob/`).

## The question, as asked

> *"Considere até se não houver uma maneira nativa, a possibilidade de implementarmos uma
> conexão http no picoclaw para que melhoremos essa experiência."*

## The framing correction that decides the answer

**A different transport between the proxy and picoclaw cannot help, and it is worth being
precise about why.**

The member's symptom lives between their browser and mycelium. proxy ↔ picoclaw is
server-to-server inside the Docker network: same host, no TLS, no edge proxy, no NAT, no
carrier. Nothing about the member's connection reaches that hop, so replacing its
WebSocket with HTTP changes nothing they would ever notice. The WebSocket is also not
incidental — `internal/pico/turn.go` speaks picoclaw's Pico Protocol over it, and that
protocol is bidirectional and frame-oriented in a way an HTTP request/response is not.

**But there is a real picoclaw-side item behind the question, and it is upstream of the
entire `turn-stream-continuity` feature.**

picoclaw answers in **one terminal frame**. Measured, `chat-responsiveness` OQ-1, a trace
in `processor.handle` over two real turns:

```
01:43:55  typing.start
          …51 seconds of complete silence…
```

then the whole reply at once. That silence is what makes the SSE idle, what makes the idle
connection reclaimable, and what makes `turn-store.ts`'s reveal driver a *simulation* of
streaming rather than streaming — its own header says so. Every mitigation in
`turn-stream-continuity` works around that silence. **This investigation is about removing
it.**

## 1. The proxy is already a streaming consumer — this is the load-bearing finding

`internal/pico/turn.go:179` handles `"message.create"` **and `"message.update"`** in the
same branch, and the branch is written for incremental delivery:

```go
prev := p.plain[pl.MessageID]
p.plain[pl.MessageID] = pl.Content
p.lastPlainID = pl.MessageID
p.hasPlainContent = true
// Cumulative content: emit only the newly-appended suffix.
if len(pl.Content) > len(prev) {
    p.sink.EmitContent(pl.Content[len(prev):])
}
```

Cumulative-content bookkeeping, per `MessageID`, emitting only the new suffix. That is a
delta consumer. `EmitContent` lands in `sse.go`'s `Content` sink, which writes an ordinary
OpenAI content chunk to the browser.

So: **if picoclaw sent updates, the proxy would already forward them as deltas, and the
webapp would already render them.** No proxy change, no webapp change. The failure to
stream is entirely upstream of `internal/pico`.

Two smaller things fall out of the same read, and both are already correct:

- The failure-detection path (`isProcessingError`) is deliberately tested against the
  **cumulative** content and not the suffix, *"so a failure whose text arrives as an
  update after a partial would otherwise slip through"*. Someone already thought about
  updates arriving.
- Attachment frames are handled **before** the plain-content branch, so a delivery cannot
  erase the answer. Incremental updates do not disturb that ordering.

## 2. picoclaw has a streaming interface, and its own pico channel implements it

From `picoclaw-as-library/investigation.md` §2.5, recorded there as read in `v0.3.1` and
not inferred:

> Streaming: `StreamingCapable.BeginStream(ctx, chatID) (bus.Streamer, error)`, where
> `Streamer` is `{Update, Finalize, Cancel}`. The pico channel implements it
> (`pico.go:514`), so the path is exercised in production today.

`Update` / `Finalize` / `Cancel` is exactly the shape that would produce
`message.update` … `message.update` … `message.create`.

**So the interface exists, the channel we use implements it, and the consumer already
handles it — and yet the measured wire shows one frame.** That gap is the whole
investigation, and it is *not yet explained*.

## 3. What must be established before anything is proposed

Ordered by cost, cheapest first. **Do not skip to (d).**

**(a) Re-measure on the deployed image.** The 51s trace is from 2026-07-28. The deployed
harness is `0.3.1-glob`. Confirm the one-frame behaviour still holds before investigating
a behaviour that may have changed — the same trace in `processor.handle`, or simply
logging every frame type and `MessageID` for one long turn.

**(b) Read `pico.go:514` and its callers in `v0.3.1`.** Under what conditions does the
pico channel's `BeginStream` get used? The likely candidates, none of them verified here:
the agent loop only calls it for some message classes; it is gated on a config key; it is
used for the *typing* indicator rather than for content; or the LLM call itself is
non-streaming so there is nothing to update *with*.

**(c) Check whether it is a configuration question.** `pkg/agent`/`pkg/config` in `v0.3.1`
for anything gating streaming or the provider call's `stream` flag. **If this is a config
key, the whole feature is a config change** and everything below is moot. It is the
highest-value hour in this document precisely because it might end it.

**(d) Only then**, size a code change — and see §4 for what "code change" costs here,
which is much less than it would normally be.

**None of (b) or (c) can be answered from this repository.** picoclaw's source is not
vendored; `deploy/picoclaw-glob/` holds only two patches and a Dockerfile that clones
upstream at build time. Answering them means reading `sipeed/picoclaw` at the `v0.3.1`
tag. **Anything asserted about picoclaw's internals without that read is a guess, and this
document does not contain one.**

## 4. Delivery is already solved, and that changes the cost

This is the second finding that matters, and it is easy to miss.

**This stack already ships its own patched picoclaw.** `deploy/picoclaw-glob/` holds
`dispatch-selector-glob.patch` and `vision-unsupported-glm.patch`; the
`release-picoclaw-glob` workflow clones upstream at a pinned tag, applies them, runs
upstream's Go tests, and publishes to GHCR; the deployed image is that output.

So a picoclaw-side change is **a third patch in an existing, tested pipeline** — not a
fork, not a vendored copy, not an upstream PR to wait on. The workflow's own comments
already encode the discipline it needs: *"a patch that no longer applies cleanly is a
signal"*, no build cache so the tests are real evidence every time, and a patch edit
rebuilds against the bytes the patch was written for.

That said, the ordering in §3 stands. A patch is cheap to *ship* and permanent to
*maintain* — every upstream bump re-applies it — so a config key beats a patch, and an
upstream-supported path beats both.

## 5. What it would be worth

Assuming (a)-(d) land somewhere useful:

- **The silence goes away at the source.** Not filled with pings (`turn-stream-continuity`
  Group A) — actually filled, with the answer. Every hop's idle timeout stops being
  relevant, and Group C's re-attach loses most of its remaining reason to exist.
- **The typewriter becomes real.** `turn-store.ts`'s reveal driver exists solely because
  *"picoclaw does NOT stream: it returns the whole answer in one frame"*. With real
  deltas, `REVEAL_MS_PER_WORD` / `REVEAL_TOTAL_MS` / `REVEAL_MAX_STEPS` and the whole
  O(n²) re-render problem they were tuned around become a much smaller problem, or none.
- **Perceived latency drops to first-token.** Today it is whole-answer. This is the single
  largest available improvement to how the chat *feels*, and it is bigger than anything in
  `turn-stream-continuity`.
- **It does not fix cuts on its own.** A member on a genuinely broken connection still
  loses the stream. Prevention plus recovery still earn their keep — this reduces how
  often they are needed, it does not replace them.

## 6. What it would cost, beyond the patch

- **Maintenance on every upstream bump** (§4). Real, recurring.
- **A steering-message interaction to re-check.** `picoclaw-as-library` §3.1: turns are
  serialized per session key and a second message for an active session is folded in as a
  *steering message*, not answered separately. Whether that interacts with a stream in
  progress is unknown and would need reading.
- **The proxy's completion heuristic gets harder, not easier.** `internal/pico/turn.go`
  finalises on "real content has arrived AND typing has stopped" after a 500ms
  `graceWindow`. More frames per turn means more chances for that window to be crossed at
  a bad moment. This is the same race `picoclaw-as-library` §5 calls *"tuned rather than
  solved"* — and it is an argument for reading that document before this one is turned
  into a spec, because the library route removes the race entirely instead of stressing
  it.
- **Nothing in the webapp.** Deltas already render; that is §1.

## 7. Verdict

**The transport question is answered: no.** An HTTP connection between the proxy and
picoclaw addresses the wrong hop and would improve nothing the member can perceive.

**The framing question is open and worth an hour.** picoclaw exposes a streaming
interface, the channel we use implements it, and the proxy already consumes deltas
correctly — so the measured one-frame behaviour is unexplained, and the explanation might
be a config key. §3(a)-(c) is the cheapest high-value work available anywhere near this
problem, and it is cheap enough that it should happen regardless of what
`turn-stream-continuity` does.

**Sequencing:** after `turn-stream-continuity` Group A. Group A is smaller, needs no
upstream knowledge, and reduces the harm this would remove — but this is the one that
removes the cause. If §3(c) finds a config key, promote it immediately, ahead of
everything else in either document.

## Open questions

**OQ-1 — Does the one-frame behaviour still hold on `0.3.1-glob`?** §3(a). Everything
here rests on a measurement from 2026-07-28.

**OQ-2 — Why does `BeginStream` not produce `message.update` frames on our path?** §3(b).
The central unknown. Not answerable from this repository.

**OQ-3 — Is streaming gated by configuration?** §3(c). If yes, this document is obsolete
and the answer is a config change.

**OQ-4 — Would incremental delivery destabilise the proxy's 500ms `graceWindow`?** §6.
The failure mode is a turn finalised early, mid-answer — which would be a *worse* bug than
the one being fixed, so this must be answered before any patch ships, not after.

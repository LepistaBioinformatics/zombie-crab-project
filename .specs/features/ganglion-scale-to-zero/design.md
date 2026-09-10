# ganglion-scale-to-zero — Design

**Status:** Designed. Date: 2026-09-10. Reads `spec.md`.

Only D-2/D-3 need designing. The rest is mechanical: `fsync` is one call, the path move is
one constant, the cron gate is one predicate.

## D-2/D-3 — the partial answer, without breaking anything that reads the transcript

Two constraints fight each other:

- **FR-9 / `TranscriptStore` has no Truncate, no Rewrite.** That absence is the invariant
  that made compaction unable to shorten the served transcript. Checkpointing must not
  introduce a way to rewrite the file.
- **H-2 — `internal/history`'s existing parser must not see garbage.** It reads every
  JSONL line as a message. Marking partials with a new field would make an old reader
  render every checkpoint as a separate assistant message: the answer repeated ten times,
  growing.

### Rejected: partial entries in the JSONL

`{"role":"assistant","content":"...","partial":true}` appended per checkpoint, with the
reader filtering. It fails H-2 outright — `internal/history` does not know the field and
would show every checkpoint. It also needs a turn id to correlate, and it puts
soon-to-be-garbage in an append-only file that nothing may compact.

### Chosen: a sidecar file, overwritten atomically

```
<segment>/sessions/<key>.jsonl          the transcript, append-only, unchanged
<segment>/sessions/<key>.partial.json   the in-flight answer, rewritten per checkpoint
```

- Every ≤2s of streaming, the accumulated text is written to the sidecar with
  `os.CreateTemp` + `Sync` + `Rename` — the same atomic dance `store/window` already uses.
- When the turn completes, the assistant message is appended to the JSONL (fsynced), and
  **then** the sidecar is removed.
- The JSONL is byte-identical to what it is today. **H-2 is satisfied by construction, not
  by a parser change** — an old reader never opens the sidecar.
- Rewriting the sidecar is fine: it is derived, like the window. The append-only invariant
  is untouched because the sidecar is not the transcript.

### Supersession without a turn id

The crash window that matters is between "append the final message" and "remove the
sidecar" — there, both exist and a naive reader would show the answer twice.

No new id is needed. The sidecar records `answers_at`: the `created_at` of the user
message this turn is answering, which is already written before the provider is called.

```
fold rule: a sidecar is LIVE only if the transcript holds no assistant
           message with created_at >= answers_at.
           Otherwise the turn finished and the sidecar is stale.
```

Both cases are then correct:
- crash mid-stream → no assistant message after `answers_at` → the sidecar is the answer
- crash after append, before remove → an assistant message exists → sidecar ignored

### Who folds, and when

**The reader folds; it does not write.** The proxy, serving history, reads the sidecar and
appends it as one interrupted assistant message when the rule says it is live.

This is deliberate and it is what keeps two invariants at once:

- the proxy stays **read-only** against the harness's directory
  (`ganglion-conversation-metadata` DQ-3), and
- recovery is **immediate** — a member who reloads after a crash sees what they lost,
  rather than waiting for the next turn to trigger a fold.

The harness removes a stale sidecar on its next start, as housekeeping. Nothing depends on
that happening promptly.

### Why this does not contradict OQ-2 ("recovery only")

The fold rule keys on *the transcript*, not on liveness of a process. While a turn is
streaming, the harness holds the answer and the proxy is streaming it — the sidecar exists
but no reader consults it, because a live turn's reader is the stream. A reader that opens
the history mid-turn will see the sidecar as live and show it, which is the one case OQ-2
chose to keep simple. Accepted: it shows *less* than the stream, never something wrong.

## D-1 — fsync

`Store.Append` gains `f.Sync()` before `Close`. Measured 887µs on the deployment's volume;
three per turn. No batching (spec OQ-1).

`Store.Read` is unchanged.

## D-5 — checkpointing must not stall the stream

The checkpoint runs from the loop, between deltas, not from a goroutine racing the writer:
a 887µs write every 2 seconds of streaming is 0.04% of that window, so there is nothing to
parallelise and a second writer would need a lock around the sidecar for no gain.

The rule is a time check on the delta path — `if now.Sub(lastCheckpoint) >= 2s` — so a fast
stream checkpoints on a wall clock, not per token.

## H-1 — the path

The harness writes `<GANGLION_DATA_DIR>/sessions/`; the proxy reads
`<userDir>/<segment>/sessions/`. The mount already puts `<userDir>` at
`GANGLION_DATA_DIR`, so the fix is for the harness to write one level deeper, under the
`workspace` segment the proxy's `MainWorkspace` already names.

One constant in the composition root. No proxy change (spec H-1's preferred fix).

## SZ-2 — the cron gate

`requireHarnessFeature` already exists and gates by harness. Cron is not a harness property
— it is a **mode** property, because a stopped container fires no timers whatever runtime
is inside it. So the gate grows a mode-keyed sibling rather than a new entry in
`picoclawOnly`:

```go
func requireContinuousMode(w http.ResponseWriter, a config.Agent, f harnessFeature) bool
```

Applied at the cron handlers' caller resolver, the same one-chokepoint shape used for
projects and personal models. It refuses a scale-to-zero picoclaw agent too; none exists
today, and the property is about the mode.

## Order

H-1 first — it is the prerequisite for both this feature and
`ganglion-conversation-metadata`, and it is a constant.

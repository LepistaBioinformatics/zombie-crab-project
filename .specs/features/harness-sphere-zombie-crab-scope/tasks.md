# harness-sphere-zombie-crab-scope — Tasks

**Status:** Group R **DONE** (harness-sphere#23). Groups D and S **not started**.
**Date:** 2026-09-08.
**Design:** `design.md` (DEC-20…DEC-24). **Spec:** `spec.md` (FR-R, FR-D, FR-S, FR-C).

Build order: `R ✓ → D → S`. D and S are two PRs on purpose (design.md, "Build order") —
D carries the runtime-architecture risk, S carries the privilege grant.

## Group R — scope reduction ✅ DONE

| ID | What | Requirement | Status |
|---|---|---|---|
| R-01 | Delete `crates/ingest` + the `Receiver` port + supervisor receiver loop | FR-R2 | ✅ hs#23 |
| R-02 | Delete `collectors/src/prometheus.rs`, its feature, fixture and 4 config fields | FR-R1 | ✅ hs#23 |
| R-03 | `Layer` → the six of DEC-8, no fallback arm | FR-R3, FR-R4, FR-R5 | ✅ hs#23 |
| R-04 | `config.example.toml` + `config.zombie-crab.toml` describe only surviving fields | FR-R6 | ✅ hs#23 |
| R-05 | README / PROJECT.md / STATE.md describe six layers and one stack | FR-R7 | ✅ hs#23 |
| R-06 | build + test + audit green | FR-R8 | ✅ hs#23 (audit needed an h2 bump; it did not pass on `main` either) |

**Measured, not estimated:** −1,562 LOC. Default dependency graph 140 → 78 unique entries;
`h2` left the default build entirely and is now reachable only under `--features otlp`,
as a client rather than a listening server.

## Group D — dynamic discovery (PR 1)

| ID | What | Where | Depends on | Done when |
|---|---|---|---|---|
| D-01 | `SourceDescriptor.name` becomes `String` | `domain/src/ports.rs` + every collector | — | Workspace compiles; no `&'static str` name remains |
| D-02 | `SupervisorCmd` enum + command channel; `run`'s `select!` gains a third arm | `runtime/src/lib.rs` | D-01 | A test adds a source to a *running* supervisor and sees its signals |
| D-03 | Source registry `HashMap<String, SourceHandle>` | `runtime/src/lib.rs` | D-02 | Duplicate-name adds are rejected, not silently shadowed |
| D-04 | **Graceful removal** — stop signal → source emits terminal → join with timeout → `abort()` only as fallback | `runtime/src/lib.rs` | D-03 | A test removes a source and observes the **terminal signal** (DEC-12), not merely the absence of further ones |
| D-05 | `probe()` per instance at discovery; `NotApplicable` unreachable for discovered sources | `runtime`, `domain` | D-03 | A discovered source whose target is briefly down is still collecting after the target returns |
| D-06 | Probe targets become `(address, layer, attributes)` | `collectors/src/probe.rs`, config | D-01 | Gateway, Proxy and Webapp appear as three distinct layers on the existing dashboard |
| D-07 | Inventory client for `GET /v1/instances` (bearer from `CRAB_TELEMETRY_TOKEN`) | new collector module | — | 404 (token unset ⇒ route unregistered) is handled as "no inventory", not as an error |
| D-08 | Disk surface: glob `tenants/*/subscriptions/*/agents/*/users/*` | same module | — | Bounded — a glob, never a transcript walk (FR-D13) |
| D-09 | Reconcile the two surfaces; emit FR-D3 / FR-D4 / FR-D5 outcomes | same module | D-07, D-08 | All four union states from `design.md` are covered by tests |
| D-10 | Discovery task drives add/remove through the command channel | composition root | D-04, D-09 | A container created *after* boot is collected within one interval, no restart (FR-D6) |

**D-04 is the risk in this group.** The existing shutdown path (`abort()` + rely on
dropped sink clones to close the channel) is correct for process exit and silently wrong
for removing one source — the channel stays open, so no flush is triggered. Getting this
wrong produces exactly the symptom DEC-12 was written to prevent, and produces it
invisibly.

**FR-D5 needs a test that stops the proxy**, not one that mocks a 404. The property being
protected is behaviour when the proxy is *down*, which is when its metrics matter most.

## Group S — session collection (PR 2)

| ID | What | Where | Depends on | Done when |
|---|---|---|---|---|
| S-01 | One session source per workspace, attributed by the FR-D2 tuple | `collectors/src/session.rs` | D-10 | `session_dir` as a scalar is gone |
| S-02 | Cover **both** directories: `workspace/sessions` **and** `workspace-<project>/sessions` | same | S-01 | A fixture with a project workspace counts 12, not 7 (FR-S5) |
| S-03 | Exclude `sessions/durable/` explicitly, with a test | same | S-01 | A recursive-walk regression fails the test instead of doubling every count |
| S-04 | Exclude cron sessions via the `.meta.json` `key` prefix `agent:cron-` | same | S-01 | Cron fixtures do not inflate `harness.sessions` |
| S-05 | Incremental reads with a per-file offset; **a shrunk file re-reads from zero** | same | S-01 | A test truncates a file mid-run and the count does not go negative |
| S-06 | No transcript content in any signal | same | S-01 | Asserted, not assumed (FR-S6) |
| S-07 | Compose: `user: "0:0"` on `harness-sphere`, with the three load-bearing constraints named in a comment | `docker-compose.yaml` | S-01 | `/data` still `:ro`; still no Docker socket; still no ports |
| S-08 | Discharge F1 **FR-V3** against the live stack | — | S-07 | The three predicted distortions are each reported by name |

**S-07 is the privilege grant.** It lands here and not earlier because while `session_dir`
is empty, root has no consumer. Its comment must name all three constraints
(`:ro`, no socket, no listening port) — they hold up the OQ-6 argument together, and a
later change must not relax them one at a time.

## Traceability

| Requirement | Task(s) |
|---|---|
| FR-R1…R8 | R-01…R-06 ✅ |
| FR-D1, D13 | D-07, D-08, D-09 |
| FR-D2 | D-09, S-01 |
| FR-D3, D4, D5 | D-09 |
| FR-D6 | D-10 |
| FR-D7 | D-04 |
| FR-D8 | D-01 |
| FR-D9 | D-05 |
| FR-D10 | D-02, D-03, D-04 |
| FR-D11, D12 | D-06 |
| FR-S1…S6 | S-01…S-06 |
| FR-C9, C10 | S-07 |
| FR-C11 | pointer bump per `.claude/rules/submodule-pointers.md` |

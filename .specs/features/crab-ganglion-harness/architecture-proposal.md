# crab-ganglion-harness — Clean Architecture migration proposal

> **DECLINED (2026-09-10) — nothing was migrated, and the hexagonal layout at `2fd0348`
> stands.** The owner's reason, in their words: *"é um projeto pequeno."* That is the same
> judgement §6 of this document reached from the other side — four modules and four layers is
> a lot of structure for 1,828 lines, and the migration buys no behaviour. Kept as a record so
> a future session does not re-derive the analysis; **re-open it only if the Deferred table
> (DF-1..DF-6) starts landing and `adapter/` becomes the bag §1 warns about.**

**Status:** Declined. Superseded by nothing — `design.md` §1 and AR-1..AR-4 remain in force.
**Date:** 2026-09-10.
**Supersedes on approval:** `design.md` §1 (module layout) and AR-1..AR-4.
**Applies to:** commit `2fd0348` of `crab-ganglion-harness` — 1,828 LOC production, 959 test,
CI green.

---

## 1. What is wrong with what shipped

The current layout is hexagonal and it works, but it fails Screaming Architecture on its own
terms. This is what `ls internal/` says today:

```
domain/  runtime/  adapter/  config/
```

That names a **pattern**, not a system. It could be a payment gateway, a CRM, a build server.
Nothing in it says *"this thing holds conversations, calls tools, asks permission, and counts
tokens"* — which is precisely what the project exists to do, and two of those four are the
capabilities that justified building it at all.

Two further problems, both consequences of the same thing:

- **Use cases are invisible.** The system's central operation is "answer a turn". It lives as
  `runtime.Loop.Run`, a method on a struct named after a technical concept. There is no
  directory anywhere named for what the system *does*.
- **The modules are not extractable.** `adapter/` is one bag holding LLM access, storage,
  shell execution and approval. Nothing marks which parts belong together, so lifting
  approval out into its own module later means reading every file to find out what moves.

---

## 2. The proposal in one picture

**Feature-first at the top (screams), layered inside (Clean), dependencies pointing inward
only.**

```
internal/
├── conversation/            ← answering a turn: the reason the system exists
│   ├── entity/              ← Enterprise Business Rules
│   │   ├── message.go           Message, Role, ToolCall
│   │   ├── transcript.go        the append-only record
│   │   └── window.go            the derived context
│   ├── usecase/             ← Application Business Rules
│   │   ├── answerturn/          THE interactor (was runtime.Loop)
│   │   │   ├── interactor.go
│   │   │   ├── boundary.go      input/output ports, owned by the use case
│   │   │   └── interactor_test.go
│   │   └── compactcontext/      (was runtime/compact.go)
│   ├── gateway/             ← Interface Adapters, outward
│   │   ├── llm/openai/
│   │   └── persistence/{transcript,window}/
│   └── controller/          ← Interface Adapters, inward
│       ├── sse/                 the presenter: turn output → SSE frames
│       └── telegram/            (later; DQ-5)
│
├── approval/                ← gating an action: capability A1
│   ├── entity/                  ActionRequest, Decision
│   ├── usecase/requestapproval/
│   └── gateway/proxyhttp/
│
├── toolcalling/             ← what the agent can do
│   ├── entity/                  Call, Result, Schema
│   ├── usecase/invoketool/
│   └── gateway/shell/
│
├── accounting/              ← counting tokens: capability A2
│   ├── entity/                  Usage
│   ├── usecase/recordusage/
│   └── gateway/otlp/
│
└── platform/                ← Frameworks & Drivers. The ONLY tech-named directory.
    ├── httpserver/
    ├── config/
    └── log/
```

`ls internal/` now reads: **conversation, approval, toolcalling, accounting, platform.** That
sentence is the system. And it is not decoration — `approval` and `accounting` are the two
capabilities the whole investigation concluded had no seam in picoclaw. **The architecture
now names its own justification.**

---

## 3. The four layers, and the rule that makes them real

| Layer | Directory | May import |
|---|---|---|
| Enterprise Business Rules | `*/entity/` | **stdlib only** |
| Application Business Rules | `*/usecase/*/` | own module's `entity` + stdlib |
| Interface Adapters | `*/gateway/`, `*/controller/` | own module's `entity` + `usecase` boundaries |
| Frameworks & Drivers | `platform/`, `cmd/` | anything |

**The Dependency Rule is a test, not a convention.** This is carried over from AR-1, which
already exists and already passes; the migration widens it rather than inventing it:

- `TestEntitiesImportOnlyStdlib` — every `*/entity/` package.
- `TestUseCasesDoNotImportAdapters` — no `usecase` may reach a `gateway`, a `controller`, or
  `platform`.
- `TestModulesDoNotReachIntoEachOther` — the new one, and the one that buys modularizability
  (§4).

Two additions Clean makes that hexagonal did not, and both are renames of things already
built correctly rather than new machinery:

- **Boundaries belong to the use case, not to a shared package.** `answerturn/boundary.go`
  declares what *that* interactor needs. The single `domain/ports.go` becomes several small
  files, each next to its consumer. This is what lets a use case be understood alone.
- **`Sink` becomes the Output Boundary, and the SSE writer becomes the Presenter.** The
  interactor pushes results through an interface instead of returning them — which is exactly
  what streaming already does. No behaviour changes; the pattern gets its name.

---

## 4. Modularizable: the rule that makes extraction a `git mv`

> **A module may depend on another module only through interfaces it declares itself.**

`answerturn` needs tools and approval. It does **not** import `toolcalling` or `approval`.
It declares, in its own `boundary.go`:

```go
package answerturn

// Ports this interactor needs. Declared HERE, by the consumer -- which is what
// keeps conversation/ from importing toolcalling/ or approval/ at all.
type ToolInvoker interface {
    Available(ctx context.Context) []ToolSpec
    Invoke(ctx context.Context, c ToolRequest) (ToolOutcome, error)
}

type ApprovalRequester interface {
    Request(ctx context.Context, a ApprovalAsk) (ApprovalVerdict, error)
}
```

`ToolSpec`, `ToolRequest`, `ToolOutcome` are **conversation's own** types. `toolcalling`
never sees them: `cmd/` wires a thin translator between `toolcalling.Result` and
`answerturn.ToolOutcome`.

**That translation is the price, and it is the whole point.** It costs roughly 40 lines in the
composition root. It buys: any module can be lifted into its own `go.mod`, its own repository,
or replaced wholesale, without touching the others — and the test proves no one cheated.

Extracting `toolcalling` later becomes: `git mv`, add a `go.mod`, add a `require`. Nothing in
`conversation` changes, because nothing in `conversation` ever named it.

---

## 5. What actually moves

A pure refactor: **no behaviour change, no new features, tests green at every step.** The 28
existing tests are the safety net and none of their assertions change — only imports.

| Today | Becomes |
|---|---|
| `domain/message.go`, `domain/session.go` | split across `conversation/entity/`, `toolcalling/entity/`, `approval/entity/`, `accounting/entity/` |
| `domain/ports.go` | dissolved into per-use-case `boundary.go` files |
| `runtime/loop.go` | `conversation/usecase/answerturn/interactor.go` |
| `runtime/compact.go` | `conversation/usecase/compactcontext/` |
| `runtime/noop.go` | per-module null objects, beside their boundaries |
| `adapter/httpsse/` | `conversation/controller/sse/` (presenter) + `platform/httpserver/` (the listener) |
| `adapter/provider/openai/` | `conversation/gateway/llm/openai/` |
| `adapter/store/jsonl/`, `store/window/` | `conversation/gateway/persistence/{transcript,window}/` |
| `adapter/tool/`, `adapter/tool/exec/` | `toolcalling/` (all four layers) |
| `adapter/approver/proxy/` | `approval/gateway/proxyhttp/` |
| `Usage`, telemetry port | `accounting/` |
| `config/` | `platform/config/` |
| `domain/arch_test.go` | `internal/arch_test.go`, widened to the three rules of §3 |

Estimated: ~250 lines of genuinely new code (translators, split boundaries, the third arch
test), ~1,800 moved, one afternoon, one PR.

---

## 6. The honest counterpoint

**This is a lot of directories for 1,828 lines.** Four modules × up to four layers is 14
packages where there are now 9, and the translation layer of §4 is code that exists purely to
keep a boundary honest. If the harness stayed this size forever, hexagonal was the right
answer and this is ceremony.

Three things argue it is not:

1. The spec's own Deferred table (DF-1..DF-6) lists **six** features not yet built — MCP,
   memory graph, projects, personal models, cron, web tools. Most are new gateways; two are
   plausibly new modules. The structure is being chosen for the system's size in six months,
   not today.
2. `Ingress` already has a second implementation coming (Telegram, DQ-5), and the driving side
   is where hexagonal was thinnest.
3. The estimate for the whole harness is 5,000–9,500 LOC. At 1,828 we are at the *start*, and
   this refactor is cheapest now — the tests exist, nothing depends on the package paths yet,
   and no proxy integration has been written against them.

**The one thing this does not buy is behaviour.** No requirement in `spec.md` is closer to
done afterwards. It is a bet on the next 4,000 lines being easier, and it should be taken or
declined on that basis.

---

## 7. Two calibrations

**Full (recommended).** Everything above: four feature modules, four layers, consumer-owned
interfaces with translation at the composition root, three enforcement tests. Maximum
extractability, highest directory count, ~250 new lines.

**Pragmatic.** Same feature-first top level and the same layer rules, but shared entities live
in `conversation/entity/` and the other modules import them directly — no translation layer.
Saves ~40 lines of mapping and about half the friction; costs true extractability, since
lifting `toolcalling` out would drag `conversation/entity` with it. Honest middle ground if
the modules are never actually expected to leave this repository.

The difference between them is exactly §4, and nothing else.

---

## 8. What I need decided

1. **Full or Pragmatic** (§7).
2. **Module names.** `conversation` / `approval` / `toolcalling` / `accounting` — these become
   the vocabulary of the codebase and are expensive to change later. `conversation` is the one
   worth challenging: alternatives are `turn`, `chat`, or `agent`.
3. Whether the migration is **one PR** (atomic, one review, larger diff) or **one PR per
   module** (four reviews, `internal/` inconsistent in between).

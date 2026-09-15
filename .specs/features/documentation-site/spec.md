# Documentation site

One navigable book for the whole stack, published as a GitHub Page, in English
with a Portuguese translation, written for someone who has never seen this
project before.

## Why

The stack is five repositories. Today a newcomer has to read four separate
READMEs, two guides under `docs/`, and a diagram, and then assemble the picture
themselves. Nothing tells them what to run first. Nothing says which harness is
the one they should be using.

Worse, the same facts are written in several places and they drift. Three of the
last corrections made to this repository were fixing a document that had fallen
behind the code it described — the root README claimed a stock picoclaw binary,
claimed both agents ran picoclaw, and miscounted the submodules. Every
duplicated sentence is a sentence that can go stale on its own.

## Decisions taken before any file was written

**The book is canonical; the READMEs are entry points.** Each component README
keeps what a contributor needs while standing in that repository — what it is in
two paragraphs, how to build it, how to test it, what the gate is, where the code
lives — and links into the book for the product story. The product story is
written once.

**English is the source; Portuguese is a translation.** `src/` is English. The
Portuguese book is generated from `po/pt-BR.po` by `mdbook-gettext`. Translating
means editing the catalogue, never a second tree of Markdown files that can
diverge from the first.

**The ganglion is the harness the documentation teaches.** picoclaw is described
as the other harness, the one being deprecated, and the book says so plainly
rather than pretending it is gone.

## Requirements

### DOC-1 — The book exists and builds in both languages

`docs/book/` holds an mdBook: `book.toml`, `src/` with `SUMMARY.md`, `po/pt-BR.po`,
`theme/`. `mdbook build` produces the English book; `MDBOOK_BOOK__LANGUAGE=pt-BR
mdbook build` produces the Portuguese one. Both must build with no missing-file
warnings.

### DOC-2 — It publishes itself

`.github/workflows/deploy-docs.yml` builds both languages on a push to `main`
that touches `docs/**`, and deploys to GitHub Pages. The Portuguese book is
nested at `/pt-BR/` inside the English one, so one artifact carries both.

### DOC-3 — A quick start that works from nothing

A reader with a clone, Docker, and no prior knowledge can reach a working chat
with an agent by following one page in order. It states its prerequisites, gives
the commands, and says what success looks like at each step. It does not assume
the reader knows what a harness, a tenant or a subscription is.

### DOC-4 — Then the detail

After the quick start, chapters that explain the concepts (what the pieces are
and why the stack is shaped this way), how to use the chat client, how to
administer a deployment, how to operate one, and what each component is.

### DOC-5 — Written for a person

Complete sentences. Small, concrete examples rather than exhaustive reference
tables. Every claim about behaviour is grounded in a file in this repository or
one of its submodules, not in memory.

### DOC-6 — Every component README is complete

All four `crab/*` repositories have a README that opens with what the component
is, states how to build and test it, describes the code layout, and links to the
book. `crab-ganglion-harness` has the least today (47 lines) and needs the most.

### DOC-7 — No duplicated prose between the README and the book

Operational detail that moves into the book leaves the README, replaced by a
link. `docs/ADMIN_GUIDE.md` and `docs/CREATE_CUSTOM_AGENT.md` become chapters;
their `.pt-br.md` twins are dropped, because the catalogue now carries the
translation.

## Out of scope, and flagged

**Production does not point at a published ganglion image.** The sharper version
of this, established while writing the deployment chapter: `crab-ganglion-harness`
*does* publish `ghcr.io/lepistabioinformatics/crab-ganglion:sha-<short-sha>` on
every push to its `main`. What is missing is on this side — `docker-compose.prod.yaml`
never sets `CRAB_GANGLION_IMAGE` and `deploy/prod/.env.example` never mentions it,
so the base file's `zombie-crab/crab-ganglion:dev` carries through: a local-only
tag. A prod `up -d` on a host holding the submodules builds it and works; a
command that leaves the build-only service out — `up -d crab-shell-proxy`, a
prune, a pull-only deploy — reaches `EnsureImage`, misses locally, and 404s on
the pull. The book says this where the deployment chapter lives.

**The default harness is picoclaw in code.** `requireHarnessFeature` falls back
to `HarnessPicoclaw` when an agent declares no `harness:` key, so a book that
calls the ganglion the default would contradict the binary. Changing that
default is a behaviour change with its own risk, and it is being done as a
separate change in `crab-shell-proxy` rather than smuggled into a documentation
commit.

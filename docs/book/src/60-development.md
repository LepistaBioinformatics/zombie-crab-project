# Working on the stack

This page is for someone about to change the code. It says where the code is,
how to get a development environment, and — the part worth reading carefully —
exactly what each repository checks, because the four components do not check
the same things and one of them documents a command that cannot run.

## Where the code is

The product repository is `zombie-crab-project`, and four of its directories are
separate Git repositories brought in as submodules:

| Path | Language | What it is |
|---|---|---|
| `crab/crab-shell-proxy` | Go | [the orchestrator](./50-crab-shell-proxy.md) |
| `crab/crab-ganglion-harness` | Go | [the agent runtime](./51-crab-ganglion-harness.md) |
| `crab/crab-exoskeleton-webapp` | TypeScript | [the member-facing UI](./52-crab-exoskeleton-webapp.md), compose service `chat-webapp` |
| `crab/harness-sphere` | Rust | [the watcher](./53-harness-sphere.md) |

The product repository itself holds the compose files, the deployment
configuration under `deploy/`, the Dockerfiles for the Mycelium gateway and its
admin UI under `fungi/`, this book under `docs/book/`, and the specifications
under `.specs/`.

Because they are submodules, a plain `git clone` gives you four empty
directories. Clone the whole chain at once:

```bash
git clone --recurse-submodules https://github.com/LepistaBioinformatics/zombie-crab-project.git
cd zombie-crab-project
```

If you already cloned without them, `git submodule update --init --recursive`
fills them in.

## A development environment

The development compose file builds every service from source, so the only
prerequisites for running the stack are Docker with the Compose plugin and an
LLM API key. Copy `deploy/standalone/.env.example` to `.env` at the repository
root, fill in the bearer tokens, the per-agent API keys and the bootstrap
secret, and bring it up. [Installation](./02-installation.md) walks through this
in order, and [Configuration](./03-configuration.md) covers what each variable
does.

Two things about that build are worth knowing before you start.

The first is that some builds run tests. `crab-shell-proxy` and
`crab-ganglion-harness` both run `go vet` and their full test suite inside the
Docker build, before the binary is linked, so a failing test stops the stack
from coming up rather than producing a quietly broken image. That is the
intended behaviour for a development compose file, not an accident.

The second is that the two harness images are produced by build-only services —
`picoclaw-image` and `ganglion-image` — that build a tag and exit, and the proxy
waits for both. They exist because those images are not services of their own
and nothing pulls them: `docker system prune` removes an unused image, and
without a compose service to rebuild it, every agent using it would be dead
until somebody remembered to run `docker build` by hand.

To work on one component without rebuilding everything, you can develop it
natively against the rest of the stack. The webapp is the easiest case —
`yarn dev` on port 3000 against a running gateway — because it reads
`MYCELIUM_INTERNAL_URL` and `DATABASE_URL` at request time.

## The gates, repository by repository

> These lists come from each repository's workflows, its Dockerfile and its
> `package.json`. Where a repository has no automated check, this page says so
> rather than suggesting a command that nothing enforces.

### crab-ganglion-harness

The only repository with a pull-request workflow that runs the tests.
`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

```bash
gofmt -l .        # the workflow fails if this prints anything
go vet ./...
go test -race ./...
go build ./...
```

Run those four before you open a pull request and you have reproduced CI
exactly. `-race` is not decoration: the SSE writer has two writers by
construction, the turn and the heartbeat, and an interleaved write would corrupt
a frame the client is mid-parse on.

`release.yml` builds and publishes the image on a push to `main` or a tag, with
the layer cache disabled so that the tests inside the Dockerfile genuinely run
for those bytes.

### crab-shell-proxy

There is no pull-request workflow at all. The repository's only workflow,
`release-image.yml`, builds and publishes the image on a push to `main` or a
version tag — and the gate lives inside the Dockerfile, which runs `go vet ./...`
and `go test ./...` before the build step. A red test means no image.

Locally, those two commands are the whole check:

```bash
go vet ./... && go test ./...
```

A second suite drives a real Docker daemon and is kept behind a build tag, so it
runs neither in the command above nor in the image build. Run it when you have
changed the Engine API client or anything about container creation:

```bash
go test -tags integration ./internal/docker -run TestIntegration -v
```

It creates and removes a throwaway Alpine container, so it needs a reachable
`/var/run/docker.sock` but no LLM key.

### crab-exoskeleton-webapp

Two workflows, and neither runs the tests. `mycelium-transport.yml` greps `app/`
and `lib/` on pull requests that touch them, failing the build when a new REST
call to the mycelium gateway appears outside its allowlist — see
[the component chapter](./52-crab-exoskeleton-webapp.md) for what that rule is
and why. `release-image.yml` builds and pushes the image on a push to `main` or
a tag, which runs `yarn install --frozen-lockfile` and then `yarn build`.

So the effective CI check on the code is: it builds. The test suite is real and
extensive, it is documented in the repository's README, and running it is on
you:

```bash
yarn install
yarn test        # Vitest
yarn build       # the same thing the image build runs
```

> **Do not run `yarn lint`.** The script is `next lint`, but ESLint is not a
> dependency of this repository — it is in neither `package.json` nor
> `yarn.lock` and it is not installed, so the script cannot do anything. It is a
> leftover from a scaffold.

There is also no type-check script. `tsconfig.json` sets `noEmit`, so
TypeScript is a checker rather than a build step, and type errors reach you
through `yarn build` and through your editor.

### harness-sphere

No workflow runs `cargo test`, and none runs `cargo clippy`. What CI does run is
`cargo audit --deny warnings` when a `Cargo.toml` or `Cargo.lock` changes,
weekly on a schedule, and on manual dispatch; an automated model-written review
comment on every pull request; and the image build, whose Dockerfile compiles
the release binary without running the suite.

Tests do exist, under `crates/runtime/tests/` and `harnesssphere/tests/`, and
`rust-toolchain.toml` asks for `rustfmt` and `clippy` alongside stable Rust.
Nothing will run them for you, so run them yourself:

```bash
cargo build --release
cargo test
```

The `otlp` feature is the only one the binary declares; a build that will ship
metrics to a collector wants `cargo build --release --features otlp`.

## Working on this book

The book is an mdBook under `docs/book/`, with the English source in `src/` and
the Portuguese translation generated from `po/pt-BR.po`. English is the source
and Portuguese is a translation: translating means editing the catalogue, never
writing a second tree of Markdown files that can drift from the first.

```bash
cd docs/book
mdbook build                                           # the English book
MDBOOK_BOOK__LANGUAGE=pt-BR mdbook build --dest-dir book/pt-BR
```

The Portuguese build needs `mdbook-gettext` from `mdbook-i18n-helpers`.
`.github/workflows/deploy-docs.yml` builds both on a push to `main` that touches
`docs/book/**` and publishes them to GitHub Pages, with the Portuguese book
nested inside the English one so a single artifact carries both.

Give the Portuguese build a destination of its own, as above: `book.toml` sets
`build-dir = "book"`, so a bare `mdbook build` in Portuguese would overwrite the
English book in place. Note also that `create-missing = false` is set, so a
chapter listed in `SUMMARY.md` with no file on disk fails the build instead of
being created empty.

## Where to go next

[Contributing](./61-contributing.md) covers the conventions a change has to
follow, including the submodule chain and how a change moves through it.
[Troubleshooting](./43-troubleshooting.md) covers the failures people actually
hit while running the stack.

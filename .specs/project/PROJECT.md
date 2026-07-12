# zombie-crab-project

**Vision:** Run more than one PicoClaw personal AI agent instance, safely, behind a single authenticated front door.
**For:** Developers self-hosting PicoClaw who need multi-tenant/multi-team isolation without PicoClaw itself having RBAC.
**Solves:** PicoClaw has no roles/permissions concept -- anyone reaching a deployment can talk to it and read anyone else's session. Mycelium (API gateway, standalone mode) sits in front and adds real authentication, per-account identity, secrets injection, and (from this point on) role-scoped access per PicoClaw instance.

## Goals

- Multiple PicoClaw instances reachable only through Mycelium, never directly (no host ports on picoclaw/proxy services).
- Session identity derived from Mycelium's verified caller profile, never from client-declared fields.
- A human-usable way to sign in, create an account, and exercise the chat APIs end to end, to validate the whole chain (Mycelium auth -> proxy -> PicoClaw) actually works.

## Tech Stack

**Core:**

- Orchestration: Docker Compose
- Gateway: Mycelium API Gateway (Rust), `standalone` mode, built via `cargo install --git` pinned to a commit
- Agent: PicoClaw (Go binary, upstream, `gateway` mode)
- Sidecar: `picoclaw-openai-proxy` (Node.js, git submodule) -- OpenAI-compatible HTTP <-> Pico Protocol WebSocket
- Admin UI: `mycelium-webapp` (Vite/React), official image, added to compose for account/tenant/role management
- Test client: Next.js app (new, this repo) -- signs users in via Mycelium magic link and exercises the chat APIs

**Key dependencies:** Mycelium's beginner-scoped magic-link auth endpoints (`/_adm/beginners/users/magic-link/*`, `/_adm/beginners/users`)

## Scope

**v1 includes:**

- Two PicoClaw instances (alpha/beta) + proxies + Mycelium gateway, internal-only network
- `authenticated` routes deriving proxy identity from Mycelium's injected `x-mycelium-email`
- Next.js test UI: magic-link signin/account-creation, instance picker, minimal chat

**Explicitly out of scope (for now):**

- Per-instance role-scoped access (`protectedByRoles`) -- traced and deferred to a future
  milestone (M3 in ROADMAP.md): it requires a full Staff/tenant/subscription/guest-invite chain
  before *any* chat works, which conflicts with this project's "sign in and chat now" goal. See
  STATE.md AD-006.
- Production hardening (TLS termination, token rotation automation)

## Constraints

- Local/dev-oriented stack; no production deployment target yet
- Docker builds in this sandbox need `--network=host` for anything touching the internet

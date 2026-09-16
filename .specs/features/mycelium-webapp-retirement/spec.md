# Mycelium Webapp Retirement — Specification

**Status:** Draft
**Size:** Medium (no code; compose, configuration, documentation)
**Depends on:** `crab-exoskeleton-webapp` feature `tenant-subscription-admin`,
which must ship first. This specification is the second half of that work and
cannot land before it.

---

## Problem Statement

The stack builds and publishes `mycelium-webapp`, an upstream single-page app,
for one reason: it is the only place an operator can create a tenant, create a
subscription account, and create the guest roles that make an agent grantable.
Once the crab admin console does those things, the service is a second admin UI
for nothing — an extra image in every `up --build`, an extra published port, an
extra origin in the gateway's CORS allowlist, and a second sign-in an operator
has to learn.

It is also the load-bearing half of the quick start. Steps 5 and 6 of
`docs/book/src/01-quick-start.md` are the only documented route from a fresh
install to a working one, and both send the reader to `http://localhost:8081`.

## Goals

- [ ] `mycelium-webapp` is gone from every compose file, and `fungi/` no longer
      carries a Dockerfile for it.
- [ ] No published port, environment variable, or CORS origin exists solely for
      it.
- [ ] The quick start walks a reader from a fresh install to a working one
      entirely through the crab admin console, in both languages.
- [ ] Nothing in the book, the READMEs, or the deployment guides tells a reader
      to open an admin UI that no longer exists.
- [ ] The decision is recorded, superseding AD-002 rather than editing it.

## Out of Scope

| Excluded | Reason |
|---|---|
| Narrowing or unpublishing the gateway's own port `8080` | Three consumers survive the SPA: the browser-based staff bootstrap, `domainUrl` in magic-link emails, and the prod reverse-proxy posture. Removing this SPA does not enable it. |
| Removing `http://localhost:8080` from `allowedOrigins` | Unresolved, deliberately — see FR-3. |
| Rewriting the historical specs that mention the SPA | They record what was true. AD-002 is superseded by a new decision, not edited. |
| The `gamma` block in `config.standalone.toml` | A separate, unrelated question in the same file. |

## Requirements

### FR-1 — Compose

1. The `mycelium-webapp` service block and its lead comment SHALL be deleted
   from `docker-compose.yaml`.
2. The topology header comment SHALL stop naming it as a service a human opens.
3. The gateway healthcheck comment SHALL stop citing it as a dependant; the
   healthcheck itself stays, because `chat-webapp` still depends on it.
4. The `harness-sphere` build comment's cross-reference to it SHALL be repaired.
5. The `docker-compose.prod.yaml` header bullet explaining why it is still built
   in prod SHALL be deleted. No service override exists there, so nothing else
   changes.
6. `docker-compose.observability.yaml` SHALL NOT change; it never referenced the
   service.

### FR-2 — Environment

1. `MYCELIUM_WEBAPP_PORT` SHALL be removed from `deploy/standalone/.env.example`
   and `deploy/prod/.env.example`, and the prod file's "Published ports
   (webapps + gateway)" heading SHALL become singular.
2. Untracked local `.env` files are the operator's own; the change SHALL be noted
   in the PR body, not committed.

### FR-3 — CORS origins

1. `http://localhost:8081` SHALL be removed from `allowedOrigins` in
   `deploy/standalone/config.standalone.toml` and `deploy/prod/config.base.toml`,
   together with the comment blocks explaining why the SPA needed it. It exists
   solely for that browser-side SPA; the crab webapp is a server-side BFF that
   reaches the gateway over internal DNS and is never a cross-origin caller.
2. `http://localhost:8080` SHALL be **left in place**. It is the gateway's own
   origin, and the staff bootstrap flow posts to it from a browser. Whether the
   gateway's CORS layer rejects a same-origin request carrying an unlisted
   `Origin` header was not determined, and the repository comment calling it
   "harmless to leave in" is not evidence that removing it is safe.
3. Trimming it further SHALL be a separate change, gated on running the bootstrap
   flow against the trimmed list or reading the gateway's CORS wiring.

### FR-4 — Dockerfile

1. `fungi/mycelium-webapp/` SHALL be deleted. Its Dockerfile has exactly one
   consumer, the compose block removed in FR-1.
2. `fungi/mycelium/` stays; the gateway is unaffected.

### FR-5 — Quick start

1. Steps 5 and 6 of `docs/book/src/01-quick-start.md` SHALL be rewritten to walk
   the reader through the crab admin console: create a tenant, create a
   subscription account, create the agent's guest roles, and grant themselves
   write access.
2. The sentence explaining that those screens belong to Mycelium and are
   therefore not documented click by click SHALL be removed — they are this
   project's screens now, and the quick start SHALL describe them.
3. The rewritten steps SHALL state the precondition the console does not remove:
   a fresh install's **first staff account** still comes from
   `/_adm/instance/bootstrap`, which is one-shot and unavailable once claimed.
4. The existing pointer to the admin guide SHALL be kept and repaired.

### FR-6 — The rest of the book

1. `02-installation.md` SHALL drop the admin interface from its image count —
   currently "seven images", which becomes six — from its list of published
   ports, from its environment-variable list, and from the repository tree. The
   paragraph explaining that changing the port means changing `allowedOrigins`
   SHALL go with it.
2. `10-architecture.md` SHALL stop describing two browser applications that
   publish ports, and stop saying `fungi/` holds the admin UI's Dockerfile.
3. `40-deployment.md` SHALL drop the `fungi/mycelium-webapp` sentence while
   keeping the pin-coupling statement about the gateway, drop the
   "still built here" bullet — adjusting the "two more things" lead-in that
   introduces it — and rewrite the prod hostname guidance so `domainUrl` survives
   without the `VITE_MYCELIUM_API_URL` coupling.
4. `52-crab-exoskeleton-webapp.md` SHALL keep its point that this app bakes
   nothing deployment-specific, without the SPA as its foil.
5. `60-development.md` SHALL stop listing the admin UI among the Dockerfiles in
   `fungi/`.
6. `30-admin-guide.md` SHALL gain the tenant, subscription account and guest-role
   screens. It mentions the SPA nowhere today, so nothing in it is undone.

### FR-7 — Portuguese edition

1. Every changed English paragraph SHALL have its pair updated in
   `docs/book/po/pt-BR.po`.
2. This is not optional polish: the gettext preprocessor does not fail on a stale
   entry, so an unrevised `msgid` makes that paragraph silently fall back to
   English in the published Portuguese book.
3. `docs/book/po/messages.pot` and `docs/book/book/` SHALL NOT be hand-edited;
   both are generated and gitignored.

### FR-8 — READMEs

1. `README.md` and `README.pt-br.md` SHALL drop the SPA as an alternative route
   for granting roles, keeping the crab admin path that already exists beside it.
2. The prod hostname bullet SHALL keep `domainUrl` and lose the
   `VITE_MYCELIUM_API_URL` coupling.
3. The repository tree SHALL lose the `fungi/mycelium-webapp/` line.
4. The licensing note SHALL be narrowed: after removal this stack no longer
   builds or distributes the admin UI, so the Commons Clause statement covers the
   gateway alone. The Portuguese file is a translated artifact and stays in
   Portuguese.

### FR-9 — Decision record

1. A new decision entry SHALL be added to `.specs/project/STATE.md` recording
   the retirement, naming what moved into the crab console and what was
   deliberately not ported.
2. It SHALL supersede AD-002 — which recorded that role assignment is done by
   hand in `mycelium-webapp` — rather than editing it.
3. The open item from FR-3.2 SHALL be recorded with it.

## Acceptance

1. `docker compose config` resolves with no reference to the removed service.
2. A `grep -rn "mycelium-webapp\|MYCELIUM_WEBAPP\|8081"` across tracked files
   returns only historical `.specs/` records.
3. `docker compose up --build` on a clean checkout builds one image fewer, and
   the gateway, chat webapp and proxy all come up healthy.
4. Following the rewritten quick start end to end, from a fresh volume, reaches
   a working chat — tenant, subscription account, guest roles and a granted
   agent — without opening any UI other than the crab webapp, save the one-time
   staff bootstrap page.
5. The published book shows the rewritten chapters in both languages, with no
   Portuguese paragraph silently reverted to English.

# crab-exoskeleton-webapp

The webapp is the part of the stack a member actually sees. This page describes
it as a component: what it is, the one transport rule that governs every change
to it, and where its code lives.

## What it is

`crab-exoskeleton-webapp` is a Next.js 15 application using the App Router. It
is both the user interface and a backend-for-frontend: the pages under `app/`
render the chat and the admin console, and the route handlers under `app/api/`
are a server-side layer that calls upstream on the browser's behalf.

> **Its compose service is `chat-webapp`, not the repository name.** So is the
> `name` field in its `package.json`, and so is the published image in
> `docker-compose.prod.yaml`. If you are looking for this component in a compose
> file, in `docker compose logs`, or in a container listing, look for
> `chat-webapp`.

The backend-for-frontend arrangement is the point rather than a detail. The
browser holds a session cookie and nothing else — no token, no account id, no
upstream URL. Every request goes browser, then route handler, then Mycelium
gateway, then [crab-shell-proxy](./50-crab-shell-proxy.md), so the same verified
identity that protects the backend protects the interface without the interface
having to re-implement any of it.

## What it is responsible for

**Holding the session.** Sign-in is a magic link. The route handler completes it
and stores the gateway session in an HTTP-only cookie; `middleware.ts` guards
`/chat` and `/onboarding` by checking that the cookie parses and that its token
has not passed its own expiry, redirecting to `/signin` and clearing the cookie
when it has not. That check is explicitly not validation — a token can be
revoked upstream while its expiry is still in the future, so the real answer
still comes from the first upstream call, which clears the session on a 401.

**The chat experience.** Streaming replies, conversation history, search,
renaming and tagging, deep links of the form `/chat/{agent}/{sessionId}`, file
upload into the member's workspace, and timeline and tree views of past
activity. See [The chat client](./20-chat-client.md).

**The operator console.** Tenants, subscriptions and members, the per-agent
model registry and per-user model assignments, shared skills and shared content,
secrets, and branding. The gateway still enforces who is allowed to do what;
these screens are a surface over the proxy's admin API, not a second
authorization system. See [Admin guide](./30-admin-guide.md).

**Its own database.** A Postgres connection, configured by `DATABASE_URL`,
carries the conversation index and app-side metadata. In the development compose
file this is the separate `chat-webapp-postgres` service.

## The transport rule: always JSON-RPC, never a new REST call

This is the one convention you must know before you write a line of code here.

Mycelium's gateway exposes both a REST API and a JSON-RPC 2.0 endpoint at
`POST /_adm/rpc`. They are not interchangeable and REST is the wrong default.
The gateway's `beginners` REST endpoints are external-identity-provider only:
for a magic-link user — which is every user of this deployment — they answer
`400 "Invalid provider"`. The RPC dispatcher resolves the internal issuer
instead, so it is the only transport that works for this stack's own members.
That was established by trying it, and the evidence is kept in
`.specs/features/onboarding/context.md` in this repository. The RPC surface is
also broader: whole operations, such as inviting and uninviting a guest, have no
REST equivalent this stack can reach.

In practice this means calling `myceliumRpc()` from `lib/mycelium.ts`, never
adding a new `fetchMycelium()` path to a `/_adm` REST route. Parameters are
camelCase, and the authoritative registry of method names is
`ports/api/src/rpc/method_names.rs` in the mycelium source — never guess one,
because an invented name fails only at runtime and the failure looks like a
permissions problem.

The rule is enforced rather than trusted. `.github/workflows/mycelium-transport.yml`
greps `app/` and `lib/` on every pull request that touches them and fails the
build when a `/_adm` path is passed to `fetchMycelium` from a file outside its
allowlist. The allowlist is where the exceptions live, each with a reason: the
pre-session magic-link request and verify pair, which has no token to
authenticate an RPC call with; `lib/mycelium.ts` itself, because
`POST /_adm/rpc` *is* the RPC transport; and `app/api/tenants/[id]`, which
predates the check and contradicts the rule as written, allowlisted so that it
is visible rather than silently tolerated. The workflow's own comment is honest
about its limit: it matches a `/_adm` path on one line, so a call built across
lines or through a variable is not caught. It is a ratchet against the easy way
in, not a proof.

One more boundary worth stating: requests to crab-shell-proxy — the
`/{agent}/v1/...` and `/alpha/v1/admin/...` paths — are the proxy's own HTTP API
and stay REST. "Call mycelium over JSON-RPC" is not "convert the proxy to
JSON-RPC".

## What it is not responsible for

It never talks to an agent container. There is no path from this application to
a harness that does not go through the gateway and the proxy.

It does not decide who may do what. Authorization is the gateway's, and the
screens reflect it rather than implementing it.

It bakes nothing deployment-specific at build time. `MYCELIUM_INTERNAL_URL` and
`DATABASE_URL` are read server-side at request time, which is what lets one
published image serve every deployment. The Mycelium admin UI that ships beside
it, `mycelium-webapp`, is a pure client-side SPA whose API URL *is* compiled in;
the two are different in this respect and the compose file says so.

## How it is built and tested

Development is the ordinary Next.js loop:

```bash
yarn install
yarn dev        # http://localhost:3000
```

Two workflows run in CI, and neither runs the test suite. `mycelium-transport.yml`
is the transport grep described above, on pull requests touching `app/` or
`lib/`. `release-image.yml` builds and pushes the image on a push to `main` or a
version tag; the Dockerfile installs with `yarn install --frozen-lockfile` and
then runs `yarn build`, so a build error fails the publish and a failing test
does not.

`yarn test` runs the Vitest suite, which is substantial and covers `lib/`,
`components/` and parts of `app/`. It is documented in the repository's README
and it is the check to run before you open a pull request — just be aware that
nothing in CI will run it for you.

> **`yarn lint` does not work.** The script is `next lint`, but ESLint is not a
> dependency of this repository: it appears in neither `package.json` nor
> `yarn.lock`, and it is not installed. The script is a leftover. Do not put it
> in a contribution checklist and do not expect a linter to catch anything here.

`tsconfig.json` sets `noEmit`, so TypeScript is a type checker rather than a
build step, and there is no script that invokes it on its own; type errors
surface through `yarn build` and through your editor.

The production image is small because `next.config.ts` sets
`output: "standalone"`, which traces only the dependencies actually used at
runtime — the final stage copies the traced server and the static assets and
needs neither `node_modules` nor yarn. The Dockerfile carries a long warning
against re-enabling `corepack`, which replaced a working bundled yarn with a
shim that resolves its version over the network and turned an offline build into
one that needed the npm registry.

## How the code is laid out

```
app/chat/        the chat experience
app/admin/       the operator console
app/api/         the backend-for-frontend route handlers
app/signin/      magic-link sign-in
components/      shared UI, plus the pre-auth landing page
lib/             everything that is not a component: mycelium.ts, session.ts,
                 the model, media, memory and admin helpers, i18n
middleware.ts    the session guard on /chat and /onboarding
.specs/          specifications; start with .specs/project/PROJECT.md
```

Tests sit beside the code they cover as `*.test.ts` and `*.test.tsx`.
`vitest.config.ts` excludes `node_modules`, `.next` and `.claude` by glob rather
than by bare name, because a git worktree checked out under `.claude/worktrees/`
once brought its own `node_modules` and another branch's tests into the run.

Styling is Tailwind CSS v4 with `class-variance-authority` for variants, rather
than conditional or interpolated `className` strings.

## Where to go next

[The chat client](./20-chat-client.md) covers using the application as a member,
and [Admin guide](./30-admin-guide.md) covers the operator screens.
[Working on the stack](./60-development.md) has the build and test commands for
every repository, and [Contributing](./61-contributing.md) has the conventions a
change has to follow.

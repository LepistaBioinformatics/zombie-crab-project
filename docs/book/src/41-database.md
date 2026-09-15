# Database and migrations

Most of what this stack persists is not in a database at all, and most operators
never run a migration. This chapter says which services do have one, what each
stores, and the single one-time schema step that exists — so you can tell quickly
whether it applies to you.

## Which services store what

**Mycelium, the gateway, owns identity.** Accounts, tenants, subscriptions, guest
roles and the magic-link tokens behind sign-in all live here. Where depends on the
deployment mode. In standalone it is SQLite: `deploy/standalone/config.standalone.toml`
sets `[sqlite] path = "/data/mycelium.db"`, and `docker-compose.yaml` mounts the
named volume `mycelium-data` at `/data`. In prod it is Postgres: the overlay adds a
`mycelium-postgres` service on `postgres:16-alpine`, backed by the
`mycelium-postgres-data` volume, and points the gateway at it through
`MYC_BASE_DATABASE_URL`.

**chat-webapp owns the conversation list.** `chat-webapp-postgres`, also
`postgres:16-alpine` on the `chat-webapp-postgres-data` volume, holds one small
set of tables: `conversations` (id, owner email, agent, title, workspace ids,
session file, project), `conversation_tags`, and a single-row `branding` table for
the app name and logos. It is deliberately a separate database from Mycelium's,
with a different lifecycle; the compose file argues the point at the service
definition.

**crab-shell-proxy owns a small key-value store.** At boot it opens
`model-registry.db` under its container data root
(`crab/crab-shell-proxy/cmd/crab-shell-proxy/main.go`). This is a bbolt file, not
SQL: `internal/registry/registry.go`'s `Open` creates every bucket it needs if
they are missing and carries its own `schema_version` marker with a boot
migration. It needs nothing from you.

**Everything an agent produces is files, not rows.** Transcripts, memory files,
projects, skills, delivered attachments and the proxy-owned
`.schedules.json`/`.projects.json` all live on disk under the data root, in the
tenant tree described in [Agents, workspaces and projects](./12-agents-and-workspaces.md).
That is why a reset is a `rm -rf` and not a `DROP`.

> `deploy/prod/config.base.toml` also carries a `[redis]` block, with
> `hostname = "mycelium-redis"` and `password = "unused-no-redis-container-in-this-stack"`.
> The configuration format requires the keys to exist; no Redis container runs in
> this stack. Do not go looking for it.

## When you need to do anything at all

Three of those four need no action.

Mycelium's **SQLite** adapter carries embedded migrations — `deploy/prod/config.base.toml`
says so where it explains that the Postgres one does not — so standalone works
from a clean checkout with no schema step.

**chat-webapp** creates its own schema lazily, at runtime, on the first query.
`crab/crab-exoskeleton-webapp/lib/db.ts` holds one `ensureSchema()` function that
issues `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
statements once per process and memoizes the promise. Every statement is
idempotent, and new columns are added additively so pre-existing rows survive.
There is no migration tool, no migrations directory and no command to run.

The **model registry** initializes itself, as above.

That leaves exactly one case: **Mycelium's Postgres backend, in prod, once, after
the first `up`.**

## The one-time schema step, prod only

Mycelium's Postgres adapter has no embedded migrations, unlike its SQLite one.
`deploy/prod/config.base.toml` records this directly above its `[diesel]` block,
and `docker-compose.prod.yaml` repeats it in the file header. Until the schema is
applied, the gateway has a database it cannot use, so nobody can sign in.

It is **two steps, in this order**: upstream's `up.sql`, then the migration
scripts that `up.sql` does not fold in. Both come from the mycelium repository at
the same release this deployment pins.

```bash
git clone --depth 1 --branch 9.0.0-rc.13 \
  https://github.com/LepistaBioinformatics/mycelium.git /tmp/myc
cd /path/to/zombie-crab-project && set -a; . ./.env; set +a
```

Sourcing `.env` is what puts `MYC_DB_USER`, `MYC_DB_NAME` and `MYC_DB_PASSWORD`
into your shell; those are the same three names `docker-compose.prod.yaml` hands
the `mycelium-postgres` service, so they will match whatever you set in
`deploy/prod/.env.example`.

**Step 1 — the base schema.**

```bash
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml exec -T mycelium-postgres \
  psql -U "$MYC_DB_USER" -d postgres \
       -v db_name="$MYC_DB_NAME" -v db_user="$MYC_DB_USER" \
       -v db_password="$MYC_DB_PASSWORD" -v db_role=service-role-mycelium \
  < /tmp/myc/adapters/diesel_postgres/sql/up.sql
```

The connection targets the `postgres` maintenance database because a database
cannot be created from inside itself. The root `README.md` describes what the
script then does — create the application database if it is missing, switch into
it, and create the roles and tables — and records that it requires
`-v db_password`. The `-v` flags are psql variables the script substitutes into
its own SQL.

> Compose has already created the database *and* the login role by the time you
> run this, because the `mycelium-postgres` service declares `POSTGRES_DB` and
> `POSTGRES_USER`. So `CREATE USER ... already exists` is expected output here,
> not a failure: `psql` prints it and keeps going.

**Step 2 — the migrations, in filename order.**

```bash
for m in /tmp/myc/adapters/diesel_postgres/sql/migrations/*.sql; do
  docker compose -f docker-compose.yaml -f docker-compose.prod.yaml exec -T mycelium-postgres \
    psql -U "$MYC_DB_USER" -d "$MYC_DB_NAME" < "$m"
done
```

The glob expands in lexical order, which is the order these scripts expect. Note
the `-d` here is the application database, not `postgres`.

This step is **not optional** at `9.0.0-rc.13`. The repository's own notes —
`deploy/prod/config.base.toml` above `[diesel]`, and the root `README.md` — record
that `up.sql` at this tag ships `kv_artifact` and the `message_queue` claim index
but *not* `instance_settings`, `resource_audit_log`, or the `tenant.encrypted_dek`
and `kek_version` columns that envelope encryption needs. Those exist only as
migration scripts.

To check the result, connect and look:

```bash
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml exec mycelium-postgres \
  psql -U "$MYC_DB_USER" -d "$MYC_DB_NAME"
```

`\dt` should list `instance_settings` and `resource_audit_log`; `\d tenant` should
show `encrypted_dek` and `kek_version`.

> The two commands above are the ones the root `README.md` gives, and the service
> name, the `MYC_DB_*` variable names and the compose file chain in them all match
> this checkout. What this repository cannot verify on its own is everything
> inside the mycelium clone: the paths `adapters/diesel_postgres/sql/up.sql` and
> `adapters/diesel_postgres/sql/migrations/`, the `db_role=service-role-mycelium`
> value, what `up.sql` does when it runs, and which tables that tag's `up.sql`
> does and does not create. All of that comes from the upstream repository. If a
> path has moved in a later release, read the clone rather than this page.

**On a Postgres deployment not driven by this repository's compose file**, run the
same two steps with `docker exec` against the `mycelium-postgres` container
directly. Nothing about the SQL changes; only how you reach `psql` does.

## What a reset does and does not touch

The reset described in [Deployment](./40-deployment.md) removes directories under
`data/`. It does not touch the named volumes, so Mycelium's accounts and roles and
chat-webapp's conversation list both survive it, and your login still works. That
is deliberate: wiping agent state is a routine development action, and losing your
Staff account each time would make it much less routine.

Adding `-v` to `docker compose down` removes the volumes as well. On standalone
that deletes `mycelium.db`, so you would re-run the Staff bootstrap from scratch.
On prod it deletes the Postgres data directory, so you would re-run the two schema
steps above as well.

## Where to go next

[Deployment](./40-deployment.md) covers the modes these databases belong to, and
[Troubleshooting](./43-troubleshooting.md) covers what a missing schema or a wiped
volume actually looks like from the chat client.

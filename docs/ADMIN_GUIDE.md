# Admin Guide

Day-2 operations from the **chat-webapp admin area**: injecting shared files,
secrets, and skills into users' agents, setting the agent's identity files,
deciding which model people get, repairing instance configuration, inviting
members, and setting branding.

For *creating* a new agent, see [Creating a Custom Agent](./CREATE_CUSTOM_AGENT.md).
For running/resetting the whole stack, see the root
[README](../README.md#running-and-resetting-from-scratch).

---

## 1. Who can administer, and what you pick first

The admin area is reachable from **chat-webapp** to accounts that manage a
**scope**. A scope is one of:

- **Tenant** — everything under a tenant.
- **Subscription** — one subscription account under a tenant.

The screen is **agent-first**: you choose the agent (`alpha`, `beta`,
…) before any tenant or subscription, because agents come from the
deployment's proxy configuration and exist before any tenant does. Then you pick
the scope in the rail, and every section acts on that **(agent, scope)** pair.
Changes cascade down to the agent containers of the users in that scope.

Two things are not agent sections: **Members** (a member list belongs to a
subscription, whatever agents it runs) and **Branding** (instance-wide,
staff-only).

The mental model: you edit **shared** material at a scope, the proxy syncs it
into an **effective** view, and each user's agent container mounts that view
read-only. One user never sees another user's private workspace — only the
shared material you injected at their scope.

The sections below are named as the tabs are: **Files · Secrets · Skills ·
Identity · Models · Config**, plus **Members** and **Branding**.

---

## 2. Files

Inject arbitrary files into every user's agent workspace at the scope.

1. Open **Files**.
2. Pick the scope.
3. Upload files.

Users' agents see them under their workspace. Use this for reference documents,
datasets, or any static content the agents should be able to read.

---

## 3. Secrets

Provide secrets (API keys, tokens, connection strings) to the agents at a
scope **without** baking them into templates or images.

Supported formats:

- **dotenv** — `KEY=value` lines.
- **json** — a flat JSON object of key/value pairs.
- **file** — upload a secret file as-is.

> The picoclaw-**native** secret format (model API key) is intentionally **not**
> available here. Model credentials are managed from the **Models** tab
> (section 6), not as a shared secret.

Secrets are written to the scope's shared-secrets store and synced into the
effective view mounted read-only into each user's agent.

---

## 4. Skills

Push skills (a `SKILL.md` plus optional supporting files) to all users' agents
at a scope. A skill is a folder with a `SKILL.md` (YAML frontmatter `name` +
`description`, then a Markdown body) — the same shape used in a template's
`workspace/skills/<name>/`.

1. Open **Skills**, pick the scope.
2. Add a skill by:
   - writing/editing its `SKILL.md` document inline, or
   - uploading a **zip** of the skill folder.
3. Archive or delete a skill to remove it from the scope.

The proxy syncs the scope's skills into the effective-skills view and mounts it
read-only into each user's agent. Editing a skill re-syncs it in place (the
mount inode is preserved so running agents pick it up).

---

## 5. Identity (persona)

The four files the agent reads as its identity, delivered to every workspace
under the (agent, scope) you selected — overriding the agent template, with the
more specific scope winning over the broader one:

| File | What it is | How it is delivered |
|---|---|---|
| `AGENT.md` | what the agent does and how it behaves | **read-only** |
| `SOUL.md` | its voice / personality | **read-only** |
| `HEARTBEAT.md` | its recurring task list | **read-only** |
| `USER.md` | what is known about the user | **seed only** |

The set is **fixed and closed** — these endpoints write into a workspace root,
so an arbitrary filename would be an arbitrary-file-write reaching every
container under the scope. The proxy rejects any other name.

- **Read-only files** cannot be changed by the member in their workspace, and an
  edit never survives a restart.
- **`USER.md` stays writable**: the agent records what it learns about the user
  there. Setting it here defines what a **new** workspace starts from; it never
  overwrites an existing one.

Each row says whether the file is **set here** or **inherited**. Opening the
editor preloads what the agent actually runs — resolved down the cascade
(this scope → the tenant below it → the agent template) — so you edit a real
identity instead of a blank page; **saving** is what makes it this scope's.
**Clear** removes it at this scope and the workspaces fall back to the broader
scope, or to the template.

---

## 6. Models

Two separate things: an **inventory** of models the proxy can serve, and the
**ladder** that decides which of them a given workspace resolves to.

### 6.1 The inventory (register once)

One inventory for the whole proxy. A model is registered once — with its
credentials — and every scope points at that record instead of holding its own
copy. Fill:

- **provider** — e.g. `zhipu`, `deepseek`, `openai`.
- **model_name** — the picoclaw `model_name` (e.g. `glm-4.7`).
- **litellm model** — the provider-side model id (often equal to `model_name`).
- **api_base** — the provider base URL.
- **api_key** — write-only; stored server-side, never echoed back.

Models are listed as **in service** or **retired/held back**; *deprecate* a model
to take it out of service without deleting the record.

### 6.2 The ladder (who gets what)

Read the ladder downwards: each rung covers fewer people than the one above and
overrides it — instance-wide rungs, then the tenant, then the subscription. The
**narrowest rung with a model wins**, and that is what a newly provisioned
workspace lands on.

If **nothing resolves** for a scope, new workspaces under it are **refused** —
so before clearing the rung in effect, check what (if anything) is set above it.
Rungs you lack authority to read stay hidden; an instance-wide rung may still be
covering the scope.

### 6.3 Pins (one person)

A **pin** assigns a registered model to a single user and outranks every rung
above. Use it for one person who needs something different — to move a whole
group, set the rung for their scope instead. Pins live under a **subscription**
(that is where users are), and a user only appears once they have a workspace,
i.e. after their first chat.

---

## 7. Config

Per-instance `config.json` repair, and bulk edits of one key across a
subscription.

- **Bulk** (one subscription at a time): name a **dotted path** to one value
  (e.g. `tools.web.brave.enabled`), **read the current distribution first** —
  what each member holds now — and only then write. Instances whose key is
  absent, blocked by a conflicting path, or whose config is unreadable are
  excluded from the bulk write and listed for repair one at a time. Keys the
  **proxy owns** (it rewrites them on every materialization) are refused: a bulk
  change there could not survive.
- **Single instance**: the raw editor opens a member's `config.json` as
  formatted **JSON** or as a **tree**, validates it, and writes it back.

A config change lands on the instance's next start. The restart control on the
panel decides how that bounce happens — **now** (the default), **schedule** it
for a time you pick, or **notice**: leave it to the member, who sees a
pending-restart notice in chat. The choice is per-session, not stored.

---

## 8. Members

The **Members** tab lists the users of the selected **subscription**, grouped by
agent (role). From here you can:

- **Invite** an account to an agent by email, at **read** or **write** access
  (write is what chatting requires; read is view-only).
- **Revoke** an account's access to that agent.
- See who exists per agent before pinning models (section 6) or reviewing shared
  material.

A **tenant** scope has no member list (members live at the subscription level).

---

## 9. Branding

Instance-wide branding: the app name, the logo shown as the tenant avatar in the
chat sidebar, and the app icon. This tab is **staff-only** and is not per-scope.

---

## 10. How roles gate access to an agent

Reaching an agent at all is a **mycelium** concern. The gateway routes are
`protectedByRoles` (one role per agent: `alpha`, `beta`, …), so an
account must hold the matching guest-role to talk to that agent, with `write` for
chat itself. Granting it is either the **Members** tab above (which drives
mycelium over JSON-RPC for you) or **mycelium-webapp** — Mycelium's own admin UI
— via the Staff → tenant → subscription → guest-invite flow. Once a user holds
the role, they appear under **Members** and can be pinned a model.

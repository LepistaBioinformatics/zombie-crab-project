# Admin Guide

Day-2 operations from the **chat-webapp admin area**: injecting shared files,
secrets, and skills into users' agents, registering models per agent and
assigning them to individual users, reviewing members, and setting branding.

For *creating* a new agent, see [Creating a Custom Agent](./CREATE_CUSTOM_AGENT.md).
For running/resetting the whole stack, see the root
[README](../README.md#running-and-resetting-from-scratch).

---

## 1. Who can administer, and scopes

The admin area is reachable from **chat-webapp** to accounts that manage a
**scope**. A scope is one of:

- **Tenant** — everything under a tenant.
- **Subscription** — one subscription account under a tenant.

Everything in the admin area operates **on the selected scope** (the scope rail
at the top). Changes cascade down to the picoclaw containers of the users in
that scope. **Branding** is the exception — it's instance-wide and only staff
can edit it.

The mental model: you edit **shared** material at a scope, the proxy syncs it
into an **effective** view, and each user's agent container mounts that view
read-only. One user never sees another user's private workspace — only the
shared material you injected at their scope.

---

## 2. Shared files

Inject arbitrary files into every user's agent workspace at the scope.

1. Open **Shared files**.
2. Pick the scope.
3. Upload files.

Users' agents see them under their workspace. Use this for reference documents,
datasets, or any static content the agents should be able to read.

---

## 3. Shared secrets

Provide secrets (API keys, tokens, connection strings) to the agents at a
scope **without** baking them into templates or images.

Supported formats:

- **dotenv** — `KEY=value` lines.
- **json** — a flat JSON object of key/value pairs.
- **file** — upload a secret file as-is.

> The picoclaw-**native** secret format (model API key) is intentionally **not**
> available here. Model credentials are managed per agent from the **Model** tab
> (section 5), not as a shared secret.

Secrets are written to the scope's shared-secrets store and synced into the
effective view mounted read-only into each user's agent.

---

## 4. Shared skills

Push skills (a `SKILL.md` plus optional supporting files) to all users' agents
at a scope. A skill is a folder with a `SKILL.md` (YAML frontmatter `name` +
`description`, then a Markdown body) — the same shape used in a template's
`workspace/skills/<name>/`.

1. Open **Shared skills**, pick the scope.
2. Add a skill by:
   - writing/editing its `SKILL.md` document inline, or
   - uploading a **zip** of the skill folder.
3. Archive or delete a skill to remove it from the scope.

The proxy syncs the scope's skills into the effective-skills view and mounts it
read-only into each user's agent. Editing a skill re-syncs it in place (the
mount inode is preserved so running agents pick it up).

---

## 5. Model — per-agent registry and per-user assignment

The **Model** tab lets an admin register LLM models **per agent** and then
assign a registered model to **individual users** of that agent. This is
admin-only: normal users cannot change their own model.

### 5.1 Register a model (per agent)

1. Open **Model**.
2. Choose the **Agent** (e.g. `alpha`, `beta`) at the top.
3. Under **Register model**, fill:
   - **provider** — e.g. `zhipu`, `deepseek`, `openai`.
   - **model_name** — the picoclaw `model_name` (e.g. `glm-4.7`).
   - **litellm model** — the provider-side model id (often equal to `model_name`).
   - **api_base** — the provider base URL (e.g. `https://open.bigmodel.cn/api/paas/v4`).
   - **api_key** — write-only; stored server-side, never echoed back.
4. **Register.** The model joins that agent's registry.

Registered models are **per agent and global to the agent** — the same list is
available to assign to any user of that agent.

### 5.2 Assign a model to a user

In the users list (users of the selected agent), pick a registered model and
**Apply** it to a user. The proxy writes the model entry — including its
`api_key` — into that user's picoclaw `config.json`, so the user's agent
authenticates with the assigned model on its next turn.

> A newly provisioned user starts on the agent's **default** model pinned in
> `crab/crab-shell-proxy/config.yaml` (with the key from the environment).
> Assigning a registered model here **overrides** that for the specific user.

### 5.3 Remove a model

Delete a registered model from the agent's registry with its delete action.
Users already assigned that model keep their current `config.json` until
reassigned.

---

## 6. Members

The **Members** tab lists the users of the selected **subscription**, grouped by
agent (role). Use it to see who exists per agent before assigning models
(section 5) or reviewing shared material. A **tenant** scope has no member list
(members live at the subscription level).

---

## 7. Branding

Instance-wide branding (logo shown as the tenant avatar in the chat sidebar).
This tab is **staff-only** and is not per-scope.

---

## 8. How roles gate access to an agent

Reaching an agent at all is a **mycelium** concern, not a chat-webapp one. The
gateway routes are `protectedByRoles` (roles `alpha` / `beta`), so an account
must hold the matching guest-role to talk to that agent. Roles are assigned in
**mycelium-webapp** (Mycelium's own admin UI) via the
Staff → tenant → subscription → guest-invite flow. Once a user holds the role,
they appear under **Members** (section 6) and can be assigned a model.

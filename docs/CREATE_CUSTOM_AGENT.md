# Creating a Custom Agent

A beginner's guide to defining your own picoclaw agent in `zombie-crab-project`.

By the end you'll have a new agent — with its own persona, skills, model, and
picoclaw config — that users can chat with through the portal.

---

## 1. What an "agent" is here

An **agent** is one named picoclaw personality (e.g. `alpha`, `beta`). Two pieces
define it:

1. **An entry in `crab/crab-shell-proxy/config.yaml`** — the agent's name, which
   mycelium service routes to it, which LLM model it uses, and which **template**
   it clones from.
2. **A template directory** on disk — the files that get copied into every user's
   private workspace the first time they chat with the agent (persona, skills,
   picoclaw config).

Each user gets their **own isolated copy** of the template (own workspace, own
chat history). The template is the starting point everyone is cloned from.

---

## 2. Where templates live

`crab-shell-proxy` resolves a template at:

```
<data-root>/templates/<template-name>/
```

- **On the host:** `<data-root>` is `CRAB_HOST_DATA_ROOT` from `.env`, defaulting
  to `./data` (i.e. `./data/templates/<name>/`).
- **Inside the containers:** the same tree is mounted at `/data`, so the proxy
  sees `/data/templates/<name>/`.

The stock agents ship as `data/templates/alpha/` and `data/templates/beta/`.

### Template structure

```
data/templates/<name>/
├── config.json          # picoclaw configuration (REQUIRED)
├── .security.yml        # picoclaw channels + model_list; holds the pico token slot
└── workspace/           # seeded into each user's workspace (allowlist below)
    ├── AGENT.md          # the agent's role / behavior
    ├── SOUL.md           # the agent's personality / voice
    ├── USER.md           # notes about the user / defaults
    ├── memory/           # starting memory notes (copied recursively)
    └── skills/           # starting skills (copied recursively)
```

Only these `workspace/` entries are seeded (the **allowlist**):
`AGENT.md`, `SOUL.md`, `USER.md`, `memory/`, `skills/`. Anything else under
`workspace/` (notably `sessions/`, `logs/`, `.picoclaw.pid`) is **never** copied —
that keeps one user's chat history and runtime state from leaking into another's.

A skill is a folder with a `SKILL.md` (YAML frontmatter `name` + `description`,
then a Markdown body):

```
workspace/skills/<skill-name>/SKILL.md
```

---

## 3. How seeding works (read this before you deploy)

- The template is applied the **first time a given user chats** with the agent
  ("first provision"). At that moment the proxy:
  1. copies `config.json` and `.security.yml` into the user's data dir, and
  2. copies the `workspace/` allowlist into the user's workspace.
- On **every** turn afterwards the proxy injects the model API key and a freshly
  generated pico token into the user's `.security.yml` — so **you never put keys
  or tokens in the template**; they come from the environment.
- A **returning user is NOT re-seeded.** If someone already chatted with the
  agent, changing the template later does **not** touch their workspace — only
  brand-new users get the new version.

> **Deploy tip:** prepare your templates **before** anyone uses the instance, so
> everyone is cloned from the final version.

> **Auto-bootstrap (safety net).** If an agent's `data/templates/<name>/` is
> missing at first provision, the proxy materializes a **default picoclaw
> template embedded in its binary** so provisioning never fails on a wiped or
> unseeded `data/`. That default is the stock picoclaw persona — **not** your
> custom one. So for a custom agent you still create the template below (steps
> 4.1–4.3); the bootstrap only guarantees a working baseline when you don't. To
> change the embedded default itself, edit
> `crab/crab-shell-proxy/internal/docker/defaulttemplate/<harness>/` (today:
> `picoclaw`) and rebuild the proxy.

---

## 4. Step-by-step: add a custom agent

We'll create an agent named `meuagente`.

### 4.1 Create the template directory

```bash
mkdir -p data/templates/meuagente/workspace/memory
mkdir -p data/templates/meuagente/workspace/skills
```

### 4.2 Provide `config.json` and `.security.yml`

The easiest start is to copy them from a stock agent and tweak:

```bash
cp data/templates/alpha/config.json    data/templates/meuagente/config.json
cp data/templates/alpha/.security.yml  data/templates/meuagente/.security.yml
```

You do **not** need to put any API key or pico token in `.security.yml` — the
proxy fills the model provider/name/key (from `config.yaml`, see 4.4) and the
pico channel token at provisioning time.

### 4.3 Customize the persona, memory, and skills

Edit the `workspace/` files to shape the agent:

- `workspace/AGENT.md` — what the agent does and how it should behave.
- `workspace/SOUL.md` — its voice / personality.
- `workspace/USER.md` — defaults or context about the user.
- `workspace/memory/` — any starting notes you want every user to begin with.
- `workspace/skills/<skill>/SKILL.md` — custom skills. Example:

  ```markdown
  ---
  name: greet
  description: Greet the user warmly in their language. Use at the start of a chat.
  ---

  # Greeting

  When a conversation starts, greet the user by name if known...
  ```

### 4.4 Register the agent in `config.yaml`

Add an entry under `agents:` in `crab/crab-shell-proxy/config.yaml`:

```yaml
agents:
  meuagente:
    serviceName: "picoclaw-meuagente"   # must match the mycelium service key (4.5)
    token: { env: "MYC_PICOCLAW_MEUAGENTE_TOKEN" }
    template: "meuagente"               # -> data/templates/meuagente/
    mode: "continuous"                  # or "scale-to-zero"
    idleTimeout: 15m                    # only used by scale-to-zero
    model:
      provider: "deepseek"
      name: "deepseek-chat"             # must match a model_name in .security.yml's model_list
      apiKeyEnv: "PICOCLAW_MEUAGENTE_API_KEY"
```

> **Mode:** `continuous` keeps the container running so the in-memory session
> isn't reset between turns; `scale-to-zero` stops it after `idleTimeout`.

### 4.5 Register the mycelium route

In `deploy/standalone/config.standalone.toml` (and the matching `deploy/<mode>/config.*.toml`), copy the existing `picoclaw-alpha` service
block and rename it to `picoclaw-meuagente` (the callers hit
`/picoclaw-meuagente/...`). Keep the same `token = { env = ... }`,
`healthCheckPath`, and `group` role settings — just change the name.

### 4.6 Set the environment variables

In `.env` (never in the config files), provide:

```
MYC_PICOCLAW_MEUAGENTE_TOKEN=<a shared secret; same value the mycelium route uses>
PICOCLAW_MEUAGENTE_API_KEY=<the LLM provider API key>
```

The token authenticates requests between mycelium and the proxy; the API key is
injected into each user's `.security.yml`.

### 4.7 Rebuild and restart

`config.yaml` is **baked into** the crab-shell-proxy image (a proxy-side agent
change needs a rebuild), while the mycelium config is now **mounted** from
`deploy/<mode>/` (config.standalone.toml / config.base.toml), so a route change
there only needs a restart. The safe catch-all is still a rebuild:

```bash
docker compose up -d --build crab-shell-proxy mycelium-gateway
```

The **template files** live in the mounted `/data` volume, so editing them later
does not need a rebuild — but remember the first-provision rule (section 3).

---

## 5. Quick checklist

- [ ] `data/templates/<name>/config.json` exists
- [ ] `data/templates/<name>/.security.yml` exists (model_list has your model; no keys)
- [ ] `data/templates/<name>/workspace/{AGENT.md,SOUL.md,USER.md}` written
- [ ] Optional `workspace/memory/` and `workspace/skills/<skill>/SKILL.md`
- [ ] Agent entry added to `crab/crab-shell-proxy/config.yaml` (`template:` points to `<name>`)
- [ ] Route added to `deploy/standalone/config.standalone.toml` (`picoclaw-<name>`)
- [ ] `.env` has `MYC_PICOCLAW_<NAME>_TOKEN` and `PICOCLAW_<NAME>_API_KEY`
- [ ] `docker compose up -d --build crab-shell-proxy mycelium-gateway`
- [ ] Templates finalized **before** users start chatting

---

## 6. Common gotchas

- **"My template changes didn't show up."** You (or the user) already chatted
  with the agent — returning users aren't re-seeded. Test with a fresh user, or
  reset that user's data dir.
- **"I added an agent but requests 404."** The mycelium route (4.5) is missing or
  the gateway wasn't rebuilt; callers must hit `/picoclaw-<name>/...`.
- **"Model auth fails."** `apiKeyEnv` in `config.yaml` must name a real env var,
  and `model.name` must match a `model_name` in the template's `.security.yml`
  `model_list`.
- **Never** commit API keys or tokens — they belong in `.env` / the environment,
  not in `config.yaml` or a template.

---

See also: `.specs/features/agent-customization/` (the design behind custom
templates and secret injection).

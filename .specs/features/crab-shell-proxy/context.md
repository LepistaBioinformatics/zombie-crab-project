# crab-shell-proxy — Discussion Context (Gray-Area Decisions)

Captured during Specify. These are the user's explicit answers to the architectural
forks; the spec and design build directly on them.

Reference document: `../../../zero-scale-stateless-hermes-agent.md` (the Hermes/scale-to-zero
architecture this feature adapts to picoclaw). That document was written *before* this
project's mycelium-profile identity model existed and uses a naive `X-User-Id` header —
this feature deliberately supersedes that part (see CTX-04).

---

## CTX-01: Connectors are picoclaw's own native channels, NOT proxy-routed traffic

**Question:** Do the Telegram / MS Teams connectors route through crab-shell-proxy, or are
they picoclaw's own outbound channels?

**Decision:** They are picoclaw's **native `channel_list` channels** (siblings of the `pico`
channel already used in this stack). They dial *out* from inside the picoclaw container to
Telegram / Teams and hold that connection open themselves. They never traverse mycelium or
crab-shell-proxy.

**Consequence:** "Continuous mode" is therefore **not** a routing subsystem — it is simply a
per-instance lifecycle flag meaning *"never arm the idle-timeout stop for this container."*
crab-shell-proxy only ever handles the **HTTP/API path** (OpenAI-compatible requests coming
through mycelium) plus **container lifecycle**. Connector traffic is out of scope for the
proxy entirely.

---

## CTX-02: Isolation model is per **(agent, user)**, keeping alpha/beta

**Question:** One container per user (drop the alpha/beta agent distinction), or one container
per (agent, user)?

**Decision:** **Per (agent, user).** alpha/beta remain distinct *agent configurations*. Each
signed-in user gets their own container **per agent**, named `picoclaw-<agent>-<userhash>`.

**Consequence:**
- Replaces today's model (two *shared* picoclaw instances + in-proxy
  `sha256(email::session_id)` keying) with **container-level** isolation per user.
- mycelium keeps routing `/picoclaw-alpha/...` and `/picoclaw-beta/...` to the single
  crab-shell-proxy service. The proxy resolves **agent** from the request context and **user**
  from the mycelium profile, then targets `picoclaw-<agent>-<userhash>`.
- Because isolation is now at the container/volume level, per-conversation isolation within a
  single user is still needed (multiple conversations per user) — that stays as a
  `session_id`-derived key handed to picoclaw, but the `email` component of the container
  identity now selects the *container*, not just a hash key inside a shared one.

---

## CTX-03: Translation ownership — ported into Go (single Go proxy over bare picoclaw)

**Question:** Reuse the proven Node `server.js` as a per-user sidecar, or port the
OpenAI-HTTP ↔ Pico-Protocol-WS translation into Go?

**Decision:** **Port into Go.** crab-shell-proxy is the single Go binary; it speaks the Pico
Protocol WebSocket **directly** to bare picoclaw containers (no Node sidecar). One container
per (agent, user), one language.

**Consequence / risk to carry into design:** The Go port must faithfully reproduce
`server.js`'s empirically-tuned turn-completion logic — the `typing.start`/`typing.stop`
pairing, the "only finalize once real (non-thought/non-tool_calls) content has arrived AND
typing has stopped" grace window, and the SSE streaming pass-through. This logic is documented
in the current proxy as fiddly and bug-prone; it is the single highest-risk item in the port
and must be covered by tests. `server.js` is the reference implementation for behavior parity.

---

## CTX-04: Identity comes from the mycelium profile, not `X-User-Id`

**Decision (from the user's brief + existing proxy):** Identity is the **principal owner's
email** decoded from the mycelium-injected `x-mycelium-profile` header
(base64 → zstd-decompress → JSON → `profile.owners.find(isPrincipal).email`), exactly as
`picoclaw-openai-proxy/server.js` does today. The raw email is then **hashed/sanitized** to
form the Docker container name and volume path (Docker's name charset will not accept a raw
email). The reference doc's `X-User-Id` header is explicitly superseded.

**SDK seam:** The user is building a **Go mycelium SDK** in parallel. Design must define a
narrow identity-decoding *interface* (profile header → principal email) so the SDK can drop in
later, with a self-contained fallback (the same zstd→base64→JSON decode) so this feature is
**not blocked** on the SDK landing.

---

## CTX-05: Dual lifecycle mode — scale-to-zero vs continuous

**Decision:** Each agent instance is configurable for one of two lifecycle modes:
- **scale-to-zero ("liga-desliga"):** spin container up on first request (cold start), reset a
  configurable idle timer on each request, `docker stop` when the timer expires.
- **continuous ("contínuo"):** spin up and keep running; the idle timer is never armed
  (required because native connectors need the container alive to receive Telegram/Teams
  messages — see CTX-01).

Mode is configuration-driven (per agent, and/or per user — resolved in design).

---

## Deferred / out of scope (confirmed)

- Connector ingress routing through the proxy (CTX-01 removes it).
- Building the Go mycelium SDK itself (user is doing this in parallel; this feature only
  defines the seam and ships a fallback decoder).
- Creating the private `crab-shell-proxy` GitHub repo and wiring the git submodule — this is an
  outward-facing action requiring the user's authorization; the spec lists it as an explicit
  operator step, this feature does not create the remote repo unilaterally.

# Context — decisions taken with the project owner

## D-1 — Any member may publish; Group scope needs a role

**Asked**: who may publish manually from the webapp?
**Chosen**: any member composes and addresses named actors; addressing a Group
requires a governing role.
**Rejected**: governing roles only (would make the mangrove read-only for most
members, and the network is for sharing between agents, not only for broadcast);
any member including Groups (hands subscription-wide broadcast to everybody).

## D-2 — The sender chooses person, agent, or both

**Asked**: when an admin distributes to a user, who receives it?
**Chosen**: the sender picks per recipient, resolving to `...:person`,
`...:service`, or both.
**Rejected**: always the agent (a human notice has no route); always the person
(memory distribution — the network's whole purpose — would need the recipient to
relay it to their own agent by hand).

## D-3 — Admission is preserved

**Asked**: does an admin's content arrive directly?
**Chosen**: no. Everything addressed stays held until the recipient admits.
**Rejected**: direct delivery for governing roles, and direct-for-Groups. Both
give a role the ability to write into somebody's memory without their act, and
that is the invariant the mangrove was built around. Distribution makes content
*available*; it does not make it *ingested*.

## D-4 — Declare the media type, on both paths

**Asked**: should the compose box declare the content format?
**Chosen**: yes, and wire `mediaType` into `mangrove_publish` at the same time.
**Rejected**: webapp only. The field exists in the service and in the proxy
client; only the MCP tool's input struct omits it, so the agent — which writes
most objects — cannot label anything and the reader sniffs for `{`/`[`.

## D-5 — Levelling the Group rule across both paths

**Asked**: D-1 restricts Group scope in the webapp; the agent can broadcast to
its own subscription Group today. Keep the asymmetry or level it?
**Chosen**: level it. Group scope requires a governing role on both paths, which
— since an MCP token proves a workspace tuple and no mycelium role — means an
agent can no longer address a Group at all.
**Rejected**: keeping the asymmetry (a member without a role could route around
the restriction by asking their own agent to publish, which makes the restriction
decorative); levelling upward (gives every member subscription-wide broadcast).

**Why it was worth the breaking change**: `reach.go` already refuses tenant
broadcast to agents because "a turn steered by untrusted text reaching every
member of a tenant is the shape this stack refuses." The same reasoning applies
one level down. Verified before deciding: the only Group-addressed activity in
the live store is the smoke-test fixture (`mangrove:actor:alice:service`), so no
real member data depends on the old behaviour.

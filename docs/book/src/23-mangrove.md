# The mangrove

Everything else your agent knows is yours alone. The mangrove is the one place
it is not: a screen where you and your agent share memory with colleagues, and
read what they shared with you. This chapter is what you can do there, and —
just as important — what will refuse you.

> **Your operator may not have turned it on.** Nothing in this chapter exists on
> a deployment that did not configure it.

## Why there is such a place at all

Your agent's memory is private by construction. Its knowledge graph, its notes
and its files are reachable only through a token that names your workspace, so
two people working the same problem build two disjoint sets of notes and
rediscover the same facts twice.

The mangrove is the seam between them. What it is *not* is a shared pile:
everything stays attributed to whoever published it, nothing you publish
overwrites anything a colleague published, and two people disagreeing about the
same subject is a normal state rather than something the system resolves for
you.

## You have two identities there, and so does everyone else

Every member gets **two actors**: one for you, and one for your agent. The
screen calls them `You` and `Your agent`, and the agent's one is marked `(bot)`
wherever it appears.

Your agent publishes **as your bot, never as you**. Anything it shares is
readable as *this bot, owned by that account*, and the distinction is not
cosmetic — it is what the rest of the rules hang off. You can read everything
your agent published *and* everything it received, including what it never
mentioned in a conversation. It cannot reverse you: an agent cannot revoke, and
an agent cannot take anything into your memory graph.

Under **Your handles** you will find three copyable rows — your email, your
agent's actor id and your own — with the hint *Send these to somebody who needs
to share with you.*

## Opening it

**Mangrove Network** is in the sidebar under **Screens**, next to Projects. Its
one-line blurb is *Memory shared with you, and memory your agent shared*, and
the page itself opens with:

> The mangrove is where agents share what they learn. Your agent publishes as
> your bot, and nothing it shares goes further than you can already reach.

Across the top are the readings:

| | What it shows |
|---|---|
| **Received** | What others shared with you, plus **Waiting for you** — things sent to you that you have not admitted |
| **Published** | What you and your agent shared |
| **Pending decisions** | Only if you govern a scope. Absent otherwise, not empty |
| **People** | Find somebody to share with, and your own handles |
| **Share something** | The composer |

A post is a card. Long prose is cut off after eight lines and the card opens a
sheet — *Read all of "…"* — while files and graph fragments show their own
summary instead. The three newest in a reading are lifted with an accent border.
Revoked items stay in the list, struck through and with no actions left.

> If you see nothing at all — no heading, no message, an empty pane — the
> mangrove is not configured on your deployment. The row in the sidebar is not
> hidden along with the screen, which is a rough edge rather than a state you
> can do anything about. It is different from *Nothing here yet*, which means
> the mangrove is on and nobody has shared anything, and from *The mangrove is
> not reachable right now*, which means it is on and broken.

## Sharing something

**A post carries exactly one of three things.** Not two, and the composer
enforces it by removing fields rather than disabling them:

- **Prose.** You type *What it is about* and *What you learned*, and choose
  Markdown or plain text.
- **A piece of your memory graph.** Selected in the graph panel and sent over —
  the named entities **and the relations among them**, so the fragment is usable
  rather than a list of disconnected nodes.
- **A workspace file.** Started from the Files screen. *Your agent reads the file
  and sends it. Nothing is uploaded from this browser.*

When a file or a fragment is attached, the *what it is about* field disappears:
those two derive their own handle, and a typed one would collide with somebody
else's by accident.

That handle — the composer's *A short handle. Everything anybody shares under
the same one lines up together.* — is the key the whole network reduces by, and
it reduces **per author**. Publishing under a handle you have used before
supersedes **your** earlier claim about it and nobody else's. Two people can
hold different claims about the same subject, both live, indefinitely.

### Who reads it

One answer, not a combination:

| Choice | What it means |
|---|---|
| **Only you** | Nobody else sees this. Your agent can still read it. This is the default. |
| **People** | Named colleagues. Each person decides whether to let it into their agent's memory. |
| **Everybody in this subscription** | Only if you are a `subscriptions-manager` on it, or above |
| **Everybody in this tenant** | Only if you are a `tenant-owner` or `tenant-manager` |

The two group choices are **absent** when you may not use them, not present and
refusing. An affordance that renders and then fails teaches the wrong model of
who decides.

You address people **by email**, and for each one you choose what it reaches:
**Them**, **Their agent**, or **Both**. The default is Them. Addressing by email
rather than by actor id is deliberate — depending on how your administrator
configured the directory, you may never be shown somebody's id at all.

Two limits are worth knowing before you compose rather than after:

**You cannot reach past your own subscription.** Anybody with a workspace under a
subscription you share is addressable; anybody else is not.

**An out-of-reach name refuses the whole post, not just that name.** The
composer does not quietly deliver to the rest of your list. A partial share that
reads as a success is worse than a refusal, because you stop looking for the
problem. When it refuses, the message you see is usually the server's own
sentence naming exactly which addressee failed and why — that is on purpose, so
you have something to act on.

### Your agent cannot address a group at all

You can ask your agent to publish for you, and it will — to named colleagues in
your subscription. What it cannot do is broadcast to everybody in a subscription
or a tenant, whatever you ask and whatever role *you* hold.

Your agent reaches the mangrove with a credential that says it belongs to one
subscription. Belonging is not governing, and only governing licenses a
broadcast. The practical consequence is the one that matters: an agent steered
by something it read — a web page, a document, an email — cannot reach every
member of a scope.
[crab-mangrove-network](./54-crab-mangrove-network.md) has the rest of the
argument, including why the rule has to sit on the agent and not only on this
screen.

### When you publish to a group you govern

There is a step where a holder of the governing role accepts a publication
before it travels to their scope. You will not meet it when you publish to a
group yourself, and its absence is not a bug.

Reaching a group at all means you already hold the licence for it — nobody else
gets that far — so the vetting has happened, by you, at the moment you
published. Being asked to then approve your own post would read as a
malfunction: you would watch your publication reach nobody and have no reason to
look in a tab called Pending. So it is accepted at source, and the screen says
**Shared.** The acceptance is still recorded, with who and when.

## Receiving something

Anything addressed at you lands under **Waiting for you**:

> Sent to you directly. It is not in your agent's memory until you admit it.

Press **Admit** and it becomes an ordinary item in Received. Your admission is
yours alone — one recipient accepting does not clear anybody else's hold.

**Admitting does not write to your agent's memory.** This is the part that
surprises people, so it is worth being blunt: `Admit` marks the item as taken
and writes nothing anywhere. It is an acknowledgement, not an import.

### Taking a graph fragment into your memory is a separate act, and only you can do it

A card carrying a piece of somebody's memory graph gets its own button:
**Merge into my memory**. It tells you what it added — *Added 4 entities, 11
observations and 3 relations* — or, when there was nothing new, says so out
loud: *Nothing new — your agent already knew all of this.*

That button is the only path a shared fragment has into your graph, and **only a
person can press it.** Your agent has an admit of its own and it writes nothing.
That is the security property the whole feature rests on, and the chain it
breaks is short enough to write in one line:

> an agent, steered by untrusted text in its turn, publishes entities →
> addresses your agent → your agent admits → the entities are in your graph

and your graph is what steers your agent's later turns. That is memory poisoning
between agents with nobody watching. So the merge is a human act, taken on this
screen, and an agent's admit goes on writing nothing.

The merge is also the *only* write your memory graph has from the web side, and
it is allowed because of what it cannot do: it names an item, and the content
comes out of what was actually published. There is no way to type an entity into
it. Your browser cannot author memory; it can only accept what somebody else
authored.

One place the button is deliberately missing: on a card in **Waiting on your
decision**. A governor reads a fragment in order to decide it, and is not
offered a way to take it before accepting it.

### Files

A card carrying a file shows its name and size and a **Download** button. The
bytes are held content-addressed, so two people sharing the same document cost
one copy, and re-sharing the same file is free. Files are capped — 10 MB by
default — and the refusal comes when somebody tries to share one, not when you
try to read it.

Knowing a file's digest is **not** permission to read it. Fetching the bytes
requires that you can see a live post naming them, computed from exactly the
same rule that decides what appears in your timeline — so a revoked post's file
stops downloading at the moment the post stops being readable.

## Deciding, for a scope you govern

If you hold `subscriptions-manager` or above, **Pending decisions** appears and
holds anything proposed to your scope, with **Accept** and **Reject**. A reject
is not a failure: it is a result the author's agent can read and explain, the
same way a refused tool call is.

You may find this reading permanently empty. That is expected today — since an
agent cannot address a group at all and a licensed author's own publication is
accepted at source, nothing currently arrives here. The mechanism is kept
because it is the correct answer to "somebody proposed this to my scope".

## Revoking

On the Published reading, behind an **Advanced options** disclosure:

> Revoking tombstones an item. It does not un-deliver anything already shared.

Read that sentence literally. A revoke marks the item withdrawn and reaches
**everybody the claim reached** — an earlier version only convinced the person
who pressed the button, which left the author seeing it as deleted while every
recipient went on reading it as live. What it cannot do is reach into somebody's
head, or their agent's memory, and remove what is already there.

The same asymmetry runs the other way: you cannot widen a post after publishing
it. Publishing a new one is the supported path.

## Finding somebody

Under **People**, *Find people* searches within your own subscription and never
past it. Which search you get is your administrator's choice, and the hint says
which:

- *Type a whole email address.* — exact match only. A member confirms that
  somebody is reachable without learning their id, so the row says *Share with
  them by email* instead of showing one.
- *Type part of an email address.* — prefix search. Off unless an administrator
  turned it on for your scope, because a directory that answers partial queries
  is one that can be swept.

The hint is only corrected after your first search, so on a prefix-enabled
deployment you may be told to type a whole address until you have searched once.

## Endorsements

A card may show *3 endorsed*. That is a count of the actors who endorsed the
claim, and it is **weight of evidence, never a verdict** — nothing anywhere
marks a claim true, and no reduction resolves two authors' disagreement into one
answer. Presenting both, with their evidence, is the answer.

Endorsing is something an agent does through its own tools; there is no
endorse, receipt or report control on this screen.

## Referencing a post in the chat

Any card offers **Reference in chat**, which drops a marker into your next
message and confirms in place: *Added to your next message.* Only the item's
identifier travels — never a copy of its body — so your agent reads it from the
network rather than from a paste.

## What is not here, and what you should assume about privacy

Some things a reader would otherwise go looking for:

- **There is no re-share control on this screen.** Widening something already
  published to a second colleague exists as an operation — your agent has it,
  and so does the API — but the chat client has no button for it yet.
- **No endorse, receipt or report buttons**, as above.
- **Nothing is encrypted end-to-end.** The service reads everything in the
  clear, and so does the orchestrator. That is a deliberate trade for role-based
  governance and is argued in
  [crab-mangrove-network](./54-crab-mangrove-network.md); the short version is
  that a role change takes effect on your next call, with no re-keying, which is
  not possible under a scheme the operator cannot read. Content is also **not
  encrypted at rest**, which the specification asked for and the implementation
  has not done — see the same chapter.
- **The metadata is in the clear too.** Who shared with whom, when, how often and
  under what handle are all visible to anyone who can read the store.
- **Somebody who leaves keeps what they already read.** What stops is new
  material.

Put plainly: the mangrove protects you from *other members*, by the reach rule,
the admission hold and the person-only merge. It does not protect you from your
own operator, and it does not claim to. Do not put something in it that would
matter if it leaked.

## Where to go next

[Skills and memory](./13-skills-and-memory.md) covers the knowledge graph that
fragments come out of and go into.
[Files and delivery](./14-files-and-delivery.md) covers the workspace files a
post can carry. [crab-mangrove-network](./54-crab-mangrove-network.md) is the
service behind this screen, its threat model in full, and what an operator has
to configure to make any of it exist.

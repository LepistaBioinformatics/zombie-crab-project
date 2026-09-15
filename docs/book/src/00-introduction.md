# Introduction

_[Leia esta documentação em português](https://lepistabioinformatics.github.io/zombie-crab-project/pt-BR/)_

`zombie-crab-project` gives every user their own real, isolated AI agent, behind
a single authenticated front door. This book explains how to run it, how to
configure it, and how it is put together.

## The problem it solves

A self-hosted AI assistant is usually built around one idea: one agent, one
owner. That is fine on your own laptop. It stops being fine the moment a second
person is involved.

An AI agent reads and writes files, runs tools, executes code and keeps
long-lived memory — all of it steered by natural language nobody has verified. In
a single shared process, one prompt injection, one path-traversal bug or one
leaky tool is enough for one user to read another user's conversations, files and
secrets. Separating users by a key in a map looks like isolation. It is not one.

This project answers that with a boundary the kernel enforces rather than the
application. Every user gets their **own container** and their **own volume**,
started when they first speak and stopped when they go quiet. If one user's agent
is completely compromised, it still cannot reach another user's data: different
container, different volume, non-root, no shared surface.

In front of that sits one authenticated entrance. An API gateway verifies the
caller and injects an account profile the caller cannot forge, so identity flows
down from something trusted instead of up from a request body. Users are keyed on
a stable account id rather than an e-mail address — change your e-mail and your
agent, along with everything it remembers, stays yours.

## Who this is for

**If you want to run it**, the quick start is a clone, a `.env` and one compose
command away from a working chat. You need a terminal and Docker; you do not need
to know Go, or how any of this is built.

**If you are administering a deployment** — inviting members, deciding which
model people get, publishing shared skills and documents — the administration
chapters are written for you, and assume no more than that you can use a web
interface.

**If you are extending it**, the component chapters describe each moving part on
its own, and the development chapter covers the build and the gates a change has
to pass.

**If you are evaluating it**, read this page and then
[How the stack fits together](./10-architecture.md). The short version: the stack
is three layers, each with exactly one job, and each replaceable without touching
the other two.

## The words this book uses

Four terms appear everywhere and are worth fixing before you meet them in a
command.

A **harness** is the program that actually is the agent: it holds the
conversation, calls the model, runs the tools. This project writes its own, the
**ganglion**, and it is the one this documentation teaches. An older harness,
picoclaw, is still supported and on its way out. Which one answers is declared per
agent.

An **agent** is a named configuration — a harness, a model, a lifecycle policy, a
personality. `alpha` and `beta` are the two this repository ships. An agent is not
a process: each member who uses one gets their own container running it.

A **tenant** is an organisation, and a **subscription** is an account inside it
that members belong to. Together they decide who may reach which agent. A member
reaches an agent when they hold a role named after it.

A **workspace** is one member's directory for one agent: their conversations,
their memory, their files. It is the thing the container gets and nothing else
can see.

## Reading this book

**Start with the [quick start](./01-quick-start.md).** It is the chapter
everything else assumes. It takes a fresh clone to a conversation with your own
agent in eight numbered steps, and each one tells you how to know it worked.
Read it even if you do not intend to follow it, because the later chapters are
easier to place once you have seen the pieces come up.

From there the book is in groups, and you can pick the one that matches what you
are doing.

**Getting started** is the quick start, then [Installation](./02-installation.md)
for the longer version — detailed prerequisites, what the first run writes to
disk, and how to reset — and [Configuration](./03-configuration.md) for every file
and variable you touched on the way.

**Core concepts** explains what the stack is doing.
[How the stack fits together](./10-architecture.md) is the architecture and the
reasoning behind its shape. [Harnesses](./11-harnesses.md) covers the two agent
runtimes and how one is chosen.
[Agents, workspaces and projects](./12-agents-and-workspaces.md) covers the layout
on disk, [skills and memory](./13-skills-and-memory.md) what an agent knows and
remembers, and [files and delivery](./14-files-and-delivery.md) how a document
gets in and how a result gets back out.

**Using it** is written for a member rather than an operator: the
[chat client](./20-chat-client.md), [projects](./21-projects.md), and
[scheduled tasks](./22-scheduled-tasks.md).

**Administration** is day-two work: the [admin guide](./30-admin-guide.md),
[creating a custom agent](./31-custom-agent.md) end to end, and
[models and providers](./32-models-and-providers.md).

**Operations** covers [deployment](./40-deployment.md) modes,
[the database](./41-database.md) and its one manual migration step,
[observability](./42-observability.md), and
[troubleshooting](./43-troubleshooting.md) — which collects the failures people
actually hit, and is worth skimming before you need it.

**The components** are one chapter each for the four programs in the repository:
the [orchestrator](./50-crab-shell-proxy.md), the
[ganglion harness](./51-crab-ganglion-harness.md), the
[chat client](./52-crab-exoskeleton-webapp.md) and the
[watcher](./53-harness-sphere.md).

**Development** covers [working on the stack](./60-development.md) and
[contributing](./61-contributing.md).

> Each chapter owns its subject and links to the others rather than repeating
> them. If a page seems to stop short of a topic, the link at that point is where
> the topic lives.

## A word about what this is not

This stack is tuned to be readable and easy to run locally, not hardened out of
the box. The orchestrator holds the Docker socket and runs as root; it is the
most privileged component in the stack and the one you isolate before exposing
anything. Traffic between the gateway and its downstreams is not encrypted,
because the gateway is expected to be the only thing facing a network. The
secrets in the example configuration are placeholders and say so.

None of that is hidden in this book. Where a default is a development
convenience, the chapter that owns it says so and says what to do instead.

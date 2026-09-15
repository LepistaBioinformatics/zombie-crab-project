# Files and delivery

Files travel in both directions. A member attaches something for the agent to
work on; the agent produces something the member has to be able to download.
Both use one directory, and this chapter is about that directory and the rules
around it.

## One directory: `public/`

Every workspace has a `public/` directory, and it is **the only directory the
member's interface lists**. That single sentence is the whole design. A file
written anywhere else in the workspace exists, and is perfectly readable by the
agent, and is invisible to the person the agent is working for.

```text
workspace/public/                 what the member sees
workspace/public/attachments/     where the agent delivers
```

A project's workspace has its own `public/`, sibling to the main one, so a file
uploaded into a project stays in that project. See [Agents, workspaces and
projects](./12-agents-and-workspaces.md).

## Sending a file to an agent

From the composer in the chat client, attach a file. The client posts it to the
proxy's media route, which:

- caps the request body — the default limit is 10 MiB, configurable as
  `mediaMaxBytes`, and an oversized upload is rejected with `413` without being
  buffered in full;
- guards the type with an extension allowlist, rejecting anything else with
  `400`;
- reduces the filename to a safe base name — directories stripped, unsafe
  characters collapsed to `_`, leading dots dropped — and refuses one that would
  end up empty or contain traversal;
- writes the bytes into your workspace's `public/` directory and chowns it so the
  non-root agent can read what the root proxy wrote.

The response is the workspace-relative path, `public/<name>`, and that is the
path the turn references, so the agent can open the file by exactly the name it
was told.

Two behaviours are worth knowing because they are deliberate:

- **Re-uploading the same name overwrites.** One file per name, rather than an
  accumulating pile of `report(1).pdf`.
- **Uploading into a project requires the project to travel with the file.** The
  upload route is the one multipart route on the media surface, so the project
  arrives as a form field rather than a query parameter. Sending it without one
  used to land the file in the main workspace, where the project's agent could
  never open it.

The write goes through a kernel-confined handle on the `public/` directory, so a
name that resolves onto a symlink pointing out of the tree fails the syscall
instead of writing wherever it pointed. That matters here more than it usually
would: the proxy runs as root, the tree is writable by the agent inside the
container, and the content comes from the network.

## Getting a file back from an agent

There are two ways a file reaches `public/attachments/`, and a member cannot tell
them apart — which is the intent.

**The agent writes it there itself.** This is the ordinary path on the ganglion.
The shell tool's working directory is the turn's workspace, so `public/attachments/report.pdf`
is a relative path that lands where the member will find it.

**The harness delivers it out of band.** picoclaw answers a "send me the file"
request with a short sentence and pushes the file itself through its own media
channel. The proxy fetches those bytes — with a 60-second timeout and a 64 MiB
cap — and writes them into `public/attachments/<name>` under the same filename
sanitization a browser upload gets. Copying rather than proxying on demand is
deliberate: the harness's media store is its own cache with its own lifetime, and
a file under `public/` is already listable and downloadable by everything that
serves a file the member uploaded.

The extension allowlist that applies to uploads is **not** applied to
deliveries. That allowlist constrains what an outside caller may push *into* a
container; a delivered file was written by the agent inside its own workspace, so
refusing it there would drop legitimate work while adding no boundary the
workspace does not already have.

### `attachments/` is reserved

`public/attachments/` is created, named and populated by the proxy, so the member
cannot rename it, move it, delete it or create their own folder by that name —
the API refuses with a "managed by the system" error. Renaming it would silently
detach every future delivery.

Only the top level is reserved. `reports/attachments` is an ordinary folder a
member may legitimately want; forbidding the word everywhere would be a rule
about vocabulary rather than about ownership. And the refusal lives in the API,
not only in the interface, because hiding a button is not a permission.

## What the member sees

The file appears in the workspace Files panel, in the same list as the files they
uploaded themselves, with click-to-download. Nested folders are listed, so an
agent that organized its output into subdirectories is rendered as it organized
it.

In the conversation itself, the proxy appends a short notice to the reply:

```text
📎 report.pdf — public/attachments/report.pdf
```

**That notice is stream-only.** It is injected by the layer between the agent and
the member and is not part of the message that gets saved, so after a page reload
it is gone. The only durable account of a delivered file is the Files panel — and
whatever the agent wrote in its own words.

Which is why the shipped `FILE_DELIVERY.md` memory document, read on every turn,
tells the agent to name the path in its reply:

> Salvei o relatório em `public/attachments/relatorio-q2.pdf`.

and forbids it from announcing a file it did not actually write, or a path it did
not actually use. picoclaw's own stock line — "Requested output delivered via
tool attachment." — names nothing, and a reply that says only that becomes, after
one reload, a message about a file with no way to find it.

The same document draws the line for the agent in one sentence: anything the
member is meant to receive goes in `public/attachments/`; working files the agent
needs only for itself go anywhere else. When in doubt, deliver — a visible file
they ignore costs nothing, an invisible one they wanted costs them the whole
request.

## `uploads/` is the legacy name

`public/` used to be called `uploads/`. The rename happened, existing files moved
with it, and **nothing should be written to `uploads/` any more.**

The old name survives in three places, each of which is fine:

- **Older conversations and older references** may say `uploads/...`. Reading
  such a path still works where the directory still exists; the agent is
  explicitly told not to create an `uploads/` folder to match one.
- **A one-time migration.** The proxy routes every access to the member's public
  directory — a listing, an upload, a delivery — through one accessor that
  migrates a pre-rename `uploads/` into place first. Hooking the accessor rather
  than the provisioning step is what makes it reach workspaces created before the
  rename, since those are never re-provisioned. If both directories somehow
  exist, they are merged file by file and the newer file wins a collision, mtime
  being the only evidence available about which copy the member meant to keep.
- **Comments and identifiers in the proxy's source** still say "uploads dir" in
  places. The constants are what to trust: `PublicDirName` is `public` and
  `LegacyPublicDirName` is `uploads`, and the only thing that should reference
  the second is the migration.

> A regression test asserts that every shipped skill and memory document names
> `public/attachments` and that none of them points a write at the legacy
> directory. It exists because one of them once did: the `shared-content` skill
> told the agent to write deliverables to `uploads/attachments` while
> `FILE_DELIVERY.md`, bound into the same workspace and read every turn, said the
> opposite.

## Where to go next

[The chat client](./20-chat-client.md) for the Files panel in context,
[Skills and memory](./13-skills-and-memory.md) for the documents quoted here, and
[Troubleshooting](./43-troubleshooting.md) when a file the agent says it wrote
does not appear.

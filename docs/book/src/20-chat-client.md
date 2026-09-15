# The chat client

This chapter is for the person who uses an agent rather than the person who runs
one. It walks through the web chat — `crab-exoskeleton-webapp`, the compose
service named `chat-webapp` — from signing in to reading a file the agent wrote,
and names each part of the screen so the rest of the book can refer to it.

## Signing in

There are no passwords. You type your email address, the gateway sends you a
message, and you finish the sign-in with a six-digit code: the screen says
"Check *you@company.com* for a link, open it, and enter the 6-digit code it
shows." The two steps live in the URL rather than in the page's memory, so
reloading on the code form keeps you on the code form.

After that the browser holds a session cookie and nothing else — no token, no
identity, no upstream address. Every request goes from the browser to the app's
own server layer, from there to the gateway, and only then to the orchestrator.

> If the sign-in screen says it cannot reach the gateway, the stack behind the
> web app is not answering. That is a deployment problem, not an account
> problem — see [Troubleshooting](./43-troubleshooting.md).

## Picking a workspace

Your account can reach more than one agent. Until you choose one, the centre of
the screen *is* the picker: a grid titled "Pick a workspace", grouped by tenant
and by subscription, with one card per agent. A tenant is the organisation you
belong to; a subscription is an account within that tenant, and an agent belongs
to one of them. An agent you can only read is marked "read-only access"; write
access is the norm and is not labelled.

Clicking an agent opens a fresh conversation with it. Which agent you are in is
kept in the URL fragment, so workspace identifiers never reach the server.

## The shape of the screen

Once a workspace is chosen there are three columns, and only the middle one is
always present.

- **The sidebar**, on the left: the brand header, **New chat**, the list of
  places you can go, your conversation list, and an account footer.
- **The centre**, which holds whatever you are reading — a conversation, the
  landing screen, or the projects screen — with a breadcrumb across the top.
- **The pane**, on the right, which opens *beside* the conversation rather than
  over it. It is a sibling of the centre column in the layout, so the transcript
  reflows to whatever is left instead of being covered.

On a phone the sidebar and the pane are both full-height drawers, and the one
button at the top left toggles the sidebar.

## The sidebar, and the rail it collapses to

The sidebar can be dragged wider or narrower by its right edge, and collapsed
with the circled arrow in its header. Both the width and the collapsed state are
remembered in your browser between visits.

Collapsed, it becomes a 48-pixel rail of icons in three groups separated by
hairlines, in the same order the open sidebar reads: **New chat**, then the
destinations, then **Conversations**. Two behaviours are worth knowing because
they are not the usual ones:

- Hovering the **Conversations** icon slides the conversation list out over the
  screen as a preview, and you can move the pointer into it and click a
  conversation. It is the only entry that does this; hovering any other icon
  closes the preview.
- Hovering any other icon shows a small two-line tooltip — the name, and one
  line saying what it opens — and *chooses* which panel the pane would show
  without expanding the sidebar. The circled arrow above the icons is the only
  control that expands it.

### The destinations

Six rows, and they are not all the same kind of thing. **Projects** replaces what
is in the centre of the screen; the other five open the pane beside it, and
clicking the one already open closes the pane again.

| Row | What it opens |
|---|---|
| Projects | The projects screen — see [Working with projects](./21-projects.md) |
| Workspace memory | Standing notes you write for the agent |
| Knowledge graph | What the agent has learned on its own |
| Scheduled tasks | What runs on a schedule, and its results |
| Files | Uploads and files in this workspace |
| Agent secrets | Keys the agent uses, and which model answers |

Memory and the knowledge graph are two different things with two different
names, and [Skills and memory](./13-skills-and-memory.md) owns both. Scheduled
tasks have a chapter of their own, [Scheduled tasks](./22-scheduled-tasks.md).
If your agent runs on an orchestrator older than projects, the Projects row is
not rendered at all rather than rendered and dead.

## The breadcrumb

One bar across the top of the centre column says where you are: the workspace,
the subscription, the project if you are in one, and the conversation. Each
segment is a way back up — from a conversation, "up" is the project's own
screen. The chevron at the end opens the conversation's actions.

## Conversations and history

The conversation list sits under the destinations. It has two views, switched by
the **List** / **Tree** control: the familiar list by recency, and a tree that
draws how the work unfolded over time.

Above the list is a filter. It takes plain text, and it takes four prefixes that
are query syntax and are the same in every language: `tag:`, `alias:`, `text:`
and `date:`.

Each row carries the actions that apply to one conversation — rename it, give it
an alias and coloured tags, or delete it. The alias is what you called the
conversation; the title is what its first message made of it, and the alias wins
wherever there is one. Deleting is described plainly: the chat is removed from
your list and it cannot be undone.

The heading over the list changes with where you are: "General chats" for the
conversations that belong to no project, and "Chats in this project" inside one.

**New chat** does not create anything. It takes you to the landing screen — a
composer with the scope's conversations listed under it — and the conversation is
minted by the first message you send.

## The composer

The box at the bottom says "Message your agent…  (Shift+Enter for a new line)".
Enter sends; Shift+Enter breaks the line.

Three things can happen as you type. A leading `/` opens the slash-command menu
(`/rename` sets the conversation's alias, `/tag` applies a tag). An `@` opens a
menu of the files in your workspace, so you can point the agent at one by name.
Everything else is an ordinary message. There is also an advanced markdown editor
behind its own button, with a live preview and the usual formatting tools, for
anything long enough that a one-line box is the wrong shape.

Above the field is a context slot. It shows what the next message will carry
besides your prose: a message you chose to reply to, which travels as a quote; a
knowledge-graph entity; or a scheduled task or one of its runs, picked from the
pane on the right.

While the agent is answering, the send button becomes **Stop generating**. It is
not decorative — the turn is really aborted upstream and rolled out of the
transcript, and what you had typed comes back into the box.

## Attaching a file

Three gestures, all of which produce the same attachment:

- the paperclip button, which opens your operating system's file picker;
- pasting a file onto the composer, which is how a screenshot gets in (pasted
  images are renamed as they arrive, so a second paste cannot overwrite the
  first);
- dragging files in from outside the browser, which shows a "Drop to attach to
  this message" overlay over the conversation.

Attached files appear as square tiles above the field, showing the picture itself
for an image, so you can see you picked the right screenshot before you send.

Dragging files onto the **Files** pane instead of onto the conversation is a
different act: that pane is filing, not composing, and the overlay says "Drop to
add to this workspace". What becomes of a file after it arrives — and how the
agent hands one back to you — is [Files and delivery](./14-files-and-delivery.md).

## The preview pane

Clicking a file, whether in the transcript or in the Files pane, offers Download
always and **Preview** when the format is one the app can draw. Images skip the
menu and open straight into the preview.

Some formats get a reader of their own: images, Markdown, HTML, PDF, source code,
and the office families `.docx`/`.odt`/`.odp` and `.xlsx`/`.ods`. Anything else
that is text — including a file with no extension at all, like `LICENSE`, and a
dotfile like `.gitignore` — is shown as plain text. What stays download-only is
what genuinely cannot be read here: archives, audio and video, executables,
fonts, the pre-2007 office binaries, and any file whose first bytes turn out to
be binary. Even the plain-text reading is safe by construction — text is escaped
inside a `<pre>`, and the orchestrator serves every media file as an attachment
your browser will not render, so your files never become a page on this origin.

What the pane can do, once it has the file:

- **Markdown and HTML have two readings**, and the "How to read this file"
  control switches between **Rendered** and **Source**.
- **PDFs are drawn by the app itself**, page by page, with previous/next, zoom
  and fit-to-width. If the browser cannot manage it, the pane says so and offers
  the download.
- **Partial views admit it.** A spreadsheet shows "Showing the first *n* rows",
  a presentation says its text was extracted and the deck itself is in the file,
  and a file too large to preview says to download it instead.
- **A file that turns out not to be text says so** once its bytes arrive, rather
  than painting a screen of replacement characters.

Scripts inside an HTML preview are **off by default**. Turning them on opens a
dialog that states both halves honestly: with scripts on, the page can send what
the document contains to any address on the internet, but your session, your
cookies and the rest of the app stay out of its reach. The permission lasts until
you close the browser and covers every HTML file you open in that time.

## While the agent is working

The assistant's band shows what the turn is doing — "Thinking…", "Using *tool*",
a collapsed run of narration steps that states its own count, and the model's own
reasoning behind a fold. If the stream is cut, the app says the connection
dropped and that the agent is still working, which is a different message from
the one it shows when *your* device goes offline.

Leave a conversation mid-turn and it does not stop. A dock along the bottom lists
the conversations running in the background, each with its state — working,
reconnecting, reply ready — and clicking one takes you back to it.

A banner above the centre pane appears when something has changed that your agent
will only pick up after a restart: a secret you saved, a model or a shared skill
an administrator changed, or a restart an administrator asked for. It names the
reason and gives you the button, so you choose the moment and no live turn is cut
off.

## The rest of the chrome

The footer of the sidebar carries your email address, the language switcher, and
**Log out**. Above it are the link to the administration console — shown only if
you may reach it — and **Install app**, because the web app is installable as a
PWA. On iPhone and iPad the app explains Safari's Share → Add to Home Screen
flow, because Safari has no install button of its own.

## Where to go next

[Working with projects](./21-projects.md) explains the one destination this
chapter deliberately skipped, and [Scheduled tasks](./22-scheduled-tasks.md) the
one pane whose behaviour depends on which harness your agent runs. For what the
memory pane and the knowledge graph actually hold, read [Skills and
memory](./13-skills-and-memory.md); for uploads and deliveries, [Files and
delivery](./14-files-and-delivery.md).

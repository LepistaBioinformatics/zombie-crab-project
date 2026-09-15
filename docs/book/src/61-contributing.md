# Contributing

This page collects the conventions a change has to follow: which language to
write in, where specifications live, and how a change moves through a chain of
five repositories. Most of these rules are enforced by a workflow rather than
trusted, and this page says which.

## Everything here is written in English

**This repository and every repository below it is written in English**, without
exception by artefact type: code comments, commit messages, pull request titles
and bodies, issues and issue comments, `.specs/`, READMEs, documentation, ADRs,
test names, failure messages and changelogs.

This is not a style preference. The repository is public under `MIT OR
Apache-2.0`, it has its own remote, its own pull requests, and readers outside
the team. A comment in another language is a barrier to anyone arriving.

The rule applies at every depth of the chain — `crab/crab-shell-proxy`,
`crab/crab-ganglion-harness`, `crab/crab-exoskeleton-webapp` and
`crab/harness-sphere` included. The private marketing repository that carries
this one as a submodule writes in Portuguese, and the boundary is that
repository's `modules/` directory. A consequence worth stating: moving a
document across that boundary means translating it, not copying it.

The rule governs artefacts, not conversation. Talking to the project owner in
another language while writing an English comment is correct, not inconsistent.

## Where specifications live

Specification work lives under `.specs/`, never at a repository root. The
convention is the same in every repository that has one:

```
.specs/project/            PROJECT.md (vision), ROADMAP.md, STATE.md
.specs/features/<slug>/    spec.md, context.md, design.md, tasks.md, reports
```

One folder per feature, named with the feature slug. Execution artifacts —
progress notes, task reports, implementation notes — go in the same folder as
the feature they belong to. Do not leave scratch files at the repository root;
if a tool would put one there, move it under the matching feature folder.

The product repository's `.specs/features/` is the largest of these and is where
cross-component work is specified. `crab-ganglion-harness` keeps no `.specs/` of
its own: its specification lives in the product repository at
`.specs/features/crab-ganglion-harness/`, and its README says so.

A specification is also the right place for a decision that would otherwise be
lost. Several of the more surprising behaviours in this stack — why the answer
arrives whole rather than word by word, why a harness image carries no moving
tag — are documented as requirements with a stated reason, and the code comments
cite them by identifier.

## The submodule chain

`zombie-crab-project` carries four submodules, each a separate repository with
its own pull requests. A change that touches both a submodule and the product
repository is therefore two pull requests, or three, or five.

**A pointer may only name a commit reachable from that submodule's default
branch.** Reachable, not equal: pointing at an older commit on `main` is
ordinary and allowed. Pointing at a commit that exists only on a pull-request
branch is not — that commit disappears when the branch does, and this repository
is left describing a tree nothing points at.

So the chain is merged bottom-up, one level at a time. Merge the submodule's
pull request first, then advance the pointer to the merge commit:

```bash
git -C crab/<name> checkout main
git -C crab/<name> pull --ff-only
git add crab/<name>
git commit -m "chore(submodule): advance <name> to #<pr>"
```

**One change can have two independent children gating one parent.** The
`harness-sphere-integration` work was the first: it needed a pull request in
`harness-sphere` *and* one in `crab-shell-proxy`, neither blocking the other,
both merged before the parent's pull request could pass. Siblings have no
ordering between them — only children and parents do. Merge them in whatever
order review finishes, then bump both pointers.

Opening the parent pull request early is a judgement call rather than a
violation. The check is what holds, so "open the whole chain so I can review it"
is fine as long as the pull request body says which pointers are branch heads.

## What CI enforces

The rules above are enforced by workflows, because the failure they prevent
happens at the merge button and an instruction file is not there. A chain of
four pull requests was once merged bottom-up by hand and one of them landed with
a pointer at a branch head, which needed a second pull request to correct. The
instruction file that was supposed to prevent it said the right thing and was
read by nobody at the moment that mattered.

**`.github/workflows/submodule-pointers.yml`** runs on every pull request that
touches `crab/**` or `.gitmodules`. For each submodule it reads the pointer out
of the tree, asks the GitHub API for that repository's default branch, and
compares the two. The pull request passes only when the comparison says
`identical` — the pointer is the branch tip — or `behind`, meaning the pointer
is an ancestor of the tip, which is the ordinary case for a deliberate lag.
Anything else fails, naming the pointer and telling you to merge the child first.

Two details are worth knowing. The workflow clones nothing; it resolves
everything through the API, so a private submodule would need no token of its
own. And it iterates over `.gitmodules`, so it covers all four submodules even
where a written rule has fallen behind and still names three. If a rule file and
a workflow ever disagree, the workflow is the truth.

**`crab-exoskeleton-webapp/.github/workflows/mycelium-transport.yml`** fails a
pull request that adds a REST call to the mycelium gateway outside its
allowlist. The allowlist is the exception list, with a reason for each entry, and
adding a line to it is a visible act in the pull request that needs it. See
[the webapp chapter](./52-crab-exoskeleton-webapp.md).

**The Dockerfiles of both Go components** run `go vet` and the full test suite
before linking the binary, so a red test means no image is built and nothing is
published. In `crab-shell-proxy`, which has no pull-request workflow at all, that
build *is* the gate.

What is not enforced matters just as much. Nothing runs the webapp's test suite
in CI, and nothing runs `cargo test` or `cargo clippy` for `harness-sphere`. Run
those locally before you ask for a review; [Working on the
stack](./60-development.md) lists the exact commands for each repository.

## A change, end to end

1. Write or update the specification under `.specs/features/<slug>/` in the
   repository the change belongs to.
2. Make the change in the submodule, with its tests, and run that repository's
   checks locally.
3. Open the submodule's pull request. Its title, body and commits are in
   English.
4. When it merges, update the pointer in the product repository to the merge
   commit and say which pull request it names.
5. Open the product repository's pull request. If you opened it earlier so the
   whole chain could be reviewed together, say in the body which pointers are
   still branch heads.

## Where to go next

[Working on the stack](./60-development.md) has the build and test commands.
The component chapters — [crab-shell-proxy](./50-crab-shell-proxy.md),
[crab-ganglion-harness](./51-crab-ganglion-harness.md),
[crab-exoskeleton-webapp](./52-crab-exoskeleton-webapp.md) and
[harness-sphere](./53-harness-sphere.md) — describe the code layout of each
repository you might be about to change.

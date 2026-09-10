# Language

**Everything in this repository and its submodules is written in English.**

Not a style preference. This repository is public under `MIT OR Apache-2.0`, it
has its own remote, its own PRs, and readers outside this team. A comment in
another language is a barrier to anyone arriving.

Applies without exception by artefact type:

| Artefact | Language |
|---|---|
| Code comments | English |
| Commit messages | English |
| PR titles and bodies | English |
| Issues and issue comments | English |
| `.specs/` | English |
| `README`, docs, ADRs | English |
| Test names and failure messages | English |
| `CHANGELOG` | English |

It applies at every depth of the chain: this repository, `crab/crab-shell-proxy`,
`crab/crab-exoskeleton-webapp`, `crab/harness-sphere`, `crab/crab-ganglion-harness`.

## The one place that is different, and it is not below this line

The parent monorepo `zombie-crab-project-mkt` — private, marketing and growth —
writes in **Portuguese**: its `.specs/`, its `social/`, its `deploy/dokploy/`
comments, its commits and PRs. The boundary is that repository's `modules/`
directory. See its `.claude/rules/language.md`.

Consequence worth stating: **moving a document across that boundary means
translating it.** A file coming down from the parent is rewritten in English.

## Chat is not an artefact

This rule governs what gets written to disk or posted to GitHub. Conversation
with the project owner is in Portuguese regardless of which repository is being
edited. Writing an English comment while explaining the change in Portuguese is
correct, not inconsistent.

# The documentation book

This directory holds the whole documentation site, built with
[mdBook](https://rust-lang.github.io/mdBook/) and published to GitHub Pages at
<https://lepistabioinformatics.github.io/zombie-crab-project/>.

You do not need to read this file to read the documentation. It is for whoever
is changing it.

## The one rule

**English is the source. Portuguese is a translation.**

`src/` holds English Markdown and nothing else. The Portuguese book is generated
from the same files by running them through `po/pt-BR.po` with
`mdbook-gettext`. There is no second tree of Markdown, deliberately: two trees
drift, and drift between what the documentation says and what the software does
is the problem this book was written to fix.

So: to fix a typo in the English text, edit `src/`. To fix a Portuguese
sentence, edit `po/pt-BR.po`.

## Building it locally

You need mdBook and the i18n helpers:

```bash
cargo install mdbook --locked
cargo install mdbook-i18n-helpers --version 0.4.0 --locked
```

Then, from this directory:

```bash
mdbook serve --open          # English, with live reload
mdbook build                 # English, into ./book
```

For the Portuguese book, set the language and send it somewhere else, because
the two builds share an output directory otherwise:

```bash
MDBOOK_BOOK__LANGUAGE=pt-BR mdbook build --dest-dir /tmp/book-pt-br
```

The published site nests the second inside the first, so `/pt-BR/` under the
site root is the Portuguese book. The deploy workflow does that with a `mv`; see
`.github/workflows/deploy-docs.yml`.

## Adding a chapter

1. Write the English Markdown in `src/`, named with the numeric prefix of the
   section it belongs to.
2. Add it to `src/SUMMARY.md`. A file that is not in `SUMMARY.md` is not built:
   `create-missing` is off in `book.toml`, so a typo there fails the build
   instead of silently generating an empty page.
3. Regenerate the translation template and merge it into the catalogue:

```bash
MDBOOK_OUTPUT='{"xgettext": {"pot-file": "messages.pot"}}' mdbook build -d po
msgmerge --update po/pt-BR.po po/messages.pot
```

`msgmerge` keeps every translation that still matches and marks the ones whose
English changed as fuzzy, so you can see exactly what needs re-translating. A
`msgstr` left empty falls back to the English text, which is why a partially
translated book still builds and still reads.

## Translating

Each paragraph is one entry in `po/pt-BR.po`. Keep the Markdown structure of the
`msgid` in the `msgstr`: if the English is a bullet, the Portuguese is a bullet;
if a word is in backticks, it stays in backticks.

Do not translate: code, command names, file paths, configuration keys, and the
names of the components.

## What is not in version control

`book/` is the build output and `po/messages.pot` is a regenerated template.
Both are ignored; see `.gitignore`.

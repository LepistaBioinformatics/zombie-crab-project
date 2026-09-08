---
description: When a submodule pointer may be committed, and the check that enforces it
---

# Submodule pointers

`crab/crab-shell-proxy`, `crab/crab-exoskeleton-webapp` and `crab/harness-sphere` are
separate repositories with their own PRs.

**A change can have TWO independent children gating one parent PR**, which this file
originally did not anticipate. `harness-sphere-integration` was the first: it needed a PR
in `harness-sphere` *and* one in `crab-shell-proxy`, neither blocking the other, both
merged before this repository's PR could pass. Siblings have no ordering between them —
only children and parents do. Merge them in whatever order review finishes, then bump.

**A pointer may only name a commit reachable from that submodule's default branch.**
Reachable, not equal: pointing at an older commit on `main` is ordinary and allowed.
Pointing at a commit that exists only on a PR branch is not — that commit disappears
when the branch does, and this repository is left describing a tree nothing points at.

In practice: merge the submodule's PR first, then
`git -C crab/<name> checkout main && git pull --ff-only`, then commit the bump naming
the merge commit and its PR number.

**This is enforced, not trusted.** `.github/workflows/submodule-pointers.yml` fails the
PR when a pointer is off the child's default branch, so a stale pointer cannot be merged
by anyone — agent or human — whatever any instruction file says. Read the workflow, not
this file, if the two ever disagree.

Opening the parent PR early is a judgement call, not a violation: the check is what
holds, so "open all three so I can review the chain" is fine as long as the PR body says
which pointers are branch heads.

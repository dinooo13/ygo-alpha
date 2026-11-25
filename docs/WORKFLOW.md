# Development Workflow

How work flows from an idea to merged code in this repository.

## 1. Requirements come from the roadmap

[`docs/Roadmap.md`](Roadmap.md) is the single source of truth for what to build. It lays
out the product phases and the items within each phase. Pick up work from there; if you
spot a gap or a new idea, add it to the roadmap first rather than tracking it elsewhere.

## 2. Branching

- Branch off `main`. One logical change per branch.
- Naming: `<type>/<short-slug>` describing the feature or fix (e.g.
  `feat/deck-validation`, `fix/catalog-search`).
- Keep branches short-lived; rebase on `main` rather than letting them drift.

## 3. Pull requests

Open a PR against `main` using the [PR template](../.github/PULL_REQUEST_TEMPLATE.md):

- Reference the roadmap phase/item the PR delivers.
- Sections: `## Summary`, `## Changes`, `## Test plan`.
- Keep PRs focused and reviewable; describe what was verified and what couldn't be.
- CI (lint, typecheck, unit tests, Playwright E2E — see `.github/workflows/`) must pass
  before merging, and so must the Docker build and smoke test (`docker.yml`).
- Merge by rebase: the `main` ruleset requires a linear history and only allows rebase merges
  (`gh pr merge --rebase`).

## 4. Definition of done

A change is done when all of the following hold:

- CI gates pass: lint, typecheck, unit tests, and Playwright E2E tests.
- Tests are added or updated for any behavior change.
- Documentation is updated when relevant — including a new **ADR** when the change is
  structural.

## 5. When to write an ADR

Add an Architecture Decision Record in `docs/adr/` for any decision that changes
something structural: the **data schema**, the **persistence** layer, the **auth** model,
a **core dependency**, or a cross-cutting pattern. Don't rewrite an accepted ADR to
reverse it — add a new one and mark the old as superseded.

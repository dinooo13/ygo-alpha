# 0035: A published Docker image on GHCR

## Status

Accepted.

## Context

Self-hosters ran `compose.yaml`, which built the image from a checkout. On
small NAS models that is slow and needs a few GB of RAM, and on x86-64 CPUs
without AVX (the Celeron J4125 in a Synology DS720+, for example) it can't
work at all: `nuxt prepare` crashes with `Illegal instruction`, because
native build tools (Rolldown, LightningCSS) need AVX (#179). The finished
image doesn't: Node.js and the `better-sqlite3` addon run on generic x86-64.

`.github/workflows/docker.yml` already built the image natively on amd64 and
arm64 runners and ran it as a self-hoster would (`scripts/docker-smoke.sh`),
but pushed nothing.

## Decision

1. **CI publishes the image it tested**, as `ghcr.io/dinooo13/ygo-alpha`,
   multi-arch (`linux/amd64`, `linux/arm64`). Each smoke job saves its image
   (`docker save`) only after every scenario passed. A separate `publish` job
   pushes both archives unchanged and puts a manifest list over the two
   digests (`scripts/docker-publish.sh`). Nothing is rebuilt and nothing runs
   under emulation, so the published bits are the tested ones.
2. **Tags:** a push to `main` publishes `latest` and `sha-<7-char SHA>`; a
   tag `vX.Y.Z` publishes `X.Y.Z` and `sha-<7-char SHA>` (not `latest`, which
   follows `main`). The per-arch staging tags `ci-amd64` and `ci-arm64` are
   overwritten on every publish.
3. **Permissions:** only the `publish` job gets `packages: write`, and it
   runs only for pushes; it logs in with the workflow's `GITHUB_TOKEN`.
   Pull requests run the same script against a throwaway local registry
   (`publish-rehearsal`), so a broken publish shows up before the merge.
4. **Compose:** `compose.yaml` pulls the image (`YGO_ALPHA_IMAGE`, default
   `ghcr.io/dinooo13/ygo-alpha:latest`), so a self-hoster needs only that
   file and `.env`. `compose.build.yaml` is an override that builds from the
   checkout as `ygo-alpha:local`; the smoke test runs that build.
5. **Runtime stays generic x86-64:** nothing in the image may need AVX or
   another CPU extension beyond what Node.js itself requires.

## Consequences

- The GHCR package has to be public for anonymous pulls. GitHub creates it
  private on the first push; an owner makes it public once in the package
  settings.
- `latest` moves with every push to `main`. Self-hosters who want to stay on
  one build pin a `sha-…` tag in `YGO_ALPHA_IMAGE`.
- The smoke test no longer covers pulling (the image under test is the one
  that hasn't been published yet); it checks that `compose.yaml` alone names
  the published image and builds nothing.
- Every workflow run, pull requests included, keeps two image archives as
  artifacts for one day.

#!/usr/bin/env bash
# Publishes the images scripts/docker-smoke.sh tested and saved, as one
# multi-arch image (amd64 and arm64), run by .github/workflows/docker.yml.
#
#   scripts/docker-publish.sh <repository> <image dir> <tag>...
#
# <image dir> holds image-amd64.tar and image-arm64.tar (`docker save`). Each
# is pushed as it is, under the staging tag <repository>:ci-<arch>, and the
# tags are then set on a manifest list of the two pushed digests. Nothing is
# rebuilt, so the published bits are the tested ones. Needs Docker with
# buildx, jq, and a login to the registry.
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ $# -ge 3 ] || fail "usage: $0 <repository> <image dir> <tag>..."
repository=$1
dir=$2
shift 2

sources=()
for arch in amd64 arm64; do
  archive="$dir/image-$arch.tar"
  [ -s "$archive" ] || fail "$archive is missing or empty"
  loaded=$(docker load -i "$archive" | sed -n 's/^Loaded image: //p' | tail -n 1)
  [ -n "$loaded" ] || fail "$archive holds no tagged image"
  platform=$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$loaded")
  [ "$platform" = "linux/$arch" ] || fail "$archive is $platform, expected linux/$arch"

  staging="$repository:ci-$arch"
  docker tag "$loaded" "$staging"
  docker push "$staging"
  digest=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$staging" |
    grep -F "$repository@sha256:" | head -n 1)
  [ -n "$digest" ] || fail "no digest for $staging after the push"
  echo "$arch: $digest"
  sources+=("$digest")
  # The next archive loads under the same name.
  docker rmi "$loaded" "$staging" > /dev/null
done

tag_args=()
for tag in "$@"; do
  tag_args+=(--tag "$repository:$tag")
done
docker buildx imagetools create "${tag_args[@]}" "${sources[@]}"

# Every tag must now name a list of exactly the two tested images.
want=$(printf '%s\n' "${sources[@]}" | sed 's/.*@//' | sort | paste -sd ' ')
for tag in "$@"; do
  raw=$(docker buildx imagetools inspect --raw "$repository:$tag")
  platforms=$(jq -r '[.manifests[].platform | "\(.os)/\(.architecture)"] | sort | join(" ")' <<< "$raw")
  [ "$platforms" = "linux/amd64 linux/arm64" ] ||
    fail "$repository:$tag has platforms '$platforms'"
  got=$(jq -r '[.manifests[].digest] | sort | join(" ")' <<< "$raw")
  [ "$got" = "$want" ] || fail "$repository:$tag points at $got, expected $want"
  echo "Published $repository:$tag (linux/amd64, linux/arm64)"
done

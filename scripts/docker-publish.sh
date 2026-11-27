#!/usr/bin/env bash
# Publishes the images scripts/docker-smoke.sh tested and saved, as one
# multi-arch image (amd64 and arm64), run by .github/workflows/docker.yml.
#
#   scripts/docker-publish.sh <repository> <image dir> <commit tag> [<tag>...]
#
# <commit tag> (sha-<short sha>) is written once per commit. If it exists
# already (a version tag on a commit main has published, or a re-run), the
# other tags are added to that image and <image dir> is not used: builds are
# not reproducible, so a second build must not replace the first.
#
# Otherwise <image dir> holds image-amd64.tar and image-arm64.tar (`docker
# save`). Each is pushed as it is, under the staging tag <repository>:ci-<arch>,
# and all tags are set on a manifest list of the two pushed digests. Nothing
# is rebuilt, so the published bits are the tested ones. Needs Docker with
# buildx, jq, and a login to the registry.
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ $# -ge 3 ] || fail "usage: $0 <repository> <image dir> <commit tag> [<tag>...]"
repository=$1
dir=$2
commit_tag=$3
shift 3

# digests <ref>: the sorted manifest digests of a manifest list, one line.
digests() {
  docker buildx imagetools inspect --raw "$1" | jq -r '[.manifests[].digest] | sort | join(" ")'
}

if docker buildx imagetools inspect "$repository:$commit_tag" > /dev/null 2>&1; then
  echo "$repository:$commit_tag exists; adding the other tags to it"
  tags=("$@")
  [ ${#tags[@]} -gt 0 ] || exit 0
  want=$(digests "$repository:$commit_tag")
  tag_args=()
  for tag in "${tags[@]}"; do
    tag_args+=(--tag "$repository:$tag")
  done
  docker buildx imagetools create "${tag_args[@]}" "$repository:$commit_tag"
else
  tags=("$commit_tag" "$@")
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
      awk -v p="$repository@sha256:" 'index($0, p) == 1 { print; exit }')
    [ -n "$digest" ] || fail "no digest for $staging after the push"
    echo "$arch: $digest"
    sources+=("$digest")
    # The next archive loads under the same name.
    docker rmi "$loaded" "$staging" > /dev/null
  done
  want=$(printf '%s\n' "${sources[@]}" | sed 's/.*@//' | sort | paste -sd ' ')
  tag_args=()
  for tag in "${tags[@]}"; do
    tag_args+=(--tag "$repository:$tag")
  done
  docker buildx imagetools create "${tag_args[@]}" "${sources[@]}"
fi

# Every tag must now name a list of the two platforms with the same digests
# as <commit tag>.
for tag in "${tags[@]}"; do
  raw=$(docker buildx imagetools inspect --raw "$repository:$tag")
  platforms=$(jq -r '[.manifests[].platform | "\(.os)/\(.architecture)"] | sort | join(" ")' <<< "$raw")
  [ "$platforms" = "linux/amd64 linux/arm64" ] ||
    fail "$repository:$tag has platforms '$platforms'"
  got=$(jq -r '[.manifests[].digest] | sort | join(" ")' <<< "$raw")
  [ "$got" = "$want" ] || fail "$repository:$tag points at $got, expected $want"
  echo "Published $repository:$tag (linux/amd64, linux/arm64)"
done

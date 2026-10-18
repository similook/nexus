#!/usr/bin/env bash
# Materialise the patched sing-box that core/go.mod's `replace` points at.
#
#   ./scripts/prepare-sing-box.sh
#
# Nexus carries ONE small patch on top of the pinned sing-box release: see
# core/patches/sing-box/README.md. The upstream source comes from the Go module cache, is
# checked against the h1: hash go.sum recorded for the pin, copied to third_party/sing-box and
# patched there. That copy is build output (gitignored); the .patch file is the reviewed change.
#
# Every build and check script calls this first. It is a no-op when the copy is already up to
# date, so it is cheap to run each time.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=v1.14.0
# MUST equal the `github.com/sagernet/sing-box v1.14.0 h1:` line in go.sum. A mismatch means
# the source is not the release the patch was written and tested against.
SUM='h1:c2x4MxM4ZJ2i11W2UiAeRJULJDSeOAF/W7Wl5F7eORg='

PATCH_DIR="patches/sing-box/$VERSION"
DEST=third_party/sing-box
STAMP="$DEST/.nexus-patch-stamp"

command -v go >/dev/null || { echo "go toolchain required" >&2; exit 1; }
command -v git >/dev/null || { echo "git required (to apply the patch)" >&2; exit 1; }

hash_patches() {
  if command -v sha256sum >/dev/null; then
    cat "$PATCH_DIR"/*.patch | sha256sum
  else
    cat "$PATCH_DIR"/*.patch | shasum -a 256
  fi | cut -d' ' -f1
}

WANT="$VERSION $SUM $(hash_patches)"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ]; then
  exit 0
fi

# Download OUTSIDE this module: inside it, the go command would try to load the module graph,
# and the `replace` target this script exists to create is missing.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
INFO=$(cd "$TMP" && GOFLAGS=-mod=mod go mod download -json "github.com/sagernet/sing-box@$VERSION")

# JSON escapes Windows backslashes; turn them into forward slashes, which Git Bash accepts.
DIR=$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*"Dir": "\(.*\)",$/\1/p' | sed 's#\\\\#/#g')
GOT=$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*"Sum": "\(.*\)",$/\1/p')

if [ "$GOT" != "$SUM" ]; then
  echo "sing-box $VERSION hash mismatch: got '$GOT', want '$SUM'" >&2
  exit 1
fi
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "could not locate the downloaded sing-box $VERSION source" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$DIR" "$DEST"
chmod -R u+w "$DEST"

# GIT_CEILING_DIRECTORIES keeps git from treating the outer Nexus repository as the patch
# root, so the patch applies relative to $DEST exactly like `patch -p1`, and fails on any
# hunk that does not match instead of fuzzing it in.
CEILING=$(cd "$DEST/.." && pwd)
for patch in "$PATCH_DIR"/*.patch; do
  ABS="$(pwd)/$patch"
  (cd "$DEST" && GIT_CEILING_DIRECTORIES="$CEILING" git apply --check -p1 "$ABS")
  (cd "$DEST" && GIT_CEILING_DIRECTORIES="$CEILING" git apply -p1 "$ABS")
  echo "applied $(basename "$patch")"
done

printf '%s\n' "$WANT" > "$STAMP"
echo "prepared $DEST (sing-box $VERSION + Nexus patches)"

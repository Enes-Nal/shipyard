#!/usr/bin/env bash
# Publish a Terminal release from this Mac, with the same build the release
# workflow makes in CI:
#
#   make publish VERSION=0.3.0 [NOTES="What changed"]
#
# 1. Sets the version in app/package.json, tauri.conf.json and Cargo.toml.
# 2. Builds the app universal, signs it with the Developer ID, notarizes and
#    staples it, and checks it (scripts/mac-release.sh), into dist/mac/.
# 3. Commits "chore: release vX", tags, and pushes main and the tag.
# 4. Creates the GitHub release (or adds to it) with the dmg, the updater
#    archive and its signature, and last latest.json, the feed installed
#    apps update from.
#
# The tag push starts .github/workflows/release.yml: its release job adds the
# CLI and daemon archives (and checksums.txt) for install.sh; its macos job
# finds latest.json already announcing this version and builds nothing.
# Without this script, pushing a v* tag has CI publish the app instead.
#
# Credentials come from the environment, else from 1Password:
#   TAURI_SIGNING_PRIVATE_KEY  op://Personal/Calport updater signing key/private key
#   APPLE_API_ISSUER           "Issuer ID" of op://Personal/Berth Developer Id
#   APPLE_API_KEY              "Key ID" of the same item
#   APPLE_API_KEY_PATH         its AuthKey_<Key ID>.p8, written to a private temp file
#   APPLE_SIGNING_IDENTITY     the one Developer ID Application identity in the keychain
# BERTH_UPDATER_KEY_OP and BERTH_APPLE_OP_ITEM point at other 1Password items.
set -euo pipefail

version="${VERSION:?set VERSION, e.g. make publish VERSION=0.3.0}"
version="${version#v}"
tag="v$version"
repo="cosscom/shipyard"
updater_op="${BERTH_UPDATER_KEY_OP:-op://Personal/Calport updater signing key/private key}"
apple_op="${BERTH_APPLE_OP_ITEM:-op://Personal/Berth Developer Id}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

die() { echo "publish: $*" >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION must look like 1.2.3"
[ -z "$(git status --porcelain)" ] || die "commit your changes first"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "publish from main"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "$tag is already tagged here"
[ -z "$(git ls-remote --tags origin "refs/tags/$tag")" ] || die "$tag is already tagged on origin"
gh release view "$tag" --repo "$repo" >/dev/null 2>&1 && die "$tag is already released"

op_read() { # op_read REF: a 1Password value, or a clear failure
  command -v op >/dev/null || die "no $2 in the environment, and no 1Password CLI (op) to read it from"
  op read "$1" || die "could not read $2 from 1Password ($1)"
}

[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || TAURI_SIGNING_PRIVATE_KEY="$(op_read "$updater_op" "the updater signing key")"
[ -n "${APPLE_API_ISSUER:-}" ] || APPLE_API_ISSUER="$(op_read "$apple_op/Issuer ID" "APPLE_API_ISSUER")"
[ -n "${APPLE_API_KEY:-}" ] || APPLE_API_KEY="$(op_read "$apple_op/Key ID" "APPLE_API_KEY")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [ -z "${APPLE_API_KEY_PATH:-}" ]; then
  APPLE_API_KEY_PATH="$tmp/AuthKey_$APPLE_API_KEY.p8"
  (umask 077 && op_read "$apple_op/AuthKey_$APPLE_API_KEY.p8" "the App Store Connect API key" >"$APPLE_API_KEY_PATH")
fi
export TAURI_SIGNING_PRIVATE_KEY APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH

# The updater key proves an update came from us; it says nothing to
# Gatekeeper, which needs the Developer ID signature and Apple's ticket.
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  found="$(security find-identity -v -p codesigning 2>/dev/null | grep -c "Developer ID Application" || true)"
  [ "$found" = 1 ] ||
    die "set APPLE_SIGNING_IDENTITY: found $found Developer ID Application identities, need exactly one to choose automatically"
  APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
fi
export APPLE_SIGNING_IDENTITY
echo "Signing as ${APPLE_SIGNING_IDENTITY}…"

echo "Setting version ${version}…"
bumped=(app/package.json app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock)
# Until the release commit exists, a failure puts the old version back.
trap 'rm -rf "$tmp"; [ -n "${committed:-}" ] || git checkout -q -- "${bumped[@]}"' EXIT
python3 - "$version" <<'PY'
import json, re, sys
v = sys.argv[1]
for path in ("app/package.json", "app/src-tauri/tauri.conf.json"):
    with open(path) as f:
        data = json.load(f)
    data["version"] = v
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
path = "app/src-tauri/Cargo.toml"
text = open(path).read()
text = re.sub(r'(?m)^version = "[^"]+"', f'version = "{v}"', text, count=1)
open(path, "w").write(text)
PY
(cd app/src-tauri && { cargo update -p berth --offline >/dev/null 2>&1 || true; })

NOTES="${NOTES:-}" scripts/mac-release.sh "$tag"

git add "${bumped[@]}"
git commit -q -m "chore: release $tag"
committed=1
git tag "$tag"
git push -q origin main "$tag"

assets=(dist/mac/Berth-macos-universal.dmg dist/mac/Berth-macos-universal.app.tar.gz dist/mac/Berth-macos-universal.app.tar.gz.sig)
# The release workflow may have made the release already, for its archives.
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  gh release upload "$tag" --repo "$repo" --clobber "${assets[@]}"
elif [ -n "${NOTES:-}" ]; then
  gh release create "$tag" --repo "$repo" --verify-tag --draft --title "Terminal $tag" --notes "$NOTES" "${assets[@]}"
else
  gh release create "$tag" --repo "$repo" --verify-tag --draft --title "Terminal $tag" --generate-notes "${assets[@]}"
fi
# Last, so the feed never points at an archive that is not there yet.
gh release upload "$tag" --repo "$repo" --clobber dist/mac/latest.json
# Only now "latest": until then the feed of the last release stays live.
gh release edit "$tag" --repo "$repo" --draft=false --latest
echo "Published $tag. Installed apps offer it within a few hours, or from Settings → About → Check now."

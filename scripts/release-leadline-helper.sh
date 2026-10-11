#!/bin/sh
# Release the builds of berth-leadline, the helper the Leadline plugin runs
# on a box (cmd/berth-leadline, internal/leadline/API.md): build it for every
# box platform, list those very files in the plugin listing by their
# checksums, and attach them to a GitHub release of their own.
#
#   scripts/release-leadline-helper.sh             build, list and upload
#   scripts/release-leadline-helper.sh --dry-run   build and list; upload nothing
#
# The version is box.helper.version in plugins/leadline/berth-plugin.json.
# Bump it there first: a version is released once. People allow the plugin's
# manifest, which names each build by its SHA-256, so the files of a release
# never change; new builds are a new version, and the listing build refuses
# other checksums under one that is listed.
#
# What it does, in order:
#
#   1. make leadline VERSION=<version>: bin/berth-leadline-<os>-<arch> for
#      linux and darwin, amd64 and arm64, static, stamped v<version>.
#   2. app/scripts/build-marketplace.mjs --helper-bin bin: site/plugins/ with
#      each build's size and SHA-256, at
#      https://github.com/<repo>/releases/download/leadline-helper-v<version>/berth-leadline-<os>-<arch>
#   3. gh release create leadline-helper-v<version> with the four files and
#      their checksums.txt. It is not marked as the latest release: the
#      latest is Shipyard's own, which site/install.sh and the app's updater
#      download from.
#
# Then commit site/plugins/ and merge it: the listing on the public site is
# what makes the new builds installable. Until then nothing uses them.
#
# It needs go, node (with app/node_modules installed), make and gh (signed
# in, with write access to the repository). The commit it builds has to be
# on GitHub already, because the release's tag points at it.
#
#   REPO=owner/name   another repository than cosscom/shipyard
#   VERSION=1.2.3     build this version instead of the plugin manifest's (with
#                     --dry-run only: a release is what the manifest says)
set -eu

repo=${REPO:-cosscom/shipyard}
name=berth-leadline
platforms="linux-amd64 linux-arm64 darwin-arm64 darwin-amd64"
dry=
case "${1:-}" in
"") ;;
--dry-run) dry=1 ;;
*)
	echo "usage: scripts/release-leadline-helper.sh [--dry-run]" >&2
	exit 2
	;;
esac

die() {
	echo "release-leadline-helper: $*" >&2
	exit 1
}

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
manifest=plugins/leadline/berth-plugin.json

for tool in go node make; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done
[ -f "$manifest" ] || die "$manifest is not there: the Leadline plugin names the helper's version"
[ -d app/node_modules ] || die "app/node_modules is missing: run (cd app && pnpm install --frozen-lockfile)"

listed=$(node -e '
	const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
	const h = (m.box || {}).helper || {};
	if (h.name !== process.argv[2] || !h.version) process.exit(1);
	console.log(h.version);
' "$manifest" "$name") || die "$manifest has no box.helper named $name with a version"
version=${VERSION:-$listed}
case "$version" in
"" | v* | *[!0-9A-Za-z.+-]*) die "\"$version\" is not a version like 0.1.0 (no leading v)" ;;
esac
if [ "$version" != "$listed" ] && [ -z "$dry" ]; then
	die "VERSION=$version is not the $listed that $manifest names; a release is what the manifest says"
fi
tag="leadline-helper-v$version"

if [ -z "$dry" ]; then
	command -v gh >/dev/null 2>&1 || die "gh is not installed"
	gh auth status >/dev/null 2>&1 || die "gh is not signed in: run gh auth login"
	# What is built is what is committed: the tag points at this commit.
	[ -z "$(git status --porcelain -- . ':!site/plugins')" ] || die "there are uncommitted changes; commit them first"
	[ -n "$(git branch -r --contains HEAD 2>/dev/null)" ] || die "this commit is not on GitHub yet; push it first"
	if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
		die "$tag is already released. Its files never change: bump box.helper.version in $manifest"
	fi
fi

echo "Building $name $version for: $platforms"
make leadline VERSION="$version"
files=
names=
for p in $platforms; do
	[ -s "bin/$name-$p" ] || die "bin/$name-$p was not built"
	files="$files bin/$name-$p"
	names="$names $name-$p"
done

echo "Listing them in site/plugins/"
node app/scripts/build-marketplace.mjs --helper-bin bin

# As sha256sum prints it, by the names the release's files have.
sums="bin/$name-checksums.txt"
# shellcheck disable=SC2086 # names is a list of file names with no spaces in them
if command -v sha256sum >/dev/null 2>&1; then
	(cd bin && sha256sum -- $names) >"$sums"
else
	(cd bin && shasum -a 256 -- $names) >"$sums"
fi
cat "$sums"

if [ -n "$dry" ]; then
	echo
	echo "Dry run: nothing was uploaded. site/plugins/ now lists these builds; do not commit it"
	echo "(git checkout -- site/plugins), since a release builds them again."
	exit 0
fi

commit=$(git rev-parse HEAD)
notes="The builds of $name $version, the helper the Leadline plugin runs on a box.

Shipyard installs these itself: turn the Leadline plugin on for a box and the
app downloads the build for that box, checks it against the SHA-256 in the
plugin's manifest, and uploads it. There is nothing here to install by hand.

Built from $commit."
# shellcheck disable=SC2086 # files is a list of paths with no spaces in them
gh release create "$tag" --repo "$repo" --target "$commit" --latest=false \
	--title "Leadline helper $version" --notes "$notes" $files "$sums"

echo
echo "Released $tag. Now commit site/plugins/ and merge it: the listing on the"
echo "public site is what makes these builds installable."

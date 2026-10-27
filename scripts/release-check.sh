#!/usr/bin/env bash
# The full release checks, together: what make release-check runs, by hand,
# now and then (they aren't part of releasing).
#
#   scripts/release-check.sh [--dmg PATH] [--from TAG] [--version vX.Y.Z] [--signed] [--out DIR]
#                            [--ref COMMIT | --dirty] [--no-build] [--universal] [--any-build]
#
#   1. scripts/fresh-user-test.sh   the app's first run on this Mac (macOS only)
#   2. scripts/linux-box-test.sh    a fresh Ubuntu box and laptop, in Docker
#   3. scripts/upgrade-test.sh      --from (default: the last release) to this
#                                   build, on a Linux box and on this Mac
#
# Everything is built from one commit (--ref, default HEAD) as committed, in
# a clean checkout in the reports' folder (src/), and the commit heads every
# report; --dirty tests this checkout's uncommitted changes instead. The Linux
# archives with make release, and, on a Mac without --dmg, the app with
# make app-build (--universal: both architectures, as the release
# workflow builds it; --no-build: use a dmg already built from HEAD), so the
# gate always tests what would be tagged. Every test refuses a dmg built
# from another commit, or without berthd, unless --any-build;
# --version is stamped into the Linux builds; --signed also requires the
# app to be notarized. Off macOS only the Linux
# checks run, and it says so. Reports and screenshots go to --out (default
# dist/release-test/check-<time>/). Exit status 0 only if every check passed.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
DMG="" FROM="" VERSION=dev SIGNED="" OUT="" BUILD=1 UNIVERSAL="" ANY="" REF=HEAD DIRTY=0
while [ $# -gt 0 ]; do
	case $1 in
	--dmg) DMG=$2 && shift 2 ;;
	--from) FROM=$2 && shift 2 ;;
	--version) VERSION=$2 && shift 2 ;;
	--signed) SIGNED=--signed && shift ;;
	--no-build) BUILD=0 && shift ;;
	--universal) UNIVERSAL=1 && shift ;;
	--any-build) ANY=--any-build && shift ;;
	--ref) REF=$2 && shift 2 ;;
	--dirty) DIRTY=1 && shift ;;
	--out) OUT=$2 && shift 2 ;;
	-h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' && exit 0 ;;
	*) echo "unknown option $1 (try --help)" >&2 && exit 2 ;;
	esac
done
OUT=${OUT:-$(cd "$here/.." && pwd)/dist/release-test/check-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"

results=()
run() { # run NAME COMMAND…
	local name=$1
	shift
	echo
	echo "=== $name"
	if "$@"; then results+=("pass  $name"); else results+=("FAIL  $name"); fi
}

# Everything tested is built from one commit (--ref, default HEAD) as
# committed, in a checkout of its own in the reports' folder (src/, a git
# worktree, removed at the end): work in progress in this checkout, another
# change half made, never ends up in, or breaks, what is tested. --dirty
# builds this checkout as it is instead, uncommitted changes and all; the
# reports say so.
REPO_DIR=$(cd "$here/.." && pwd)
REV=$(git -C "$REPO_DIR" rev-parse --verify "$REF^{commit}") || {
	echo "release-check: $REF is not a commit" >&2
	exit 2
}
dirty=$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)
if [ "$DIRTY" = 1 ]; then
	[ "$REF" = HEAD ] || {
		echo "release-check: --dirty builds this checkout as it is; it can't be combined with --ref" >&2
		exit 2
	}
	SRC_TREE=$REPO_DIR
	TESTED="$REV with uncommitted changes (--dirty)"
else
	SRC_TREE="$OUT/src"
	trap 'git -C "$REPO_DIR" worktree remove --force "$SRC_TREE" >/dev/null 2>&1' EXIT
	git -C "$REPO_DIR" worktree add -q --detach "$SRC_TREE" "$REV" || exit 1
	TESTED="$REV"
	[ -z "$dirty" ] || echo "(this checkout has uncommitted changes; they aren't tested: --dirty tests them)"
fi
# The tests are this commit's own, run from the checkout under test: a
# later change to them in this checkout tests what it was written for.
TESTS="$SRC_TREE/scripts"
# The tests check the dmg was built from this commit, and print it.
export BERTH_RELEASE_TEST_REV=$REV
{
	echo "# Terminal release checks"
	echo
	echo "Commit tested: \`$TESTED\` ($(git -C "$REPO_DIR" log -1 --format='%s' "$REV"))"
	echo
} >"$OUT/report.md"
echo "=== Testing commit $TESTED"

# The Linux archives, as make release builds them.
echo "=== Building the Linux archives (make release, log: $OUT/release-build.log)"
make -C "$SRC_TREE" release VERSION="$VERSION" >"$OUT/release-build.log" 2>&1 || {
	tail -20 "$OUT/release-build.log"
	echo "release-check: make release failed" >&2
	exit 1
}
LINUX_DIST="$SRC_TREE/dist"

# build_app builds the app (make app-build), keeping Cargo's build between
# runs, and sets DMG to a copy of the dmg in the reports' folder.
build_app() {
	local cache built
	cache="${XDG_CACHE_HOME:-$HOME/Library/Caches}/berth-release-check/target"
	mkdir -p "$cache"
	echo "=== Building the app: make app-build${UNIVERSAL:+ APP_TARGET=universal-apple-darwin} (log: $OUT/app-build.log)"
	rm -f "$cache"/release/bundle/dmg/*.dmg "$cache"/*/release/bundle/dmg/*.dmg
	if (cd "$SRC_TREE/app" && pnpm install --frozen-lockfile) >"$OUT/app-build.log" 2>&1 &&
		CARGO_TARGET_DIR="$cache" make -C "$SRC_TREE" app-build ${UNIVERSAL:+APP_TARGET=universal-apple-darwin} >>"$OUT/app-build.log" 2>&1; then
		built=$(ls -t "$cache"/release/bundle/dmg/*.dmg "$cache"/*/release/bundle/dmg/*.dmg 2>/dev/null | head -1)
		if [ -n "$built" ]; then
			DMG="$OUT/Berth-${REV:0:9}.dmg"
			cp "$built" "$DMG" && return 0
		fi
	fi
	tail -20 "$OUT/app-build.log"
	echo "release-check: building the app failed (see $OUT/app-build.log)" >&2
	return 1
}

mac=0
[ "$(uname -s)" = Darwin ] && mac=1
if [ $mac = 1 ] && [ -z "$DMG" ]; then
	if [ "$BUILD" = 1 ]; then
		build_app || exit 1
	else
		# shellcheck source=release-test/common.sh
		source "$here/release-test/common.sh"
		# shellcheck source=release-test/macos/lib.sh
		source "$here/release-test/macos/lib.sh"
		DMG=$(find_dmg) || {
			echo "release-check: no dmg built from HEAD to test; build one with make app-build, or pass DMG=path (make) / --dmg PATH" >&2
			exit 1
		}
	fi
	echo "Testing $DMG"
fi
if [ $mac = 1 ]; then
	run "Fresh user (macOS app)" "$TESTS/fresh-user-test.sh" --dmg "$DMG" $SIGNED $ANY --out "$OUT/fresh-user"
fi
run "Fresh box (Linux, Docker)" "$TESTS/linux-box-test.sh" --dist "$LINUX_DIST" --out "$OUT/linux-box"
run "Upgrade (Linux box)" "$TESTS/upgrade-test.sh" --linux ${FROM:+--from "$FROM"} --dist "$LINUX_DIST" --out "$OUT/upgrade-linux"
if [ $mac = 1 ]; then
	run "Upgrade (this Mac's box)" "$TESTS/upgrade-test.sh" --mac ${FROM:+--from "$FROM"} --dmg "$DMG" $ANY --out "$OUT/upgrade-mac"
fi

echo
echo "Release checks of $TESTED (reports in $OUT):"
failed=0
for r in "${results[@]}"; do
	echo "  $r"
	echo "- $r" >>"$OUT/report.md"
	case $r in FAIL*) failed=1 ;; esac
done
if [ $mac = 0 ]; then
	echo "  (the macOS checks need a Mac: run make release-check there)"
fi
exit $failed

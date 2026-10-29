#!/usr/bin/env bash
# Build the Linux desktop app (an alpha) the way a release ships it, check
# it, and put what a GitHub release carries in dist/linux/:
#
#   Berth-linux-ARCH-alpha.AppImage       the download, which updates itself
#   Berth-linux-ARCH-alpha.AppImage.sig   the in-app updater's signature for it
#   Berth-linux-ARCH-alpha.deb            for Debian and Ubuntu
#   Berth-linux-ARCH-alpha.deb.sig        when the bundler signed it: lets a
#                                         .deb install update (with a password)
#   latest-linux.json                     this build's entries for latest.json
#
#   scripts/linux-release.sh v1.2.3 [--unsigned]
#
# ARCH is this machine's: x86_64 (released) or aarch64 (not yet released;
# a GitHub ubuntu-24.04-arm runner could build it). The release workflow's
# linux job (.github/workflows/release.yml) runs this on a hosted Ubuntu
# runner, uploads the bundles to the release, and its feed job merges
# latest-linux.json into the Mac's latest.json (scripts/merge-feed.py), so
# installed apps of both kinds update from the one feed.
#
# It needs TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD when it has one), the
# same key the Mac's updater archive is signed with, and Docker or the tmux
# builds already in bin/ (the release's tmux job). It fails unless the
# AppImage and the .deb carry the app, berth-cli, berthd for this computer,
# the Linux daemons and tmux; the .deb's desktop file opens berth:// links;
# every executable is built for ARCH and stamped with the version; and the
# updater signature checks out against the public key the app carries.
#
# --unsigned skips the updater signature, for trying a build locally. Its
# output is not releasable and has no latest-linux.json.
set -euo pipefail

version="${1:?usage: scripts/linux-release.sh vX.Y.Z [--unsigned]}"
version="${version#v}"
tag="v$version"
signed=1
[ "${2:-}" = "--unsigned" ] && signed=0
repo="cosscom/shipyard"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

die() { echo "linux-release: $*" >&2; exit 1; }
step() { printf '==> %s\n' "$*"; }
ok() { printf '  ok: %s\n' "$*"; }

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version must look like v1.2.3, not $1"
[ "$(uname -s)" = Linux ] || die "this builds the Linux app, so it runs on Linux"
arch="$(uname -m)"
case "$arch" in
  x86_64) debarch=amd64 elf="x86-64" ;;
  aarch64) debarch=arm64 elf="ARM aarch64" ;;
  *) die "no Linux app for $arch" ;;
esac
if [ "$signed" = 1 ]; then
  : "${TAURI_SIGNING_PRIVATE_KEY:?set TAURI_SIGNING_PRIVATE_KEY, the updater signing key (or pass --unsigned)}"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  if ! command -v minisign >/dev/null; then
    [ -z "${CI:-}" ] || die "minisign is needed to check the updater signature"
    echo "linux-release: minisign not found; not checking the updater signature" >&2
  fi
else
  # make app-build writes the updater's artifacts whenever the key is set.
  unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

name="Berth-linux-$arch-alpha"
# Tauri keeps the resources in /usr/lib/<productName>.
product="$(python3 -c 'import json; print(json.load(open("app/src-tauri/tauri.conf.json"))["productName"])')"
lib="usr/lib/$product"
bundle="${CARGO_TARGET_DIR:-app/src-tauri/target}/release/bundle"
out="dist/linux"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

step "Building Terminal $version for Linux ($arch), an alpha"
rm -rf "$bundle"
make app-build VERSION="$version"

appimages=("$bundle"/appimage/*.AppImage)
debs=("$bundle"/deb/*.deb)
if [ "${#appimages[@]}" != 1 ] || [ ! -f "${appimages[0]}" ]; then die "expected one AppImage in $bundle/appimage"; fi
if [ "${#debs[@]}" != 1 ] || [ ! -f "${debs[0]}" ]; then die "expected one .deb in $bundle/deb"; fi
appimage="$(realpath "${appimages[0]}")" deb="$(realpath "${debs[0]}")"
if [ "$signed" = 1 ]; then
  [ -f "$appimage.sig" ] || die "the AppImage was not signed for the updater (is createUpdaterArtifacts on?)"
fi

# check_tree DIR: the app as installed, from either bundle, with its files
# where linux.rs stages them from.
check_tree() {
  local dir="$1" exe f v
  for exe in usr/bin/berth-app usr/bin/berth-cli $lib/berthd; do
    [ -x "$dir/$exe" ] || die "$dir carries no $exe"
    file -L "$dir/$exe" | grep -q "ELF 64-bit.*$elf" || die "$dir/$exe is not built for $arch: $(file -L "$dir/$exe")"
  done
  for f in berthd-linux-amd64 berthd-linux-arm64 tmux-linux-amd64 tmux-linux-arm64; do
    [ -f "$dir/$lib/$f" ] || die "$dir carries no $lib/$f"
  done
  # The CLI and this computer's berthd are static, like the release's.
  for exe in usr/bin/berth-cli $lib/berthd; do
    file -L "$dir/$exe" | grep -q "statically linked" || die "$dir/$exe is not statically linked"
  done
  v="$("$dir/usr/bin/berth-cli" version 2>&1 || true)"
  [[ "$v" == "berth $tag "* ]] || die "$dir/usr/bin/berth-cli says \"$v\", not berth $tag"
  v="$("$dir/$lib/berthd" version 2>&1 || true)"
  [[ "$v" == "berthd $tag "* ]] || die "$dir/$lib/berthd says \"$v\", not berthd $tag"
  ok "$dir"
}

step "Checking the .deb"
dpkg-deb -f "$deb" Version | grep -qx "$version" || die "$deb is not version $version"
dpkg-deb -f "$deb" Architecture | grep -qx "$debarch" || die "$deb is not for $debarch"
mkdir -p "$work/deb"
dpkg-deb -x "$deb" "$work/deb"
check_tree "$work/deb"
desktop="$(find "$work/deb/usr/share/applications" -name '*.desktop' | head -1)"
[ -n "$desktop" ] || die "$deb has no desktop file"
grep -q '^Exec=berth-app %u$' "$desktop" || die "$desktop does not start berth-app with the link it opens: $(grep '^Exec' "$desktop")"
grep -q '^MimeType=.*x-scheme-handler/berth' "$desktop" || die "$desktop does not open berth:// links"
ok "$deb"

step "Checking the AppImage"
chmod +x "$appimage"
file "$appimage" | grep -q "ELF 64-bit.*$elf" || die "$appimage is not built for $arch"
# --appimage-extract needs no FUSE.
(cd "$work" && "$appimage" --appimage-extract >/dev/null) || die "$appimage does not extract"
check_tree "$work/squashfs-root"
ok "$appimage"

rm -rf "$out" && mkdir -p "$out"
cp "$appimage" "$out/$name.AppImage"
cp "$deb" "$out/$name.deb"

if [ "$signed" = 1 ]; then
  cp "$appimage.sig" "$out/$name.AppImage.sig"
  # Newer bundlers sign the .deb too; with its signature a .deb install
  # updates through dpkg (asking for a password), and without it the feed
  # leaves the .deb out, so a .deb install never takes the AppImage.
  [ ! -f "$deb.sig" ] || cp "$deb.sig" "$out/$name.deb.sig"

  step "Checking the updater signatures"
  if command -v minisign >/dev/null; then
    pubkey="$(python3 -c 'import json; print(json.load(open("app/src-tauri/tauri.conf.json"))["plugins"]["updater"]["pubkey"])')"
    base64 -d <<<"$pubkey" >"$work/updater.pub"
    for f in "$out/$name.AppImage" "$out/$name.deb"; do
      [ -f "$f.sig" ] || continue
      base64 -d <"$f.sig" >"$work/updater.minisig"
      minisign -Vq -p "$work/updater.pub" -x "$work/updater.minisig" -m "$f" ||
        die "$f's updater signature does not match the public key in tauri.conf.json, so installed apps would refuse this update"
      ok "$f"
    done
  fi

  step "Writing latest-linux.json"
  python3 - "$version" "$tag" "$repo" "$arch" "$name" "$out" <<'PY'
import json, os, sys
version, tag, repo, arch, name, out = sys.argv[1:7]
base = f"https://github.com/{repo}/releases/download/{tag}"
def entry(f):
    return {"signature": open(f"{out}/{f}.sig").read().strip(), "url": f"{base}/{f}"}
appimage = entry(f"{name}.AppImage")
# The updater looks for linux-ARCH-<how it was installed> first, then
# linux-ARCH (tauri-plugin-updater's get_urls).
platforms = {f"linux-{arch}": appimage, f"linux-{arch}-appimage": appimage}
if os.path.exists(f"{out}/{name}.deb.sig"):
    platforms[f"linux-{arch}-deb"] = entry(f"{name}.deb")
with open(f"{out}/latest-linux.json", "w") as f:
    json.dump({"version": version, "platforms": platforms}, f, indent=2)
    f.write("\n")
PY
else
  echo "linux-release: NOT signed for the updater (--unsigned); for local checks only, do not publish these" >&2
fi
(cd "$out" && sha256sum ./*)

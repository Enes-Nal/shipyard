# Terminal for macOS, as a Homebrew cask. This repository is its own tap:
#
#   brew tap cosscom/shipyard https://github.com/cosscom/shipyard
#   brew install --cask cosscom/shipyard/shipyard
#
# The dmg's name carries no version and the app updates itself (Restart to
# update), so the cask follows releases/latest and has nothing to bump at
# release time. The app is signed and notarized; Gatekeeper checks it on
# first open, in place of a checksum here.
cask "shipyard" do
  version :latest
  sha256 :no_check

  url "https://github.com/cosscom/shipyard/releases/latest/download/Berth-macos-universal.dmg"
  name "Terminal"
  desc "Run coding agents on your dev boxes"
  homepage "https://www.berthd.app/"

  depends_on :macos

  app "Terminal.app"
  # The app's own berth CLI, so `berth` updates with the app.
  binary "#{appdir}/Terminal.app/Contents/MacOS/berth-cli", target: "berth"

  # Uninstalling keeps the laptop agent and this Mac's box (their launchd
  # jobs) and ~/.berth, so an upgrade or a reinstall carries on where it left
  # off. Zap stops and removes them too.
  zap launchctl: [
        "dev.berth.agent",
        "dev.berth.berthd",
      ],
      trash:     [
        "~/.berth",
        "~/Library/Application Support/berth",
        "~/Library/Application Support/dev.berth.app",
        "~/Library/Caches/dev.berth.app",
        "~/Library/Preferences/dev.berth.app.plist",
        "~/Library/Saved Application State/dev.berth.app.savedState",
        "~/Library/WebKit/dev.berth.app",
      ]
end

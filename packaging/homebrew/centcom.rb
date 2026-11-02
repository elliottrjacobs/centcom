# Draft Homebrew cask. Before publishing (in a tap, or homebrew/cask): set the version and fill
# both sha256 values from SHA256SUMS.txt on the GitHub Release.
cask "centcom" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "REPLACE_WITH_ARM64_DMG_SHA256",
         intel: "REPLACE_WITH_X64_DMG_SHA256"

  url "https://github.com/elliottrjacobs/centcom/releases/download/v#{version}/CENTCOM-#{version}-#{arch}.dmg"
  name "CENTCOM"
  desc "Project and task tracker for humans and agents"
  homepage "https://github.com/elliottrjacobs/centcom"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :monterey"
  # The `centcom` command-line client runs on the system Node.
  depends_on formula: "node"

  app "CENTCOM.app"
  binary "#{appdir}/CENTCOM.app/Contents/Resources/app.asar.unpacked/dist-cli/centcom.cjs", target: "centcom"

  # Your vault (~/CENTCOM) and server config (~/.centcom) are your data: never removed here.
  zap trash: [
    "~/Library/Application Support/CENTCOM",
    "~/Library/Logs/CENTCOM",
    "~/Library/Preferences/app.centcom.desktop.plist",
  ]
end

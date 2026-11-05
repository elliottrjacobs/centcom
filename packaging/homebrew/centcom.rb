# Homebrew cask, not yet published to a tap. On each release, set the version and both sha256
# values from SHA256SUMS.txt on the GitHub Release.
cask "centcom" do
  arch arm: "arm64", intel: "x64"

  version "1.0.0"
  sha256 arm:   "c7ce3ee63e3896407231889ba20661a9fb305871b0f99b3a303c10f315f32504",
         intel: "a10bd86a2819c0017f06b0b6b4b88b354df07a1d5074b9b85dd7acc7b8a0268b"

  url "https://github.com/elliottrjacobs/centcom/releases/download/v#{version}/CENTCOM-#{version}-#{arch}.dmg"
  name "CENTCOM"
  desc "Project and task tracker for humans and agents"
  homepage "https://centcom.app"

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
    "~/Library/Preferences/studio.extendedmind.centcom.desktop.plist",
  ]
end

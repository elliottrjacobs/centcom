# Mac app

The Mac app is an Electron shell around the same server everything else talks to. While it is open, with or without a window, it runs the server on `127.0.0.1:4747`. If a server is already running there (see *Running headless* below), it attaches to that one instead.

It is distributed as a notarized download from GitHub Releases, not through the Mac App Store: the App Store requires the App Sandbox, which would put the vault behind per-folder permission prompts and stop the app from hosting a server for your agents and CLI.

## First run

The first launch creates the vault (`~/CENTCOM`) and `~/.centcom/config.json`, shows the **owner token** once, and explains remote access. New installs require a token from local clients too (`requireTokenOnLoopback`); the app and CLI read it from the config file themselves. Give each phone and agent its own token in Settings → Tokens.

**Open CENTCOM at login** (in the welcome screen and in Settings) registers the app as a login item, so the server is up whenever you are signed in. That is all most people need.

## Running headless

To keep the server up without the app at all (a server Mac, or no GUI session), run the bundled server under a user LaunchAgent. It needs Node 22 or later. Save as `~/Library/LaunchAgents/app.centcom.server.plist`, adjusting the paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.centcom.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/centcom/dist-server/index.cjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>CENTCOM_UI_DIR</key><string>/path/to/centcom/dist-ui</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/CENTCOM/server-error.log</string>
</dict>
</plist>
```

Then `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/app.centcom.server.plist`. The app attaches to it when opened. After upgrading the source, `pnpm build` and `launchctl kickstart -k gui/$UID/app.centcom.server`.

## Command-line client

`centcom` is `dist-cli/centcom.cjs` (Node 22+). From a source checkout, link it onto your `PATH`; the Homebrew cask installs it from the app bundle (`Contents/Resources/app.asar.unpacked/dist-cli/centcom.cjs`).

## Building

```sh
pnpm package        # release/CENTCOM-<version>-<arch>.dmg and .zip for this Mac's architecture
pnpm release:mac    # both arm64 and x64
```

Packaging is `electron-builder.config.mjs`. Everything Node needs is bundled into `dist-*` by esbuild, so the app ships no `node_modules`. The app is an ASAR archive with `dist-ui` and `dist-cli` unpacked beside it (the embedded server reads the UI from disk; the CLI runs on the system Node). Electron fuses turn off `RunAsNode`, `NODE_OPTIONS` and `--inspect`, and turn on ASAR integrity validation and ASAR-only loading. Cookie encryption stays off: the windows authenticate with an injected bearer and keep no cookies, and the encrypted store would put the app behind a Keychain prompt every time its signature changes. Release builds hide DevTools.

### Signing and notarization

- With a **Developer ID Application** certificate in the keychain (or `CSC_LINK` + `CSC_KEY_PASSWORD`), the app is signed with it under the hardened runtime, whose only exception is V8's JIT (`build/entitlements.mac.plist`). Without one it is signed ad hoc: it runs on the Mac that built it and nowhere else.
- Notarization runs when credentials are in the environment: an App Store Connect API key (`APPLE_API_KEY` path, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), a `notarytool` keychain profile (`APPLE_KEYCHAIN_PROFILE`), or an Apple ID (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
- `CENTCOM_REQUIRE_DEVELOPER_ID=1` fails the build unless both are present. The release workflow sets it.
- The bundle id defaults to the neutral `app.centcom.desktop`; set `CENTCOM_BUNDLE_ID` for the official build. A fork must use its own.

### Releases and updates

Pushing a `v*` tag runs `.github/workflows/release.yml`: tests, then a signed, notarized arm64 + x64 build published to a GitHub Release with `SHA256SUMS.txt`. Its secrets are listed at the top of the workflow. The published app checks that release feed (`electron-updater`) at launch, downloads updates in the background and installs them on quit. Builds without a feed (local, forks) never check. `CENTCOM_DISABLE_UPDATES=1` turns checking off.

`packaging/homebrew/centcom.rb` is a draft cask: fill in the repository and the checksums from a release.

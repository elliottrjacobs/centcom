# iOS companion

A native SwiftUI client for the same CENTCOM server the Mac app uses. It targets iOS 17 and later, iPhone and iPad.

## Features

- Tasks and Inbox: search, filter, create, edit, assign, prioritize, set due dates and labels, complete or reopen.
- Project Home: overview, counts, active tasks, description, and Library.
- Library: read, create and edit Markdown docs, with version checks so a newer edit from someone else is never overwritten; other files (images, PDFs, media, uploads) open in Quick Look. The + menu uploads files from Files.
- Agents: profiles with Description, Operating instructions and rules, Skills, and Outputs.
- Skills and Instructions inventories, task discussion, Activity.

The phone talks only to the server you configure. The token lives in the Keychain (`WhenUnlockedThisDeviceOnly`); images and files are fetched natively with the `Authorization` header, never with the token in a URL. The app refuses plain `http://` except to loopback.

## Connect

1. Make the server reachable from the phone over HTTPS: see [remote access](REMOTE-ACCESS.md).
2. Create a token for the phone in the Mac app's Settings (or with `centcom token create`).
3. On the phone, open Connection, enter the server's `https://` address and the token, and tap Connect.

## Build

The Xcode project is generated from `ios/project.yml`; regenerate it after adding files.

```sh
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/CENTCOM.xcodeproj -scheme CENTCOM \
  -destination 'generic/platform=iOS Simulator' build
```

Signing is kept out of the repository. Copy `ios/Signing.xcconfig.example` to `ios/Signing.xcconfig` (git-ignored) and set your `DEVELOPMENT_TEAM`, plus `CENTCOM_BUNDLE_ID` if you are not building the official app. Without it the project still builds for the simulator, but an unsigned simulator build cannot keep a token in the Keychain between launches.

```sh
xcodebuild -project ios/CENTCOM.xcodeproj -scheme CENTCOM \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
xcodebuild -project ios/CENTCOM.xcodeproj -scheme CENTCOM -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/CENTCOM.xcarchive \
  -allowProvisioningUpdates archive
```

## Demo mode

**Explore a demo workspace** on the Connection screen opens a fictional workspace built into the app, so the app can be tried (and reviewed) without a server. `DemoURLProtocol` answers requests to the reserved host `demo.centcom.invalid` from `ios/CENTCOM/Resources/Demo/demo.json`; changes are refused with an explanation and nothing leaves the device. The demo is never remembered across launches. The `-CENTCOMDemo` launch argument opens straight into it (UI tests, App Review notes). Regenerate the fixture with `pnpm build:ios-demo` after API changes: it records real responses from a server seeded with the demo workspace, so the shapes cannot drift.

## TestFlight and the App Store

1. Set `DEVELOPMENT_TEAM` in `ios/Signing.xcconfig`, and `CENTCOM_PRIVACY_URL` / `CENTCOM_SUPPORT_URL` in `ios/Base.xcconfig` (they point at [PRIVACY](PRIVACY.md) and [SUPPORT](SUPPORT.md) in this repository). Both appear in Settings → About.
2. Increase `CURRENT_PROJECT_VERSION` in `ios/project.yml`.
3. `scripts/ios-archive.sh` archives a Release build and exports an App Store Connect `.ipa` to `build/ios/` (`ios/ExportOptions-AppStore.plist`). It uploads nothing.
4. Upload with Xcode's Organizer or Transporter. For review, say in the notes that **Explore a demo workspace** shows the app without a server. The official app's TestFlight feedback and App Review contact address is `info@extendedmind.studio`.

App Store Connect needs the privacy policy and support pages reachable without signing in, so they must be public before submission.

The app declares its data use in `ios/CENTCOM/PrivacyInfo.xcprivacy` (no tracking, nothing collected, UserDefaults for its own preferences) and `ITSAppUsesNonExemptEncryption = NO` (standard HTTPS only). The App Store privacy label is **Data Not Collected**.

## Markdown editor

The phone bundles the same Tiptap Markdown schema as the desktop inside a `WKWebView`, so documents round-trip identically and work offline. `ios/MarkdownWeb/` is the source and `ios/CENTCOM/Resources/Markdown/` the bundled output: run `pnpm build:ios-editor` after editor changes. The bridge forwards only Markdown and layout updates; relative images are fetched natively so the token never reaches JavaScript. `MarkdownTests` loads the bundled editor in WebKit and checks headings, emphasis, checklists, tables and fenced code round-trip.

## Mac and iPhone parity

Ship shared features on both clients together and check both against the same server. A web build or a Swift compile does not establish parity: verify the agent list, agent homes, Library uploads, Skills, Instructions and the saved opening page on both. Both clients read the server's `showInDirectory` field rather than keeping their own exclusion lists.

/**
 * Mac packaging: `pnpm package` → release/CENTCOM-<version>-<arch>.dmg and .zip.
 *
 * Signing: with a Developer ID Application certificate in the keychain (or CSC_LINK /
 * CSC_KEY_PASSWORD), the app is signed with it under the hardened runtime. Without one it is
 * signed ad hoc: fine on this Mac, refused by Gatekeeper anywhere else.
 * Notarization runs when Apple credentials are in the environment: APPLE_API_KEY +
 * APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE (xcrun notarytool
 * store-credentials), or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.
 * Updates: set CENTCOM_RELEASE_OWNER and CENTCOM_RELEASE_REPO to bake in a GitHub Releases feed
 * for electron-updater; `--publish always` uploads the release (never by default).
 */
import { execFileSync } from 'node:child_process';

const env = process.env;
const hasDeveloperId = (() => {
  if (env.CSC_LINK || env.CSC_NAME) return true;
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).includes('Developer ID Application');
  } catch {
    return false;
  }
})();
const notarize = Boolean((env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) || env.APPLE_KEYCHAIN_PROFILE || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID));
const feed = env.CENTCOM_RELEASE_OWNER && env.CENTCOM_RELEASE_REPO ? { provider: 'github', owner: env.CENTCOM_RELEASE_OWNER, repo: env.CENTCOM_RELEASE_REPO, releaseType: 'release' } : null;

// A release must never go out ad hoc signed: Gatekeeper would call it damaged on every other Mac.
if (env.CENTCOM_REQUIRE_DEVELOPER_ID === '1' && (!hasDeveloperId || !notarize)) {
  throw new Error('CENTCOM_REQUIRE_DEVELOPER_ID=1: a Developer ID Application certificate and notarization credentials are required for a release build.');
}

console.log(`[package] signing: ${hasDeveloperId ? 'Developer ID, hardened runtime' : 'ad hoc (no Developer ID certificate found)'}; notarization: ${notarize ? 'on' : 'off'}; update feed: ${feed ? `${feed.owner}/${feed.repo}` : 'none'}`);

/** @type {import('electron-builder').Configuration} */
export default {
  // Neutral by default so a fork doesn't ship under someone else's identifier.
  appId: env.CENTCOM_BUNDLE_ID ?? 'app.centcom.desktop',
  productName: 'CENTCOM',
  copyright: 'Copyright © 2026 The CENTCOM authors',
  directories: { output: 'release', buildResources: 'build' },
  // Everything Node needs is bundled into dist-*, so no node_modules ship at all.
  files: ['package.json', 'dist-electron/**', 'dist-ui/**', 'dist-server/**', 'dist-cli/**', '!**/node_modules/**'],
  asar: true,
  // Served from disk by the embedded server, and run by the system Node (CLI): both stay real files.
  asarUnpack: ['dist-ui/**', 'dist-cli/**'],
  npmRebuild: false,
  nodeGypRebuild: false,
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    // The app's windows authenticate with an injected bearer and keep no cookies, so encrypting the
    // cookie store protects nothing; it would only make macOS stop the app at a Keychain prompt
    // whenever its code signature changes (every ad hoc rebuild).
    enableCookieEncryption: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    darkModeSupport: true,
    target: ['dmg', 'zip'],
    identity: hasDeveloperId ? undefined : '-',
    hardenedRuntime: hasDeveloperId,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    gatekeeperAssess: false,
    notarize,
  },
  dmg: { title: 'CENTCOM ${version}' },
  artifactName: 'CENTCOM-${version}-${arch}.${ext}',
  publish: feed ? [feed] : null,
};

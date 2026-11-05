/**
 * Settings for the public website (`pnpm build:site`). A download link left as null renders as
 * "Coming soon" instead of a button that goes nowhere: fill each one in when it exists.
 */
export default {
  origin: 'https://centcom.app',
  repo: 'https://github.com/elliottrjacobs/centcom',
  contact: 'info@extendedmind.studio',
  publisher: 'Extended Mind Studio LLC',

  /** "CENTCOM: Agent HQ", Apple ID 6830979742. Set to 'https://apps.apple.com/app/id6830979742' on release. */
  appStore: null,
  /** Set to 'https://github.com/elliottrjacobs/centcom/releases/latest' once a notarized build is released. */
  macDownload: null,
  /** Set to the install command once packaging/homebrew/centcom.rb is published, e.g. 'brew install --cask centcom'. */
  homebrew: null,
};

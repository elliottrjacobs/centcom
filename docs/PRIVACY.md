# Privacy policy

CENTCOM is software you run yourself. This policy covers the CENTCOM Mac app, the CENTCOM iPhone and iPad app, the server, the CLI and the MCP endpoint.

## What we collect

Nothing. CENTCOM has no accounts, no analytics, no crash reporting, no advertising and no tracking. The people who make CENTCOM never receive your data, because no CENTCOM component sends anything to them.

## Where your data goes

- **Your server.** Your projects, tasks, documents and agent profiles are plain files on the computer that runs your CENTCOM server, in a folder you choose (by default `~/CENTCOM`). Server settings and access tokens are in `~/.centcom` on that computer.
- **The apps.** The Mac app and the iPhone app talk only to the server you connect them to. The iPhone app keeps its access token in the device Keychain and its preferences on the device; it caches nothing else beyond what is on screen.
- **Agents you connect.** Any AI agent or tool you give a token reads and writes your workspace with that token. What that agent does with the data is governed by that agent's own provider and policy, not this one.
- **Bookmarks.** When you save a link, your server fetches that page to read its title and preview image. The request comes from your server, not from us.
- **Updates.** The Mac app checks this project's GitHub Releases for new versions. GitHub sees that request like any other download; it carries no workspace data.

## Demo mode

The iPhone app's demo workspace is built into the app. Exploring it sends nothing anywhere.

## Your choices

Everything is yours to read, copy, back up or delete with ordinary file tools. Revoke an app's or agent's access at any time by revoking its token (Settings → Tokens, or `centcom token revoke`).

## Contact

Questions about this policy: email [info@extendedmind.studio](mailto:info@extendedmind.studio) or open an issue in this project's GitHub repository. For security reports, see [SECURITY.md](../SECURITY.md).

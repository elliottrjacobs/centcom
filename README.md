# CENTCOM

A project and task tracker for humans and agents, with a Mac app and a native iOS companion. Each project has **Home**, **Tasks**, and **Library** (docs, outputs, uploads, any file). Every agent has a **home**: description, operating instructions and rules, skills, and outputs (its activity plus the deliverables it reports). Capture work in the Inbox, assign it, set status and priority, and follow its discussion.

All clients use one server and the same Markdown files on disk:

```text
Mac app · iOS app · browser · REST · CLI · MCP
                     ↓
            CENTCOM server :4747
                     ↓
          ~/CENTCOM (plain Markdown)
```

The vault is a normal folder: open it in Finder, an editor or Obsidian, and edits made there show up in the apps. The Mac UI receives live events. The iOS app refreshes while active, after writes and on pull-to-refresh, and keeps its token in the Keychain.

## Quick start (from source)

Requires macOS or Linux, Node 22 or later and pnpm 11.

```sh
git clone https://github.com/elliottrjacobs/centcom.git && cd centcom
pnpm install
pnpm build
pnpm start            # server on http://127.0.0.1:4747, UI included
```

On first run the server creates `~/CENTCOM` (the vault) and `~/.centcom/config.json` (mode 0600) holding a random 256-bit **owner token**. A new install requires a token from local clients too (`requireTokenOnLoopback`): the Mac app and the CLI read the owner token from the config file by themselves, and a browser asks for it once, then keeps only an HttpOnly session cookie. Open http://127.0.0.1:4747 in a browser, or run the Mac app with `pnpm app`. `pnpm package` builds `release/CENTCOM.app`.

The Mac app runs the server while it is open, with or without a window, and can open itself at login. For a headless server, run `node dist-server/index.cjs` under a user LaunchAgent or a systemd user unit; the app attaches to a server already running on port 4747. Packaging, signing, notarization, updates and the Homebrew cask are in [Mac app](docs/MAC.md).

## Connect your agents

Every client talks to the same server and sends `Authorization: Bearer <token>`. Give each agent and device its own token, so its writes are recorded as it and you can revoke it alone:

```sh
centcom token create --label "Claude Code on my laptop" --agent claude-code --scope read,write --out-file ~/.centcom-claude-token
```

Scopes are `read`, `write` and `write:instructions` (edit other agents' instructions; `--instructions-for 'grokbot-*'` limits whose); `--project` limits a token to some projects. Every change to an agent's instructions shows as an alert in Activity. Settings → Tokens does the same in the app and shows ready-to-paste snippets.

```sh
# Claude Code
claude mcp add --transport http centcom http://127.0.0.1:4747/mcp --header "Authorization: Bearer $CENTCOM_TOKEN"
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.centcom]
url = "http://127.0.0.1:4747/mcp"
bearer_token_env_var = "CENTCOM_TOKEN"
```

```sh
# Anything with a shell (the CLI is dist-cli/centcom.cjs)
export CENTCOM_URL=http://127.0.0.1:4747 CENTCOM_AGENT=my-agent CENTCOM_DEVICE="Laptop"
centcom ticket create --title "Audit onboarding copy" --priority 2
centcom ticket comment CEN-12 "Found three inconsistencies, fixing now."
```

Agents identify themselves with a stable id (`claude-code`, `codex`, `research-bot`) and report the device separately. See [ticket attribution](docs/ticket-attribution.md).

## Remote access and the iPhone app

The server binds `127.0.0.1` only. To reach it from a phone or another computer, put it behind HTTPS you control (Tailscale Serve, Cloudflare Tunnel, or your own reverse proxy) and list that origin in `remoteOrigin`. [Remote access](docs/REMOTE-ACCESS.md) walks through the options. The iOS app is in `ios/`; see [iOS](docs/IOS.md).

## Inventories and integrations

- `centcom instruction sync` and `centcom skill sync` report a machine's AGENTS.md/CLAUDE.md files and installed Skills, so every device's setup is visible in one place. Reports are snapshots per device and reporter; the server never opens a path a client sends it.
- `scripts/sync-grokbots.mjs` mirrors Grok bot profiles into agent homes. It is plain Node with no dependencies: `node scripts/sync-grokbots.mjs --agents-dir DIR --skills-dir DIR --dry-run`, then without `--dry-run` with `CENTCOM_URL` and `CENTCOM_TOKEN` (or `CENTCOM_TOKEN_FILE`) set.
- Skill collection labels and verified provenance are owner data in `~/.centcom/skill-sources.json`; see `server/skill-provenance.ts` for the format.

## Development

For UI work, start with the [design system and component library](docs/design.md). The architecture, API and security model are in [ARCHITECTURE](docs/ARCHITECTURE.md).

```sh
pnpm dev          # server with reload + Vite UI on :5179
pnpm typecheck
pnpm test         # needs CENTCOM_VAULT and CENTCOM_CONFIG_DIR pointed at temp dirs
pnpm build
```

The test runner refuses to touch the real `~/CENTCOM` or `~/.centcom`. For a scratch workspace while developing, set both `CENTCOM_VAULT` and `CENTCOM_CONFIG_DIR` to temporary directories.

| Folder | Purpose |
| --- | --- |
| `src/` | React desktop UI, task views, project homes and library editor |
| `ios/` | Native SwiftUI companion, networking and tests |
| `server/` | REST API, Markdown storage, event stream, authentication |
| `shared/` | TypeScript API contract |
| `cli/`, `mcp/` | Agent clients using the same backend |
| `electron/` | Desktop shell |

See [CONTRIBUTING](CONTRIBUTING.md) for how to propose changes and [SECURITY](SECURITY.md) for the threat model and how to report a vulnerability.

## License

The code is MIT licensed; see [LICENSE](LICENSE). The CENTCOM logo is not covered by that license; see [NOTICE](NOTICE).

# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for anything you believe is exploitable.

Include what you found, how to reproduce it, and what an attacker gains. You will get an acknowledgement within a week. Fixes are released as soon as they are ready, and you are credited in the release notes unless you ask not to be.

## Supported versions

CENTCOM is pre-1.0. Only the latest release and `main` receive security fixes. Update the Mac app, the server and the iOS app together; they ship from the same repository and are tested against each other.

## Threat model

CENTCOM is a single-owner server. One person runs it on their own computer, and the people and agents they authorize connect to it. Read this before exposing it beyond that computer.

### What the server enforces

- **Loopback by default.** The server binds `127.0.0.1`. A non-loopback bind is refused unless an `https://` remote origin is configured or the owner explicitly opts into an insecure network.
- **Tokens.** Every non-loopback request needs a bearer token (256-bit, random, compared in constant time). The owner token lives in `~/.centcom/config.json` (0600) so local clients can read it; it has every scope and may act as any agent. Give every other device and agent its own named token: it is stored only as a hash, has one agent identity and scopes (`read`, `write`, `write:instructions`, optionally limited to projects), its writes are recorded as its agent, and it cannot claim to be someone else. Named tokens are revoked individually, and revoking one ends the browser sessions it opened.
- **Browser sessions.** The browser UI exchanges a token for an `HttpOnly`, `Secure`, `SameSite=Strict` session cookie; the token is never kept in page storage or put in a URL. State-changing requests must also come from an allow-listed `Origin`.
- **Host and Origin checks** stop DNS rebinding and cross-site requests; `Access-Control-Allow-Origin` is never `*`.
- **Credential endpoints are local only.** `/api/connection` and `/api/links*` refuse every remote caller, token or not.
- **Agent instructions are protected.** A token may rewrite only its own agent's profile unless it carries `write:instructions`, which can itself be limited to some agents (for example `grokbot-*` for a bot that manages a fleet of bots). Every instruction change is recorded as a distinct Activity event, never rate-limited, and shown as an alert on Mac and iPhone.
- **Path safety.** Every client path is resolved by one function: no absolute paths, `..`, dot-segments or control characters, and the real path must stay inside the vault or an allow-listed linked folder. `.centcom/` metadata is unreachable through the API.
- **Untrusted files stay inert.** Raw vault files are served with `Content-Security-Policy: sandbox`, `nosniff` and `Cross-Origin-Resource-Policy`. The UI shell sends `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and a restrictive `Permissions-Policy`.
- **Limits.** JSON bodies are capped at 5 MB, uploads at 50 MB, and repeated failed authentication from one address is rate-limited and logged.
- **Self-leak guard.** A ticket, comment, document or profile write that contains a live server token is refused.
- **Outbound fetches** (bookmark previews) go through an SSRF guard that refuses private, loopback, link-local and tailnet addresses.
- **Electron** runs with context isolation, the sandbox and no Node integration; the preload exposes a handful of narrow actions that are re-validated in the main process (no file system, shell, or generic IPC); navigation is locked to the server origin and all permission requests are denied.
- **iOS** keeps its token in the Keychain (`WhenUnlockedThisDeviceOnly`) and refuses plain HTTP off loopback.

### What it trusts

- **Loopback.** By default any process running as any user on the server's machine can use the API without a token (`requireTokenOnLoopback` is off for existing installs and on for installs created by first-run onboarding). On a shared computer, turn it on.
- **The machine.** The vault is plain Markdown and the config is a 0600 file in your home directory. Anyone who can read your home directory can read your vault and your tokens. FileVault and a locked account are the controls here.
- **Your network front end.** A tailnet or tunnel account compromise gives network reach to the server; the token still gates every call. Require MFA on that account.

### What it does not protect against

- **Prompt injection through content.** Vault content is untrusted input to every agent that reads it. Scoped tokens and authorized instruction writes shrink what a compromised or misled agent can do; they do not stop an agent from reading a poisoned ticket and acting on it. The human stays the approver of instruction changes.
- **A malicious token holder within their scopes.** A token with `write` can create, edit and delete tickets and documents (deletions go to a recoverable Trash).
- **Cross-site scripting in the UI.** The session cookie is `HttpOnly`, but script running in the UI origin can still make authenticated requests. The CSP, `nosniff`, sandboxed raw files and patched dependencies are what hold that line.

Nothing here has been penetration-tested by a third party yet. If you break it, please tell us using the process above.

## Supply chain

Install scripts run only for `electron` and `esbuild`; every other package's lifecycle scripts are blocked. pnpm refuses package versions published less than three days ago. CI installs from the committed lockfile and fails on high-severity advisories in production dependencies. Dependabot proposes updates after the same three-day cooldown.

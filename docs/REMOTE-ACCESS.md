# Remote access

CENTCOM listens on `127.0.0.1:4747` and nowhere else by default. Nothing is exposed to your network until you choose to. Remote access is for your own other devices (a phone, a laptop) and for agents running elsewhere; it is not needed for agents on the same machine.

## The rule: HTTPS in front, token on every request

Bearer tokens must never cross a network in cleartext. Put the server behind something that terminates TLS, and keep the server itself on loopback:

```text
phone / laptop / remote agent ──HTTPS──► your TLS front end ──http──► 127.0.0.1:4747
```

Every request that does not come from the server's own machine needs `Authorization: Bearer <token>`, and the browser UI exchanges a token for an HttpOnly session cookie. Endpoints that hand out credentials or touch local configuration (`/api/connection`, `/api/links*`) refuse remote callers even with a valid token.

If you bind a non-loopback `host` yourself, the server refuses to start unless `remoteOrigin` lists an `https://` origin, or you explicitly set `CENTCOM_ALLOW_INSECURE_REMOTE=1` (only for an isolated test network).

## Tell the server its public origin

Add the HTTPS origin your devices will use to `~/.centcom/config.json`, then restart the server:

```json
{ "remoteOrigin": ["https://centcom.example.com"] }
```

The Host and Origin checks (anti DNS-rebinding and anti-CSRF) only accept loopback names and the origins listed here.

## Pick a front end

Any of these works; none is required.

- **Tailscale Serve** keeps the server private to your tailnet: `tailscale serve --bg --https=443 http://127.0.0.1:4747`, then use `https://<machine>.<tailnet>.ts.net`. Require MFA on the tailnet, and do not reuse the machine's auth key.
- **Cloudflare Tunnel** with Cloudflare Access in front of it, if you want reach from devices outside a VPN. Put an Access policy on the hostname; the CENTCOM token alone should not be your only gate on the public internet.
- **Your own reverse proxy** (Caddy, nginx) with a real certificate. Proxy to `http://127.0.0.1:4747`, pass the `Host` header through, and disable response buffering for `/api/events` (server-sent events).

## Tokens for remote clients

Give each device and agent its own token (Settings → Tokens, or `centcom token create`) so you can see which one wrote what and revoke one without touching the others. The CLI refuses to send the local machine's config token to a non-loopback `--url`; pass `CENTCOM_TOKEN` explicitly for remote use.

## What remote access does not protect

- Vault content is untrusted input to every agent that reads it. Tokens limit who can write; they do not stop an agent from acting on a poisoned ticket.
- Anyone with network reach still needs a token, but your front end's account (tailnet, Cloudflare) is part of your security boundary. Protect it with MFA.

See [SECURITY](../SECURITY.md) for the full threat model.

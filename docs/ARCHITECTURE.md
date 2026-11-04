> Product scope: tasks, project homes, the project Library (formerly Wiki), and agent homes. Older document and link APIs remain for compatibility. See README.md, docs/IOS.md and docs/REMOTE-ACCESS.md for clients and deployment.

# CENTCOM architecture

CENTCOM is the single source of truth for every agent and bot its owner runs
(Claude Code, Codex, ChatGPT, Grok, Cursor, …) across every machine. Who the owner is comes
from the config file, never from the source: anyone can run it. It is a
**markdown vault on disk** plus one **local server** that everything talks to.

```
            ┌────────────── Mac app (Electron) ──────────────┐
            │  React UI  ──HTTP/SSE──►  embedded server      │
            └────────────────────────────┬───────────────────┘
 agents ── MCP (/mcp or stdio) ──┐       │
 agents ── `centcom` CLI ────────┼─► REST /api ──► vault (~/CENTCOM, plain files)
 agents ── direct file edits ────┘       ▲
                                         └── chokidar watcher → index → SSE
```

The contract lives in `shared/types.ts`. Read it first; it is authoritative.

## Ownership (parallel work — do not cross lines)

| Area | Paths |
| --- | --- |
| Server, CLI, MCP, tests | `server/**`, `cli/**`, `mcp/**` |
| UI, Electron shell, build scripts, configs | `src/**`, `electron/**`, `scripts/**`, root configs |
| Contract | `shared/types.ts` — additive changes only, and report them |

## Config

`~/.centcom/config.json` (mode 0600), created on first run:

```json
{ "vault": "<home>/CENTCOM", "port": 4747, "host": "127.0.0.1", "token": "<64 hex chars>", "user": { "id": "sam", "name": "Sam" } }
```

Optional keys: `remoteOrigin` (https origin(s) of a TLS front end), `requireTokenOnLoopback`
(local clients must authenticate too; written as `true` when the server creates the file on
first run, absent and therefore off in configs that predate it), `legacyQueryToken` (one release
only), `serverUrl` (desktop/CLI client of a remote server), `links`. Next to it, both 0600:
`tokens.json` (named tokens, SHA-256 hashes only) and `sessions.json` (browser sessions, hashes
only).

Env overrides: `CENTCOM_VAULT`, `CENTCOM_PORT`, `CENTCOM_HOST`, `CENTCOM_CONFIG_DIR`
(tests point this at a temp dir), `CENTCOM_USER_ID`, `CENTCOM_USER_NAME`. Overrides are never
persisted. `token` is generated with `crypto.randomBytes(32)`.

`user` is the human who owns the vault: `id` is the agent id that writes with no explicit author
are attributed to (and the seeded human agent), `name` is what agents are told. Nothing in the
code names a person. When the key is absent it is derived ONCE and written back, so it never
shifts under an existing vault: a vault already in use keeps the first `kind: "human"` in its
`.centcom/agents.json` (upgrading never splits someone's history across two ids); otherwise
`os.userInfo().username` → id = lowercase slug, name = first token capitalised (`sam.smith` →
`sam.smith` / `Sam`). A config written before `user` existed therefore keeps working unchanged.
Exposed as `ServerInfo.user`.

## Security (non-negotiable)

Skills stored here are instructions that every agent will follow, so a write
primitive on this server is a prompt-injection primitive against all of them.

1. **Bind `127.0.0.1` by default.** `remote` is true only when host is not loopback. A
   non-loopback bind is refused at startup unless `remoteOrigin` lists an `https://` origin
   (TLS terminates in front of the server) or `CENTCOM_ALLOW_INSECURE_REMOTE=1` is set.
2. **Token auth for non-loopback peers.** `Authorization: Bearer <token>`, hashed and
   compared with `crypto.timingSafeEqual`. Loopback peers need no token unless
   `requireTokenOnLoopback`; a valid token sent from loopback still counts as that token.
   The `config.json` token is the **owner** token: every scope, any agent. Named tokens
   (`POST /api/tokens`, `centcom token create`, Settings → Tokens) each have an agent id,
   scopes (`read` = every GET, `write` = every other write, `write:instructions` = any agent's
   profile) and optionally a project list. A named token's writes are recorded as its agent;
   a body or query that claims another `agent`/`createdBy`/`by` is 403. A project-limited
   token sees only those projects' tickets, docs, raw files, search hits, activity and tree,
   and cannot use vault-wide endpoints (events, inventories, trash, reindex, project create).
   MCP tool calls run with the token of the `/mcp` request that made them.
   **Agent profiles are instructions.** `PUT /api/agents/:id/profile` and the deliverable
   endpoints accept the owner (owner token, or trusted loopback) for any agent; a named token
   for its own agent with `write`; and for anyone else only with `write:instructions`, limited
   to the token's `instructionAgents` patterns (`grokbot-*`) when it has them. Every change to
   an agent's description, instructions or skills records an `agent.instructions_changed`
   activity event (writer, `target`, changed fields with before/after sizes), never
   rate-limited, shown as an alert row in both clients' Activity.
   Browsers use a **session cookie** instead: `POST /api/session { token }` (the Connect
   screen) sets `__Host-centcom_session` (`HttpOnly; Secure; SameSite=Strict; Path=/`; the
   plain `centcom_session` without `Secure` only for plain-http loopback). Only a SHA-256 of
   the session id is stored, in `<configDir>/sessions.json` (0600); sessions die after 7 days
   idle and 30 days total, and with the token they were opened with. `DELETE /api/session`
   ends one. A cookie never opens the loopback-only endpoints, and a write that rides on a
   cookie must carry an allow-listed `Origin`. `?token=` is refused unless `legacyQueryToken`
   is set in config (GET `/api/raw/*` and `/api/events` only; removed next release).
   Failed authentication is logged with the peer address (never the query string) and
   rate-limited per peer: 30 failures in 15 minutes turn further 401s into 429s.
3. **Origin check (anti-CSRF).** If a request carries an `Origin` header it must be
   `http://127.0.0.1:<port>`, `http://localhost:<port>`, the Vite dev origins
   (`http://localhost:5179`, `http://127.0.0.1:5179`), or the configured remote
   origin. Otherwise 403. Requests with no `Origin` (curl, CLI, MCP) pass, except
   cookie-authenticated writes and `POST`/`DELETE /api/session`, which require one.
   Never send `Access-Control-Allow-Origin: *`.
4. **Host check (anti DNS-rebinding).** `Host` must be `127.0.0.1`, `localhost`,
   `[::1]`, or the configured host (any port). Otherwise 403.
5. **Path safety.** Every client path goes through one `resolveVaultPath()`:
   reject absolute paths, `..`, NUL bytes, and any dot-prefixed segment; after
   resolving, `fs.realpath` of the nearest existing ancestor must stay inside the
   vault's realpath, or, for a path at or beneath an allowlisted link's mount, inside
   that link's real target (see *Linked folders*). Every other symlink that leaves the
   vault is unreachable. Unit-test this.
6. Upload cap 50 MB. JSON body cap 5 MB. A JSON write that contains a live server token
   (any case) is refused with 400: the likeliest self-inflicted leak.
7. **Headers.** Every response: `Referrer-Policy: no-referrer`. All `/api/*`:
   `Cache-Control: no-store`, `nosniff`. The UI shell: `Content-Security-Policy:
   frame-ancestors 'none'`, `X-Frame-Options: DENY`, a deny-all `Permissions-Policy`; its
   meta-tag CSP loses the Vite HMR sources in production builds (`vite.config.ts`). Raw vault
   files: `sandbox` CSP (except PDF/media), `frame-ancestors 'none'`, CORP same-site.

## Vault layout

```
~/CENTCOM/
  AGENTS.md                 how any agent should use CENTCOM (seeded)
  Skills/<skill>/SKILL.md   global skills (Agent Skills format)
  Projects/<slug>/
    project.md              frontmatter: key,status,summary,color,icon,lead,created,updated · body = overview
    Tickets/<KEY>-<n>.md
    Roadmap/*.md            frontmatter `stage`: idea|later|next|now|shipped
    Library/**              the project's docs, documentation, outputs, uploads, any file (formerly Wiki/, see below)
    Skills/<skill>/SKILL.md project-scoped skills
  Agents/<agent-id>.md      agent home: profile + reported deliverables (see *Agent homes*)
  Taste/**                  images, PDFs, video, audio + writing samples; sidecar = `<file>.<ext>.md`
  Library/**                learnings, research
  Library/Links/<Title>.md  saved websites (`type: link`, see *Bookmarks*); previews in `Library/Links/assets/`
  Inbox/INB-<n>.md          tickets with no project
  .centcom/counters.json    { "<KEY>": lastNumber }
  .centcom/agents.json      Agent[]
  .centcom/activity/YYYY-MM.jsonl   ActivityEvent log; append-only except comment edits and deletes
  .trash/<epochms>-<name>   soft deletes (+ `<same>.json` with { originalPath })
```

Dot-folders never appear in the tree or search.

**Project Library (formerly Wiki).** At startup, before indexing, `server/migrate-library.ts` renames
every real `Projects/<Name>/Wiki` folder to `Library`. When a `Library` already exists it merges:
nothing is overwritten; an identical file is dropped from Wiki, a different one moves in as
`<name> (from Wiki)<ext>` with its sidecar; Wiki is removed once empty. A project that is a symlink,
a Wiki that is a symlink, or a Wiki holding a link mount is left alone and logged. Idempotent; file
contents are never rewritten. Instead, the path resolver aliases `Projects/<Name>/Wiki/…` (and
`…/wiki/…`) to `…/Library/…` on every endpoint that takes a vault path, unless a Wiki folder is still
on disk; responses always report the canonical Library path. (The root `Library/` is unrelated.)

## Agent homes

`Agents/<agent-id>.md`, one per agent, created on first write. Frontmatter: `id`, `name`, `source`
(`grokbot-sync` | `self-reported`), `updated` (ISO), `updated_by`, `skills` (`{name, description}[]`),
`deliverables` (`{id, title, url, kind, date, project?, note?, added_by}[]`, newest first). Body:
`## Description`, then `## Instructions and rules`. Read liberally (no headings = all description;
string skills; missing ids get a stable hash of the url), written deterministically. A PUT that
changes nothing does not touch the file or `updated`. The registry stays the source of id / name /
kind / colour / lastSeen; writing a profile registers an unknown agent (without marking it seen)
and `name` renames it there. Writes broadcast `{ type: 'agent', id }`, record `doc.created` /
`doc.updated` activity for the writer, and touch the writer's presence.

**File kinds.** `markdown`, `image`, `pdf` (.pdf), `video` (.mp4 .mov .webm .m4v), `audio`
(.mp3 .wav .m4a .aac .ogg .flac), `other`, all by extension; and `link`, the one kind decided by
content: a markdown file whose frontmatter has `type: link` and a string `url`.

**Sidecars.** Any non-markdown `<file>.<ext>` may have a note `<file>.<ext>.md` beside it. The
note is hidden from the tree, exposed as `TreeNode.sidecar`, surfaced in search through its file,
and moves, duplicates, is trashed and is restored with it. The host must have an extension, so
`README` + `README.md` stay two documents.

## Linked folders

CENTCOM is a tracker, a knowledge base and the one place to *see* everything. It is not
the runtime source agents load skills from: skills already have canonical homes (a git
repo symlinked into each tool, per-project skills directories). Copying them into the
vault would create a second copy that drifts, so CENTCOM mounts those real folders in
place instead.

```json
"links": [{ "mount": "Skills/shared", "target": "/abs/path/to/skills", "readonly": false }]
```

- **Config is the allowlist.** `links` lives in `~/.centcom/config.json` (`readonly`
  defaults to false, a missing key means none). There is no API to add, change or remove a
  link. `centcom link add|remove|list` edits the local config and the symlink directly.
- **A mount is a real symlink** at `<vault>/<mount>` → `target`, so Finder, Obsidian, grep
  and agents reading files directly see it too. A configured link whose symlink is missing
  is created on load; a mount path occupied by anything else is never replaced.
- **Validation (on load and in `link add`).** `target` must be absolute, exist and be a
  directory, and must not be `/`, the home folder (or anything containing it), the vault,
  inside the vault, a folder containing the vault, or the config dir (or anything
  containing / inside it). `mount` must pass the normal client-path rules, start with one
  of the root folders, be at least two segments deep, and not overlap another link.
  Invalid entries are dropped with a logged warning; they never stop the server.
- **Path safety** is the same single resolver with one more permitted container (security
  point 5). Dot-segments are still rejected, so a linked repo's `.git` is unreachable,
  unindexed and unwatched. A symlink that merely *points into* an allowlisted target from
  somewhere other than its mount stays invisible.
- **Tree / index / watcher.** The mount node is `type: 'dir'` with `linked: true`; its
  children are listed, indexed and searchable like any others. Entries *inside* a link
  that are themselves symlinks are skipped. chokidar does not follow symlinks, so each
  link's real target is watched as an extra root and its events are mapped back to
  `<mount>/…`. `GET /api/info` lists the valid links.
- **Writes.** Under a `readonly` link every mutation is 403 `forbidden`. A mount, and any
  folder that contains a mount, can never be renamed, moved, deleted or duplicated through
  the API, read-only or not. Inside a writable link normal CRUD applies and edits land in
  the real file. Soft delete never touches a mount, and moving to / from `.trash` survives
  a different volume (`EXDEV` → copy, then remove).
- **Reload.** `POST /api/links/reload` re-reads the config, rebuilds the index and the
  watchers and broadcasts `{ type: 'tree' }`. It is loopback-only *even with a valid
  token*: a remote token-holder must not be able to influence what is mounted.
- **Git awareness.** A link is often a subfolder of a clone, and a clone that is behind its
  remote shows stale content without a word. `GET /api/links/git` reports, per valid link,
  `LinkGitStatus` from LOCAL refs only (repo found with `git -C <realTarget> rev-parse
  --show-toplevel`; branch / upstream / ahead / behind / dirty from one `git
  --no-optional-locks status --porcelain=v2 --branch`; `fetchedAt` = mtime of `FETCH_HEAD`).
  `POST /api/links/git/fetch` runs `git fetch --quiet` (one link or all; several links into one
  clone fetch it once; a failed fetch is reported on that link's `error`, not thrown).
  `POST /api/links/git/pull` refuses with 409 `conflict` when the work tree is dirty (untracked
  files count, anywhere in the clone), there is no upstream, or `ahead > 0`; otherwise
  `git pull --ff-only --no-rebase`, then the link is reconciled into the index and
  `{ type: 'tree' }` is broadcast before the response is sent. A `readonly` link may be pulled:
  read-only governs edits through the API, not the owner updating their own clone. All three are
  loopback-only even with a valid token (they use the owner's git credentials and network).
  Exec safety: `execFile('git', [fixed args], { cwd, timeout: 30000 })` with
  `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo` and `GIT_DIR`-style variables removed; never a
  shell. The only client input is `mount`, matched exactly against the allowlist; it never
  becomes an argument. No git on the PATH → `repo: false` with an `error`.
- **Frontmatter is preserved byte-for-byte** unless a key or value really changed, and a
  file keeps its final-newline convention, so saving a body never dirties a file that lives
  in someone's git repo. (Applies to every doc, linked or not.)

### Ticket file

```markdown
---
id: CEN-12
title: Fix the flaky import test
status: todo            # backlog|todo|in_progress|in_review|done|canceled
priority: 2             # 0 none,1 urgent,2 high,3 medium,4 low
agent: claude-code      # owner, or null
created_by: codex
labels: [tests, import]
due: null
parent: null
previous_ids: []
created: 2026-09-19T20:00:00.000Z
updated: 2026-09-19T20:00:00.000Z
---
Markdown description.
```

Rules:
- Next number = `max(counter, highest on disk) + 1`, allocated under an in-process
  async mutex, then counter persisted. Never reuse a number.
- Be liberal in what you read: agents may hand-write ticket files. Missing fields get
  defaults (`status: backlog`, `priority: 0`, id from filename, title from first H1 or
  filename). Never crash the index on a malformed file; skip + log.
- Changing `project` moves the file, allocates a new id from the target key, and
  pushes the old id onto `previous_ids`. Lookups by an old id still resolve.
- Every create/update/comment/delete appends an `ActivityEvent` and touches the
  acting agent's `lastSeen`. Unknown agent ids are auto-registered
  (name = title-cased id, deterministic color from a fixed palette, kind `agent`).

### Changing comments

A comment is the one event that can change after it is written, so a correction or a leak
can be taken back. Editing or deleting rewrites that line of its month file in place
(`ActivityLog.replace`: atomic, serialised with appends). The old text is not kept
anywhere, and no extra event is appended. The comment keeps its id, `ts`, author and
device and records who changed it: `editedAt` / `editedBy`, or, on delete, `deletedAt` /
`deletedBy` with `body` removed. Only the comment's author (a named token bound to that
agent) or the owner may change it; project-confined tokens are also held to their projects.
A change is pushed as `{ type: 'activity', event, replaced: true }` so clients update the
event where it is. `/api/info` reports `caller: { agent, owner }` so clients offer the
actions only where they will succeed.
- Writes are atomic: temp file in the same dir, then `rename`.

Seed agents: the configured `user` (human), `claude-code`, `codex`, `chatgpt`, `grok`, `cursor`.
An existing roster that lacks the configured user gains them as a human on load.

## REST API (all JSON unless noted; errors are `ApiError` with a fitting status)

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | `{ ok: true }` |
| `GET /api/info` | `ServerInfo` |
| `GET /api/tree` | `TreeNode` for the vault root (full recursion) |
| `GET /api/doc?path=` | `Doc` |
| `PUT /api/doc` | body `WriteDocInput`; creates or updates; 409 on `ifMatch` mismatch → `Doc` |
| `POST /api/doc` | body `{ path, body?, frontmatter?, agent? }`; 409 `exists` if present → `Doc` |
| `DELETE /api/doc?path=` | soft-delete a file **or folder** to `.trash` → `{ ok, trashId }` |
| `POST /api/folder` | body `{ path }` → `TreeNode` |
| `POST /api/move` | body `{ from, to, agent? }`; files or folders; 409 if target exists → `{ path }` |
| `POST /api/duplicate` | body `{ path }` → `{ path }` (“Name copy.md”) |
| `POST /api/upload?dir=&name=` | raw request body = file bytes, any type; de-dupes name (`a 2.png`) → `TreeNode` |
| `GET /api/raw/<path>` | raw bytes with correct `Content-Type`; `Cache-Control: no-store` (ETag from mtime for explicit revalidation); `Accept-Ranges: bytes`, single-range `Range` → 206 / 416, `If-Range` honoured (what video/audio seeking and a PDF viewer need). Everything is `nosniff` + CSP `default-src 'none'`; html/js/css are served as `text/plain` and everything except pdf/video/audio also gets CSP `sandbox` (built-in viewers cannot run inside one, and those types cannot script) |
| `POST /api/bookmarks` | `SaveBookmarkInput` → `Doc`; 201 when created, 200 with the existing `Doc` when that `url` is already in that folder. See *Bookmarks* |
| `POST /api/bookmarks/refresh` | `{ path, agent? }` → `Doc`; re-fetches metadata, keeps notes / tags / a chosen title; 502 (file untouched) when the page cannot be fetched |
| `POST /api/reindex` | normal auth; walks the whole vault (links included), reconciles the index with the disk, always broadcasts `{ type: 'tree' }` → `{ ok, files, tickets, projects }` |
| `GET /api/tickets` | query: `project`, `status` (csv), `agent`, `label`, `q`, `parent` → `Ticket[]` |
| `POST /api/tickets` | `CreateTicketInput` → `Ticket` |
| `GET /api/tickets/:id` | `{ ticket: Ticket, activity: ActivityEvent[], children: Ticket[] }` |
| `PATCH /api/tickets/:id` | `UpdateTicketInput` → `Ticket` |
| `DELETE /api/tickets/:id?by=` | soft delete → `{ ok }` |
| `POST /api/tickets/:id/comments` | `{ body, agent }` → `ActivityEvent` |
| `PATCH /api/tickets/:id/comments/:commentId` | `{ body, agent? }` → the same `ActivityEvent` with the new `body`, `editedAt` and `editedBy`. See *Changing comments* |
| `DELETE /api/tickets/:id/comments/:commentId?by=` | tombstone: the event keeps its id, author and time, loses `body`, gains `deletedAt` / `deletedBy` → `{ ok }` (again: no-op) |
| `GET /api/projects` | `Project[]` |
| `POST /api/projects` | `CreateProjectInput` → `Project` (creates section folders) |
| `GET /api/projects/:slug` | `Project` |
| `PATCH /api/projects/:slug` | `UpdateProjectInput`; `name` change renames the folder → `Project` |
| `DELETE /api/projects/:slug` | soft delete whole folder → `{ ok }` |
| `GET /api/activity?limit=&agent=&project=&ticket=` | `ActivityEvent[]`, newest first (default 100, max 500) |
| `GET /api/agents` | `Agent[]` |
| `PATCH /api/agents/:id` | `{ name?, color?, kind? }` → `Agent` |
| `GET /api/agents/:id/home?limit=` | `AgentHome` (agent, profile or null, deliverables, its own activity newest first, default 50, max 500); 404 when the agent is neither registered nor has a profile |
| `GET /api/agents/:id/profile` | `AgentProfile`, 404 if none |
| `PUT /api/agents/:id/profile` | `UpsertAgentProfileInput` → `{ profile, changed }`; `changed: false` = nothing differed, nothing written |
| `POST /api/agents/:id/deliverables` | `AddAgentDeliverableInput` → `AgentDeliverable`; 201 new, 200 when that url was already reported (entry updated) |
| `DELETE /api/agents/:id/deliverables/:deliverableId?agent=` | → `{ ok }` |
| `GET /api/search?q=&limit=&scope=` | `SearchHit[]`; `scope=tasks` = tickets, projects, project Library docs; any other scope is a vault folder (aliased like every path) |
| `GET /api/trash` | `{ id, name, originalPath, deletedAt, isDir }[]` |
| `POST /api/trash/restore` | `{ id }` → `{ path }` (409 if the original path is occupied) |
| `DELETE /api/trash?id=` | permanently delete one item, or all when `id` omitted → `{ ok }` |
| `GET /api/events` | SSE stream of `ServerEvent` (`data: <json>\n\n`), heartbeat comment every 25 s |
| `POST /api/session` `{ token }` | browser sign-in: sets the session cookie (see Security). Needs an allow-listed `Origin`; rate-limited with failed auth |
| `GET /api/session` | `{ via, session }`: how this request was authenticated, and the session's expiry |
| `GET /api/tokens` | owner only: the owner token and every named token (`TokenInfo`, never a secret) |
| `POST /api/tokens` `CreateTokenInput` | owner only → `CreatedToken`; the secret is in this response and nowhere else, ever |
| `DELETE /api/tokens/:id` | owner only: revoke; ends the browser sessions it opened → `{ ok, revoked, sessionsEnded }` |
| `DELETE /api/session` | ends this browser's session and clears the cookie |
| `POST /api/links/reload` | loopback peers only, token or not: re-read `links` from config, rebuild index + watchers → `{ links: LinkInfo[] }` |
| `GET /api/links/git` | loopback only → `LinkGitStatus[]`, one per valid link, local refs only |
| `POST /api/links/git/fetch` | loopback only; `{ mount? }` → `git fetch --quiet` for that link or all → fresh `LinkGitStatus[]` |
| `POST /api/links/git/pull` | loopback only; `{ mount }` → 409 if dirty / no upstream / ahead, else `git pull --ff-only`, reconcile, broadcast tree → `LinkGitStatus` |

If `dist-ui/index.html` exists, serve the built UI at `/` (SPA fallback for non-`/api`, non-`/mcp` GETs).

## Index + watcher

In-memory index of all markdown (path, title, frontmatter, lowercase body), tickets,
projects. The watcher covers the vault and each link's real target (dot-entries ignored relative
to their root, so `.trash`, `.git`, `.centcom/activity`, `.DS_Store` never count), debounced
~80 ms, updates the index incrementally and broadcasts `ServerEvent`s. API writes update the
index synchronously and broadcast too; de-dupe watcher echoes by comparing mtime. External edits
to a doc emit `doc.updated` activity attributed to agent `filesystem` at most once per file per 60 s.

**Watch backends (`server/watcher.ts`).** macOS: one recursive `fs.watch` handle per root.
Everywhere else: chokidar. The split exists because of a bug seen in production: a `git pull`
in a link target removed one folder and added eight, and the index saw the removal but never the
additions. Root cause: on macOS every `fs.watch` directory handle in the process is served by
one FSEvents stream, which libuv tears down and re-creates ("since now") each time a handle is
added; chokidar 5 (no FSEvents backend) adds a handle for every directory it discovers. The
first new folder of a burst therefore makes chokidar add handles exactly while the rest of the
burst's events are in flight, those events are lost with the old stream, and chokidar only
re-reads a directory when an event for it arrives. Plain vault folders were affected the same
way. One recursive handle per root, created once, never restarts the stream mid-burst. The
native backend proves it is live before `ready` resolves by touching a probe file inside
`.centcom/` until its event comes back (the vault handle is created last, so its event proves
the final stream covering every root is running).

**Events are hints, the disk is the truth.** Every reported path is reconciled with
`VaultIndex.syncMany`; a folder means its whole subtree, so new folders never depend on per-file
events. After a burst in which folders came or went, the PARENT of each is walked again ~400 ms
after things go quiet (siblings whose events were lost), repeating up to three more times while
that keeps finding changes. `POST /api/reindex` does the same for the whole vault on demand.

Search scoring: exact ticket-id match ≫ title prefix > title substring > path > body.
Snippet = ±60 chars around the first body hit. Saved links match on title, `url`, `site`,
`description` and tags and are `type: 'doc'` hits. Images are `type: 'image'`; PDFs, video and
audio are found by file name and sidecar note as `type: 'doc'` hits at the file's own path; any
other file only once it has a sidecar note.

## Bookmarks

A saved website is a file like everything else: `<dir>/<Title>.md` (`dir` defaults to
`Library/Links`, resolved by the one path resolver, read-only links refused), frontmatter
`type: link`, `title`, `url`, `site` (hostname without `www.`), `description`, `image` (vault path
of a locally stored preview, only when one was fetched), `tags`, `saved` (ISO), `saved_by`, plus
`fetch_error` (a fixed generic phrase) when the page could not be fetched. Body = the note.

- **A dead site never loses the link.** Whatever goes wrong with fetching (blocked, DNS, timeout,
  HTTP error, not HTML) the bookmark is still saved; the title falls back to `input.title`, then
  to `host/path`. Only non-http(s) URLs and URLs carrying credentials are rejected (400): the
  first would be script the moment a UI renders it as a link, the second would store a password
  in plain text.
- **Dedupe.** Same normalised `url` in the same folder → the existing `Doc`, 200, nothing
  fetched. Saves are serialised per (folder, url), so two agents saving one page get one file.
- **Metadata.** title: `og:title` → `twitter:title` → `<title>`; description: `og:description` →
  meta description; image: `og:image` → `twitter:image`, resolved against the FINAL url. Entities
  decoded, control / zero-width / bidi characters removed, whitespace collapsed, 200 / 500 char
  caps. HTML is parsed by a linear scanner over at most 2 MB (no HTML parser dependency, and no
  regex that a hostile page could make quadratic).
- **Preview.** Stored at `<dir>/assets/<slug>-<hash8(url)>.<ext>`. png / jpeg / webp / gif only,
  decided by magic bytes, never by `Content-Type` or extension, so an SVG can never be stored;
  5 MB cap. It goes to the trash, and comes back, with its bookmark.
- **Tree.** `kind: 'link'` with `url`, `site`, `thumb`, `description`, `title`. `thumb` is only
  ever a vault path to an image file (a hand-written link cannot make the UI load a remote
  image). A folder named `assets` is hidden from the tree while every file in it is some link
  file's `image` (still served by `/api/raw`); one unclaimed file or any sub-folder and it is an
  ordinary folder again.
- **Refresh** keeps the body, tags, `saved`, `saved_by`, and any title a person chose (the title
  is only filled in while it is still the `host/path` placeholder).

### SSRF guard (`server/ssrf.ts`)

Saving a bookmark makes this machine fetch a URL chosen by the caller, who may be any agent or a
remote token-holder. Unfenced, that is a read primitive against loopback services (this server
included), the LAN, cloud metadata and every device on the tailnet.

1. `http:` / `https:` only, no credentials, any port. Host names `localhost`, `*.localhost`,
   `*.local`, `*.internal`, `*.ts.net` (and `.lan`, `.home.arpa`, …) are refused outright.
2. The name is resolved here (`dns.lookup({ all: true })`) and the request is refused if ANY
   answer is loopback (127/8, ::1), private (10/8, 172.16/12, 192.168/16), link-local
   (169.254/16 incl. 169.254.169.254, fe80::/10), CGNAT 100.64/10 (Tailscale), unique-local
   fc00::/7, unspecified, multicast, reserved / documentation space, or an IPv6 spelling of any of
   those (IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo). Unparseable → refused.
3. The socket connects to exactly the validated address: the request gets a `lookup` that
   returns it, so there is no second resolution for DNS rebinding to win. `Host` and SNI stay
   the original name. A fresh socket per request (`agent: false`).
4. Redirects are followed by hand, at most 5, and every hop passes 1–3 again.
5. 8 s budget per fetch (redirects included), 2 MB of HTML (reading stops there; the cap is on
   decoded bytes), 5 MB image. A plain `User-Agent`; no cookies, no auth, nothing of the caller's.
6. No upstream body and no upstream error text ever reaches the client: only parsed fields, or
   a fixed generic phrase.

Tests need to reach an HTTP server on 127.0.0.1, which the guard refuses. The seam is
`startServer({ unsafeNetForTests })` → `Ctx.net` (a fake resolver + a one-address allow hook). It
can only be passed in-process: no env var, config key, header or API field sets it, the CLI and
Electron entry points never pass it, and `server/bookmarks.test.ts` asserts both that and the
behaviour of a production-wired server.

## MCP

One tool set in `mcp/tools.ts`, implemented as a thin client over the REST API
(`baseUrl`, optional `token`) so there is a single code path. Exposed two ways:
- `POST/GET/DELETE /mcp` — Streamable HTTP, stateless, mounted on the Node http
  server *before* Hono (route `/mcp` to the transport, everything else to Hono).
  Same auth/origin/host rules as the API.
- `centcom mcp` — stdio server for clients that spawn a process. Uses
  `CENTCOM_URL` (default `http://127.0.0.1:4747`) + `CENTCOM_TOKEN`.

Tools (all take/return JSON text; every mutating tool requires an `agent` id so
the work is attributed): `centcom_guide`, `list_projects`, `get_project`,
`list_tickets`, `get_ticket`, `create_ticket`, `update_ticket`, `comment_on_ticket`,
`edit_comment` / `delete_comment` (`agent`, ticket `id`, `comment` = the event id), `list_skills`, `get_skill`, `search`, `list_folder`, `read_doc`, `write_doc`,
`get_taste` (returns Taste docs + image paths/sidecar notes, optional `tag`/`folder`),
`save_bookmark` (`agent`, `url`; optional `title`, `note`, `tags`, `folder`),
`recent_activity`, `agent_home`, `agent_profile_upsert`, `agent_deliverable_add`. `centcom_guide` returns the vault's `AGENTS.md`, which asks agents to save the
useful URLs they find. There are no MCP tools for link management or git: those stay local.

## CLI (`cli/centcom.ts` → `dist-cli/centcom.cjs`, shebang, zero-dep arg parsing)

```
centcom status
centcom serve [--port N] [--host H] [--vault P]
centcom mcp
centcom ticket create --title T [--project P] [--priority 0-4] [--status S] [--agent A] [--label L ...] [--body B | --body-file F | stdin]
centcom ticket list [--project P] [--status S] [--agent A] [--mine]
centcom ticket show <ID>
centcom ticket update <ID> [--status S] [--priority N] [--agent A] [--title T] [--project P]
centcom ticket start|review|done|cancel <ID>        # status shortcuts
centcom ticket comment <ID> <text…>
centcom ticket edit-comment <ID> <COMMENT> <text…>  # comment ids are shown by `ticket show`
centcom ticket delete-comment <ID> <COMMENT>
centcom project list | create --name N [--key K]
centcom skill list [--project P] | show <name> [--project P]
centcom doc ls [path] | read <path> | write <path> (--body B | --body-file F | stdin)
centcom search <query…>
centcom taste add <file> [--folder Taste/…] [--note "why I like it"] [--tag T ...]
centcom link list | add <target> --at <mount> [--readonly] | remove <mount>   # local config + symlink, then asks a running server to reload
centcom link status [--fetch]                       # git state of each linked clone (needs the server; loopback only)
centcom link pull <mount>                           # git pull --ff-only in that link's clone
centcom bookmark add <url> [--folder F] [--title T] [--note N] [--tag T ...]
centcom bookmark list [--folder F]
centcom agent list | home <id> | profile show <id>
centcom agent profile set <id> [--description D | --description-file F] [--instructions I | --instructions-file F] [--skill "name: desc" ...] [--name N]
centcom agent deliverable add <id> --title T --url U --kind K [--date D] [--project P] [--note N]   # --url is the deliverable here
centcom agent deliverable remove <id> <deliverable-id>
```

Identity: `--agent`/`--as`, else `$CENTCOM_AGENT`, else `cli`. `--json` prints raw
JSON. Human output is aligned plain text, no color when not a TTY. Exit non-zero on
error with the server's message.

## Server entry

`server/index.ts` exports `startServer(opts?: { port?, host?, vault?, uiDir?, quiet?, configDir? }): Promise<{ info: ServerInfo, url, close(): Promise<void> }>`
and auto-starts only when executed directly. Electron imports and embeds it.

## Seeding (first run on an empty vault only; never overwrite)

Root folders, `AGENTS.md` (clear, practical guide: what CENTCOM is, layout, ticket
lifecycle, how to use CLI/MCP/REST, etiquette — file a ticket before starting work,
set `in_progress`, comment progress, mark `done`; read `Taste/` before producing
anything the owner will look at. Agents keep using the skills installed in their own
tool: `Skills/` is where the latest version of every skill across every tool and project
can be looked up, compared and edited, and where to check whether a skill already exists
before writing a new one), `Library/{Learnings,Research,Links}`,
`Taste/{Visual,Writing}`, and one project **CENTCOM** (key `CEN`, status `active`, lead = the
configured user) whose tickets are a starting checklist useful to any new user: connect your
first agent, link your skills folders, add references to Taste, save the links you keep coming
back to, set up remote access (provider-neutral: a mesh VPN such as Tailscale, a tunnel such as
Cloudflare Tunnel, or a reverse proxy are all just ways to reach the same token-protected
server, and none is required), keep vault history with git. `AGENTS.md` names the configured
user. No lorem ipsum, no personal names, no personal paths. Existing vaults are never re-seeded.

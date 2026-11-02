# Contributing

Thanks for helping. CENTCOM is small and opinionated: one server, plain Markdown on disk, and clients that all speak the same API. Changes that keep it that way are the easiest to accept.

## Before you start

- For anything larger than a bug fix, open an issue first and describe the problem you want to solve. It saves you writing code that does not fit.
- Security issues go through private reporting, never a public issue: see [SECURITY](SECURITY.md).

## Set up

```sh
pnpm install
pnpm dev
```

Use a scratch vault while developing so you never touch real data:

```sh
export CENTCOM_VAULT="$(mktemp -d)/vault" CENTCOM_CONFIG_DIR="$(mktemp -d)/config"
```

## Every change

```sh
pnpm typecheck && pnpm test && pnpm build
```

`pnpm test` refuses to run against `~/CENTCOM` or `~/.centcom`; set the two variables above. For iOS changes, also run `xcodegen generate --spec ios/project.yml` and a simulator build (see [iOS](docs/IOS.md)).

## Guidelines

- **The contract is `shared/types.ts`.** Additive changes only; call them out in the pull request.
- **Ship shared features on Mac and iPhone together**, and check both against the same server.
- **Read [`docs/design.md`](docs/design.md) before UI work** and reuse its tokens and components. Update the guide when a shared pattern changes.
- **Security rules in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) are non-negotiable**: every client path goes through `resolveVaultPath()`, nothing returns `Access-Control-Allow-Origin: *`, and no credential appears in source, logs, URLs or test fixtures.
- **Dependencies:** add one only when it clearly pays for itself. New packages do not get install scripts (`allowBuilds` in `pnpm-workspace.yaml`), and pnpm will not resolve a version younger than three days.
- **Tests** live next to the code (`server/*.test.ts`, `src/**/*.test.ts`) and use `server/testkit.ts`, which gives every test its own temporary vault and config.
- Match the surrounding code's naming, comment density and idiom.

## Pull requests

Keep each pull request to one change, explain why it is needed, and say how you verified it. CI runs typecheck, tests, build and a production dependency audit on macOS and Linux.

By contributing you agree that your contribution is licensed under the MIT License in [LICENSE](LICENSE).

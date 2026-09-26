# Contributing

## Development

```sh
bun install
bun run check
```

`bun run check` runs typecheck, lint, format check and unit tests. `bun run format` rewrites the tree.

Contributors sign the [CLA](CLA.md) on their first PR; the CLA bot explains how.

`bun run test:e2e` needs Postgres in `DATABASE_URL`, e.g. `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres bun run test:e2e`; the suites skip when it is unset. `e2e/agent-token.drizzle.test.ts` exercises the routes, middleware and verifier on a scratch schema. `e2e/upgrade-from-0.1.0.test.ts` builds its own database with the published 0.1.0 (the `agent-token-0.1.0` dev dependency), then upgrades it with this build.

## Migrations

`migrations/*.sql` ship in the package. `runAgentTokenMigrations` replays every file on every boot, in one transaction under an advisory lock, with no record of what already ran. Every statement must be idempotent (`IF NOT EXISTS`, guarded `ALTER`s, re-runnable backfills). `"public".` in a file is rewritten to the host schema passed as `schema`.

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.

## Releasing

Releases are manual. On a clean, up-to-date `main`:

```sh
npm version <patch|minor> -m "chore(release): %s"
git push --follow-tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
npm publish
```

Bump minor only for breaking API changes; everything else is a patch. `prepack` builds `dist/` from the tagged commit.

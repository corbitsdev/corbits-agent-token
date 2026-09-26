# Contributing

## Development

```sh
git clone https://github.com/corbitsdev/corbits-agent-token.git
cd corbits-agent-token
bun install
createdb agent_token_dev
export DATABASE_URL=postgres://localhost:5432/agent_token_dev

bun run typecheck
bun run test
bun run build
```

The suites in `e2e/` run against a real Postgres and skip when `DATABASE_URL` is unset. CI sets it.

- `e2e/agent-token.drizzle.test.ts` runs Interchange's migrations into a scratch schema and exercises the routes, the middleware and the verifier.
- `e2e/upgrade-from-0.1.0.test.ts` creates its own database, builds it with the published 0.1.0 (the `agent-token-0.1.0` dev dependency), then upgrades it with this build.

## Migrations

`migrations/*.sql` ship in the package. `runAgentTokenMigrations` replays every file on every boot, in one transaction under an advisory lock, with no record of what already ran. Every statement must be idempotent (`IF NOT EXISTS`, guarded `ALTER`s, re-runnable backfills). `"public".` in a file is rewritten to the host schema passed as `schema`.

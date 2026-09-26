# AGENTS.md

## Purpose

`@corbits/agent-token` authenticates deployed agents calling back into their
Interchange hub. It owns the `agent_token` Postgres schema, the mint, list and
revoke routes, and the middleware that verifies a bearer. It does not own
grants, tenants or outbound credentials an agent uses to call other services.

## Layout

- `src/tokens.ts` — `mintAgentToken`, `revokeAgentToken`, `verifyAgentToken` and the SHA-256 digest.
- `src/mount.ts` — `mountAgentTokens`, the tenant-scoped mint, list and revoke routes.
- `src/middleware.ts` — `requireAgentToken` and `createAgentTokenVerifier`.
- `src/workflow-run-scope.ts` — the run-scope types shared by run-scoped mounts.
- `src/schema.ts` — the `agent_token` schema's one table.
- `src/migrations.ts` — `runAgentTokenMigrations`, applies `migrations/*.sql`.
- `src/index.ts` — the only module consumers import from (plus `./migrations`).
- `e2e/` — real-Postgres suites, including the 0.1.0 upgrade test.

## Rules

- Store only `sha256(token)`; the plaintext appears once, in the mint response.
- A token is valid only on routes of the tenant that minted it; anything else is a 401.
- The acting tenant comes from the host context, never from a path parameter.
- Every route runs the host's `requireGrant`.
- Every migration statement is idempotent; there is no ledger.

## Local development

```sh
bun install && bun run check
```

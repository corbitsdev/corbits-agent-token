# @corbits/agent-token

Bearer tokens that a deployed agent presents when it calls back into its Interchange hub (the multi-tenant control plane): mint, list and revoke routes, SHA-256 digests in Postgres, and a Hono middleware that verifies the bearer against the route's tenant. A Corbits hub module that mounts on `@intx/hub-api` and `@intx/db`.

## Why @corbits/agent-token?

1. **Scoped to a tenant and an agent definition.** A token carries the tenant that minted it and the agent definition (the hub's record of a deployable agent) it was minted for. The middleware refuses a token on any other tenant's routes.
2. **The plaintext is shown once.** Only `sha256(token)` is stored. The mint response is the only place the plaintext appears.
3. **The hub stays in charge.** Every route runs the host's `requireGrant` (the hub's permission check), and the tenant comes from the hub's context, never from the request.

It authenticates agents calling the hub. It does not hold outbound credentials an agent uses to call other services.

## Install

```bash
bun add @corbits/agent-token @intx/authz @intx/db @intx/hub-api drizzle-orm hono postgres
```

## Quickstart

With `DATABASE_URL` pointing at a hub database that has run `runAgentTokenMigrations` (see [Using with Interchange](#using-with-interchange)):

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { mintAgentToken, verifyAgentToken } from "@corbits/agent-token";

const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client);

const minted = await mintAgentToken(db, {
  tenantId: "acme",
  definitionId: "support-agent",
  name: "demo",
});
console.log(await verifyAgentToken(db, minted.token));
await client.end();
```

`acme` must be a tenant in the hub. It prints `{ id, tenantId: "acme", definitionId: "support-agent" }`.

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents as principals: accounts with their own identity, permissions and credentials. Its hub is the multi-tenant control plane that holds tenants, principals and grants (permissions a principal holds on a resource); its sidecar is the agent runtime.

- **Runs in:** the hub, as routes and middleware on its Hono app and one table in its Postgres (`agent_token` schema).
- **Plugs into:** [`@intx/hub-api`](https://github.com/faremeter/interchange/tree/main/packages/hub-api) (`TenantEnv`, `requireGrant`) and [`@intx/db`](https://github.com/faremeter/interchange/tree/main/packages/db) (its `DBConfig`, and its `tenant` table as the FK target).
- **Pairs with:** the run-scoped routes of [`@corbits/memory`](https://github.com/corbitsdev/corbits-memory) and [`@corbits/artifacts`](https://github.com/corbitsdev/corbits-artifacts), which accept these tokens from agents.

## Reference

### `mountAgentTokens(app, opts)`

Mounts relative routes on a `Hono<TenantEnv>`. Put it under the hub's tenant prefix.

| `opts`              | Type                | What the host provides                                                                 |
| ------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `db`                | `AgentTokenDb`      | The hub's drizzle handle, for example from `createDB`.                                 |
| `requireGrant`      | `MiddlewareHandler` | The grant check for minting a credential, run on every route.                          |
| `resolveDefinition` | `ResolveDefinition` | `(tenantId, definitionId) => boolean \| Promise<boolean>`: whether the tenant owns it. |

| Route                      | Result                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /agent-tokens`        | `200 { tokens }`, without plaintext or digest.                                                                                                                      |
| `POST /agent-tokens`       | Mints for `{ definitionId, name }`: `201 { token }` with the plaintext. `400 invalid_body` on a bad body, `404 not_found` for a definition the tenant does not own. |
| `DELETE /agent-tokens/:id` | Revokes: `200 { ok: true }`, or `404 not_found`. Revocation is final.                                                                                               |

### `requireAgentToken({ db })`

Middleware that reads `Authorization: Bearer <token>` and sets `agentToken` (`{ id, tenantId, definitionId }`) on the context. Missing, unknown, revoked and other-tenant tokens all get the same `401 { "error": "unauthorized" }`. It must run behind the hub's tenant middleware; without `tenant` on the context every request fails with a 500.

### `createAgentTokenVerifier({ db })`

The same check as a function, `(c) => Promise<AgentTokenContext | undefined>`, for a route that falls back to its own authentication when no agent token is presented. It also refuses other-tenant tokens.

### Run-scoped types

For a route an agent calls on behalf of one workflow run (a single execution of a deployed agent): `ResolvedWorkflowRunScope` (`{ tenantId, principalId, runId }`), `WorkflowRunScopeEnv` (`TenantEnv` plus `workflowRunScope`), and `AgentTokenAuth`: `{ verify, resolveRun }`, where `verify` is a `createAgentTokenVerifier` and `resolveRun(runAddress)` is the host's lookup from the run address in the request to a `ResolvedWorkflowRunScope`, or `null`. `AgentTokenVariables` types `c.get("agentToken")` on a host's own Env.

### Functions

`mintAgentToken(db, { tenantId, definitionId, name })` returns a `MintedAgentToken`, `verifyAgentToken(db, token)` an `AgentTokenIdentity` or `undefined`, and `revokeAgentToken(db, { tenantId, id })` whether a live token was revoked.

### `runAgentTokenMigrations(dbConfig, { schema })`

From `@corbits/agent-token/migrations`. Run it after Interchange's `runMigrations`, with the same config and the same `schema`: the host schema that holds the `tenant` table. The `token` table always lives in the `agent_token` schema. It is idempotent and takes an advisory lock, so several replicas can start at once.

## Using with Interchange

1. Run `runAgentTokenMigrations` at hub start, after `runMigrations`.
2. Mount `mountAgentTokens` under the tenant prefix, gated with `requireGrant("credential:*", "create")`, since minting a token creates a credential.
3. Give the minted token to the deployed agent, for example as a secret in its environment.
4. Put `requireAgentToken` (or `createAgentTokenVerifier`) on each hub route the agent calls.

```ts
import { timeWindowEvaluator } from "@intx/authz";
import { createDB, createGrantStore, runMigrations } from "@intx/db";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";
import { requireAgentToken } from "@corbits/agent-token";
import { runAgentTokenMigrations } from "@corbits/agent-token/migrations";

const dbConfig = {
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "interchange",
};

await runMigrations(dbConfig, { schema: "public" });
await runAgentTokenMigrations(dbConfig, { schema: "public" });

const { db } = createDB(dbConfig);
export const requireGrant = createRequireGrant({
  grantStore: createGrantStore(db),
  conditionRegistry: { time_window: timeWindowEvaluator },
});

export const whoami = new Hono<TenantEnv>().get(
  "/whoami",
  requireAgentToken({ db }),
  (c) => c.json(c.get("agentToken")),
);
```

Mount the token routes with `mountAgentTokens(tokens, { db, requireGrant: requireGrant("credential:*", "create"), resolveDefinition })` on a `Hono<TenantEnv>`. `resolveDefinition` is the host's check that the tenant owns the agent definition, answered from its own definition records. Mount `tokens` and `whoami` on the hub app under `/api/tenants/:tenantId`, behind the hub's auth and tenant middleware.

`POST /api/tenants/<id>/agent-tokens` with `{ "definitionId": "...", "name": "..." }` returns `{ "token": { "id", "token", ... } }`. Calling `GET /api/tenants/<id>/whoami` with `Authorization: Bearer <token>` returns `{ "id", "tenantId", "definitionId" }`.

## Upgrading from 0.1

- Existing databases and tokens keep working: the migration is unchanged and re-runs cleanly, and tokens minted by 0.1.0 still verify.
- `applyAgentTokenMigrations(databaseUrl, { tenantSchema })` is replaced by `runAgentTokenMigrations(dbConfig, { schema })` from `@corbits/agent-token/migrations`. A 0.1.0 table keeps its FK to the schema it was first created against.
- `@intx/db`, `@intx/hub-api`, `drizzle-orm`, `hono` and `postgres` are now peer dependencies.
- The root no longer exports `agentTokenSchema`, `agentTokenTable`, `generateAgentToken`, `hashAgentToken`, `agentTokenHashEquals` or `bearerFromAuthorization`.
- `mountAgentTokens` drops `resolveTenantId` and reads the tenant from `TenantEnv`.
- `requireAgentToken` and `createAgentTokenVerifier` now refuse tokens minted by another tenant, and need the hub's tenant middleware in front of them.

## License

[LGPL-2.1](https://github.com/corbitsdev/corbits-agent-token/blob/main/LICENSE)

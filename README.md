# @corbits/agent-token

Bearer tokens that let agents authenticate inbound calls to your
Interchange hub. Use it when a deployed agent calls back into the hub that
deployed it: a tenant mints a token for one of its agent definitions, the
plaintext is returned once and only its sha256 digest is stored, and a
guarded route reads the tenant and definition straight off the verified
token.

## Install

```
bun add @corbits/agent-token
```

The host supplies the Interchange stack as peers: `@intx/db`,
`@intx/hub-api`, `drizzle-orm`, `hono` and `postgres`.

## Mount (`mountAgentTokens`)

Routes are relative and go under the host's own tenant prefix, so the acting
tenant comes from the host's authenticated context and never from a path
parameter. The host supplies its own grant middleware: minting a token is
minting a credential, so the host gates it exactly as it gates credential
creation.

```ts
import { mountAgentTokens, type AgentTokenDb } from "@corbits/agent-token";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

export function mountTokens(
  app: Hono<TenantEnv>,
  db: AgentTokenDb,
  requireGrant: RequireGrant,
  tenantOwnsDefinition: (tenantId: string, definitionId: string) => Promise<boolean>,
) {
  const tokenApp = new Hono<TenantEnv>();
  mountAgentTokens(tokenApp, {
    db,
    requireGrant: requireGrant("credential:*", "create"),
    // A token is scoped to a definition, so the host confirms this tenant
    // owns it; an unknown definition answers 404 with no detail.
    resolveDefinition: tenantOwnsDefinition,
  });
  app.route("/api/tenants/:tenantId", tokenApp);
}
```

| Route | |
|---|---|
| `GET /agent-tokens` | List the tenant's tokens (never the plaintext or its digest) |
| `POST /agent-tokens` | Mint a token (`definitionId`, `name`); the plaintext is in the 201 response and nowhere else |
| `DELETE /agent-tokens/:id` | Revoke a token; revocation is final |

## Middleware (`requireAgentToken`)

Reads `Authorization: Bearer`, hashes the presented value, and looks up an
unrevoked row minted by the route's own tenant (`c.get("tenant")`). On
success it sets `agentToken` — `{ id, tenantId, definitionId }` — on the
context; missing, malformed, unknown, revoked and other-tenant tokens all
get the same bare 401, with no detail that would tell a caller which it was.
It must run behind the hub's tenant middleware, which sets `tenant`; mounted
without it, a valid token fails the request with a 500 rather than passing.

```ts
import { requireAgentToken, type AgentTokenDb } from "@corbits/agent-token";
import type { TenantEnv } from "@intx/hub-api";
import type { Hono } from "hono";

export function mountArtifacts(app: Hono<TenantEnv>, db: AgentTokenDb) {
  app.get("/api/tenants/:tenantId/artifacts/:id", requireAgentToken({ db }), (c) => {
    const { definitionId } = c.get("agentToken");
    return c.json({ id: c.req.param("id"), definitionId });
  });
}
```

`createAgentTokenVerifier` is the bearer lookup as a plain function, for a
hub mount that wants to fall back to its own authentication when no bearer
is presented. Like the middleware, it refuses a token minted by another
tenant.

## Run-scoped mounts

A mount that serves a deployed agent's run, rather than a browser session,
imports its types from here: `ResolvedWorkflowRunScope` (`{ tenantId,
principalId, runId }`), `WorkflowRunScopeEnv` (the hub's `TenantEnv` plus a
`workflowRunScope` variable) and `AgentTokenAuth`, the host's `verify` and
`resolveRun` pair. `createAgentTokenVerifier({ db })` is a ready `verify`;
the mount refuses a token whose `tenantId` is not the resolved run's.

## Security

- The token is 32 random bytes from `node:crypto`'s `randomBytes`,
  base64url-encoded.
- Only `sha256(token)` is stored; lookups are by digest, and the digest
  comparison is constant-time.
- Scope — the tenant and the definition — travels with the row, not with
  the caller's claim. The tenant is read off the host's context and the
  definition is confirmed to belong to it before a token is minted.
- Every route runs the host's grant middleware, so authority is checked
  once and by the host.
- Revoke sets `revoked_at`; a revoked row never verifies again and cannot
  be un-revoked.

## Migrations

The package ships its SQL. Run it after Interchange's own migrations, with
the same config and schema; it is idempotent and advisory-locked, so
concurrent hub replicas cannot race it:

```ts
import { runAgentTokenMigrations } from "@corbits/agent-token/migrations";
import { runMigrations, type DBConfig } from "@intx/db";

export async function migrate(dbConfig: DBConfig) {
  await runMigrations(dbConfig, { schema: "public" });
  await runAgentTokenMigrations(dbConfig, { schema: "public" });
}
```

## License

LGPL-2.1

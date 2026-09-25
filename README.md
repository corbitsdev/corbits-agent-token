# @corbits/agent-token

Bearer tokens that let a deployed agent definition call back into the
Interchange hub that deployed it. A tenant mints a token for one of its
definitions; the plaintext is returned once and only its sha256 digest is
stored. A mount that wants to accept an agent as a caller runs the
middleware and reads the tenant and definition straight off the verified
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
minting a credential, so it is gated the way the host gates credential
creation — once, its way.

```ts
const tokenApp = new Hono<TenantEnv>();
mountAgentTokens(tokenApp, {
  db,
  requireGrant: requireGrant("credential:*", "create"),
  // A token is scoped to a definition, so the host confirms this tenant
  // owns it; an unknown definition answers 404 with no detail.
  resolveDefinition: (tenantId, definitionId) => hub.tenantOwnsDefinition(tenantId, definitionId),
});
app.route("/api/tenants/:tenantId", tokenApp);
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
app.get("/api/tenants/:tenantId/artifacts/:id", requireAgentToken({ db }), (c) => {
  const { definitionId } = c.get("agentToken");
  ...
});
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

## Schema / migrations

One table, on its own Postgres schema (`agent_token.token`), FK'd back to
Interchange's `tenant` table:

| Column | |
|---|---|
| `id` | primary key |
| `tenant_id` | FK → `tenant.id`, cascades on delete |
| `definition_id` | the agent definition this token acts as |
| `name` | what the minting caller called it |
| `token_hash` | sha256 of the plaintext, unique |
| `created_at` | mint time |
| `revoked_at` | set once, on revoke |

Applied idempotently, inside one advisory-locked transaction so concurrent
hub replicas cannot race the same DDL:

```ts
import { applyAgentTokenMigrations } from "@corbits/agent-token/migrations";

await applyAgentTokenMigrations(databaseUrl);
```

## License

LGPL-2.1

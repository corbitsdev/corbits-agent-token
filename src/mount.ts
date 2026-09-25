// Mint and revoke a tenant's agent tokens. Routes are relative and mounted
// under the host's own tenant prefix, so the acting tenant comes from the
// host's authenticated context and never from a path parameter.
import { type } from "arktype";
import { desc, eq } from "drizzle-orm";
import type { TenantEnv } from "@intx/hub-api";
import type { Context, Hono, MiddlewareHandler } from "hono";

import { agentTokenTable } from "./schema.js";
import { mintAgentToken, revokeAgentToken, type AgentTokenDb } from "./tokens.js";

/** Answers whether `definitionId` names an agent definition this tenant
 * owns. A token is scoped to a definition, so minting one against a
 * definition the tenant does not own would widen it past the tenant. */
export type ResolveDefinition = (
  tenantId: string,
  definitionId: string,
) => Promise<boolean> | boolean;

export type MountAgentTokensOpts<E extends TenantEnv, TSchema extends Record<string, unknown>> = {
  db: AgentTokenDb<TSchema>;
  /**
   * The host's own authority check, run as middleware on every route. Minting
   * a token is minting a credential, so it is gated the way the host gates
   * credential creation — once, its way, not by a boolean this package
   * interprets.
   */
  requireGrant: MiddlewareHandler<E>;
  resolveDefinition: ResolveDefinition;
};

const MintBody = type({
  definitionId: "string > 0",
  name: "string > 0",
});

/** Mount `/agent-tokens` onto the host's app, under its tenant prefix. */
export function mountAgentTokens<E extends TenantEnv, TSchema extends Record<string, unknown>>(
  app: Hono<E>,
  opts: MountAgentTokensOpts<E, TSchema>,
): Hono<E> {
  const { db, requireGrant, resolveDefinition } = opts;

  app.get("/agent-tokens", requireGrant, async (c: Context<E>) => {
    const rows = await db
      .select({
        id: agentTokenTable.id,
        tenantId: agentTokenTable.tenantId,
        definitionId: agentTokenTable.definitionId,
        name: agentTokenTable.name,
        createdAt: agentTokenTable.createdAt,
        revokedAt: agentTokenTable.revokedAt,
      })
      .from(agentTokenTable)
      .where(eq(agentTokenTable.tenantId, c.get("tenant").id))
      .orderBy(desc(agentTokenTable.createdAt));
    return c.json({ tokens: rows });
  });

  app.post("/agent-tokens", requireGrant, async (c: Context<E>) => {
    const tenantId = c.get("tenant").id;
    const parsed = MintBody(await c.req.json().catch(() => undefined));
    if (parsed instanceof type.errors) {
      return c.json({ error: "invalid_body", detail: parsed.summary }, 400);
    }
    // A definition this tenant does not own reads as absent, with no detail
    // that would tell a caller another tenant holds it.
    if (!(await resolveDefinition(tenantId, parsed.definitionId))) {
      return c.json({ error: "not_found" }, 404);
    }
    const minted = await mintAgentToken(db, {
      tenantId,
      definitionId: parsed.definitionId,
      name: parsed.name,
    });
    return c.json({ token: minted }, 201);
  });

  app.delete("/agent-tokens/:id", requireGrant, async (c: Context<E, "/agent-tokens/:id">) => {
    const revoked = await revokeAgentToken(db, {
      tenantId: c.get("tenant").id,
      id: c.req.param("id"),
    });
    if (!revoked) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

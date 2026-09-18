// Mint and revoke a tenant's agent tokens. Absolute routes registered
// directly on the host's app, never a sub-router under a prefix.
import { type } from "arktype";
import { desc, eq } from "drizzle-orm";
import type { Env, Hono } from "hono";

import { agentTokenTable } from "./schema";
import { mintAgentToken, revokeAgentToken, type AgentTokenDb } from "./tokens";

/** The host decides whether the caller may act for this tenant; this
 * package never reimplements Interchange's grant checks. */
export type RequireGrant = (ctx: unknown, tenantId: string) => Promise<boolean> | boolean;

export type MountAgentTokensOpts<TSchema extends Record<string, unknown>> = {
  db: AgentTokenDb<TSchema>;
  requireGrant: RequireGrant;
};

const MintBody = type({
  definitionId: "string > 0",
  name: "string > 0",
});

/** Mount `/api/tenants/:tenantId/agent-tokens` onto the host's app. */
export function mountAgentTokens<E extends Env, TSchema extends Record<string, unknown>>(
  app: Hono<E>,
  opts: MountAgentTokensOpts<TSchema>,
): Hono<E> {
  const { db, requireGrant } = opts;

  app.get("/api/tenants/:tenantId/agent-tokens", async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!(await requireGrant(c, tenantId))) return c.json({ error: "forbidden" }, 403);
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
      .where(eq(agentTokenTable.tenantId, tenantId))
      .orderBy(desc(agentTokenTable.createdAt));
    return c.json({ tokens: rows });
  });

  app.post("/api/tenants/:tenantId/agent-tokens", async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!(await requireGrant(c, tenantId))) return c.json({ error: "forbidden" }, 403);
    const parsed = MintBody(await c.req.json().catch(() => undefined));
    if (parsed instanceof type.errors) {
      return c.json({ error: "invalid_body", detail: parsed.summary }, 400);
    }
    const minted = await mintAgentToken(db, {
      tenantId,
      definitionId: parsed.definitionId,
      name: parsed.name,
    });
    return c.json({ token: minted }, 201);
  });

  app.delete("/api/tenants/:tenantId/agent-tokens/:id", async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!(await requireGrant(c, tenantId))) return c.json({ error: "forbidden" }, 403);
    const revoked = await revokeAgentToken(db, { tenantId, id: c.req.param("id") });
    if (!revoked) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

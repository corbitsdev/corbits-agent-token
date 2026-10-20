// Hono middleware that turns a presented bearer into an `agentToken` on the
// context. Anything it cannot resolve to an unrevoked row minted by the
// route's own tenant is a 401.
import type { TenantEnv } from "@intx/hub-api";
import type { Context, MiddlewareHandler } from "hono";

import {
  bearerFromAuthorization,
  recordTokenUse,
  verifyAgentToken,
  type AgentTokenDb,
} from "./tokens.js";

export type AgentTokenContext = {
  tenantId: string;
  definitionId: string;
  id: string;
  runId: string | null;
};

/** The context variable this middleware sets, for a host to widen its Env
 * with: `Variables: { agentToken: AgentTokenContext }`. */
export type AgentTokenVariables = { agentToken: AgentTokenContext };

export type RequireAgentTokenOpts<TSchema extends Record<string, unknown>> = {
  db: AgentTokenDb<TSchema>;
  recordUse?: boolean;
};

/** A host-side verifier, for mounts that want to authenticate a bearer
 * themselves rather than run this as middleware. Like the middleware, it only
 * resolves tokens minted by the context's own tenant. */
export type AgentTokenVerifier = <E extends TenantEnv>(
  c: Context<E>,
) => Promise<AgentTokenContext | undefined>;

async function verifyAuthorization<TSchema extends Record<string, unknown>>(
  db: AgentTokenDb<TSchema>,
  tenantId: string,
  authorization: string | undefined,
): Promise<AgentTokenContext | undefined> {
  const token = bearerFromAuthorization(authorization);
  if (token === undefined) return undefined;
  const identity = await verifyAgentToken(db, token);
  if (identity === undefined || identity.tenantId !== tenantId)
    return undefined;
  return {
    id: identity.id,
    tenantId: identity.tenantId,
    definitionId: identity.definitionId,
    runId: identity.runId,
  };
}

export function createAgentTokenVerifier<
  TSchema extends Record<string, unknown>,
>(opts: RequireAgentTokenOpts<TSchema>): AgentTokenVerifier {
  // The tenant is read before the header, so a host missing the tenant
  // middleware rejects every request, not only valid tokens.
  return async (c) => {
    const identity = await verifyAuthorization(
      opts.db,
      c.get("tenant").id,
      c.req.header("authorization"),
    );
    if (identity !== undefined && opts.recordUse) {
      recordTokenUse(opts.db, identity.id).catch((err: unknown) => {
        console.error("recordTokenUse failed (verifier)", err);
      });
      console.info(
        JSON.stringify({
          event: "agent_token_used",
          tokenId: identity.id,
          tenantId: identity.tenantId,
          definitionId: identity.definitionId,
          route: c.req.path,
          method: c.req.method,
        }),
      );
    }
    return identity;
  };
}

/** Middleware that verifies a bearer and sets `agentToken` on the context.
 * Every rejection — missing bearer, invalid token, revoked token, wrong
 * tenant, or missing tenant middleware — returns the same
 * `401 { "error": "unauthorized" }` so a response never reveals whether a
 * token is live or even whether the route exists.
 *
 * Must run behind the hub's tenant middleware; without it every request is
 * a 401 (not a 500). */
export function requireAgentToken<TSchema extends Record<string, unknown>>(
  opts: RequireAgentTokenOpts<TSchema>,
): MiddlewareHandler<TenantEnv & { Variables: AgentTokenVariables }> {
  const unauthorized = { error: "unauthorized" } as const;

  return async (c, next) => {
    let identity: AgentTokenContext | undefined;
    try {
      identity = await verifyAuthorization(
        opts.db,
        c.get("tenant").id,
        c.req.header("authorization"),
      );
    } catch {
      // Missing tenant middleware or other host-side error — same 401 so
      // the response never reveals whether the route exists.
      return c.json(unauthorized, 401);
    }
    if (identity === undefined) return c.json(unauthorized, 401);
    c.set("agentToken", identity);
    if (opts.recordUse) {
      recordTokenUse(opts.db, identity.id).catch((err: unknown) => {
        console.error("recordTokenUse failed (middleware)", err);
      });
      console.info(
        JSON.stringify({
          event: "agent_token_used",
          tokenId: identity.id,
          tenantId: identity.tenantId,
          definitionId: identity.definitionId,
          route: c.req.path,
          method: c.req.method,
        }),
      );
    }
    await next();
    return undefined;
  };
}

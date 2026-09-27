// Hono middleware that turns a presented bearer into an `agentToken` on the
// context. Anything it cannot resolve to an unrevoked row is a 401.
import type { TenantEnv } from "@intx/hub-api";
import type { Context, MiddlewareHandler } from "hono";

import { bearerFromAuthorization, verifyAgentToken, type AgentTokenDb } from "./tokens.js";

export type AgentTokenContext = {
  tenantId: string;
  definitionId: string;
  id: string;
};

/** The context variable this middleware sets, for a host to widen its Env
 * with: `Variables: { agentToken: AgentTokenContext }`. */
export type AgentTokenVariables = { agentToken: AgentTokenContext };

export type RequireAgentTokenOpts<TSchema extends Record<string, unknown>> = {
  db: AgentTokenDb<TSchema>;
};

/** A host-side verifier, for mounts that want to authenticate a bearer
 * themselves rather than run this as middleware. */
export type AgentTokenVerifier = <E extends TenantEnv>(
  c: Context<E>,
) => Promise<AgentTokenContext | undefined>;

async function verifyAuthorization<TSchema extends Record<string, unknown>>(
  db: AgentTokenDb<TSchema>,
  authorization: string | undefined,
): Promise<AgentTokenContext | undefined> {
  const token = bearerFromAuthorization(authorization);
  if (token === undefined) return undefined;
  const identity = await verifyAgentToken(db, token);
  if (identity === undefined) return undefined;
  return { id: identity.id, tenantId: identity.tenantId, definitionId: identity.definitionId };
}

export function createAgentTokenVerifier<TSchema extends Record<string, unknown>>(
  opts: RequireAgentTokenOpts<TSchema>,
): AgentTokenVerifier {
  return (c) => verifyAuthorization(opts.db, c.req.header("authorization"));
}

export function requireAgentToken<TSchema extends Record<string, unknown>>(
  opts: RequireAgentTokenOpts<TSchema>,
): MiddlewareHandler<{ Variables: AgentTokenVariables }> {
  return async (c, next) => {
    const identity = await verifyAuthorization(opts.db, c.req.header("authorization"));
    if (identity === undefined) return c.json({ error: "unauthorized" }, 401);
    c.set("agentToken", identity);
    await next();
    return undefined;
  };
}

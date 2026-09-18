// Hono middleware that turns a presented bearer into an `agentToken` on the
// context. Anything it cannot resolve to an unrevoked row is a 401.
import type { Context, MiddlewareHandler } from "hono";

import { bearerFromAuthorization, verifyAgentToken, type AgentTokenDb } from "./tokens";

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
export type AgentTokenVerifier = (ctx: unknown) => Promise<AgentTokenContext | undefined>;

export function createAgentTokenVerifier<TSchema extends Record<string, unknown>>(
  opts: RequireAgentTokenOpts<TSchema>,
): AgentTokenVerifier {
  return async (ctx) => {
    const c = ctx as Context;
    const token = bearerFromAuthorization(c.req.header("authorization"));
    if (token === undefined) return undefined;
    const identity = await verifyAgentToken(opts.db, token);
    if (identity === undefined) return undefined;
    return { id: identity.id, tenantId: identity.tenantId, definitionId: identity.definitionId };
  };
}

export function requireAgentToken<TSchema extends Record<string, unknown>>(
  opts: RequireAgentTokenOpts<TSchema>,
): MiddlewareHandler {
  const verify = createAgentTokenVerifier(opts);
  return async (c, next) => {
    const identity = await verify(c);
    if (identity === undefined) return c.json({ error: "unauthorized" }, 401);
    c.set("agentToken", identity);
    await next();
    return undefined;
  };
}

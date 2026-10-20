// Mint a run-scoped agent token. The server generates the token; the caller
// only names the run. Re-registering for the same run revokes the old token.
// Every route runs the host's `requireGrant`.
import { type } from "arktype";
import type { TenantEnv } from "@intx/hub-api";
import type { Context, Hono, MiddlewareHandler } from "hono";

import { mintRunScopedToken, type AgentTokenDb } from "./tokens.js";

/** What the host's run resolver returns: which tenant and definition a run
 * address resolves to. */
export type RunScopeForToken = {
  tenantId: string;
  definitionId: string;
  runId: string;
};

/** `(runAddress) => scope | null`: the host's lookup from the request's run
 * address to the run it names. Returns `null` for unknown or inaccessible
 * runs. */
export type ResolveRunForToken = (
  runAddress: string,
) => Promise<RunScopeForToken | null> | RunScopeForToken | null;

export type MountRunScopedTokensOpts<
  E extends TenantEnv,
  TSchema extends Record<string, unknown>,
> = {
  db: AgentTokenDb<TSchema>;
  /**
   * The host's own authority check, run as middleware on every route. The
   * host gates this the same way it gates credential creation.
   */
  requireGrant: MiddlewareHandler<E>;
  /** Maps a run address to the tenant, definition, and run ID it names.
   * Returns `null` for unknown or inaccessible runs. */
  resolveRun: ResolveRunForToken;
};

const RunMintBody = type({
  runAddress: "0 < string <= 256",
  "name?": "0 < string <= 256",
});

/** Mount `POST /workflow-run-tokens` onto the host's app. */
export function mountRunScopedTokens<
  E extends TenantEnv,
  TSchema extends Record<string, unknown>,
>(app: Hono<E>, opts: MountRunScopedTokensOpts<E, TSchema>): Hono<E> {
  const { db, requireGrant, resolveRun } = opts;

  app.post("/workflow-run-tokens", requireGrant, async (c: Context<E>) => {
    const tenantId = c.get("tenant").id;
    const parsed = RunMintBody(await c.req.json().catch(() => undefined));
    if (parsed instanceof type.errors) {
      return c.json({ error: "invalid_body", detail: parsed.summary }, 400);
    }

    const scope = await resolveRun(parsed.runAddress);
    if (scope === null || scope.tenantId !== tenantId) {
      return c.json({ error: "not_found" }, 404);
    }

    const minted = await mintRunScopedToken(db, {
      tenantId,
      definitionId: scope.definitionId,
      name: parsed.name ?? "workflow",
      runId: scope.runId,
    });

    return c.json({ token: minted }, 201);
  });

  return app;
}

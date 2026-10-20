// Middleware and verifier that bind an agent token to the specific run it
// was issued for.  A token with a `runId` is only valid for requests to that
// run; requests for any other run get the same 401 as an unknown bearer.
// The run identity comes from the *token*, not from a request header, so
// the consumer can trust it without a second header-based lookup.
import type { TenantEnv } from "@intx/hub-api";
import type { Context, MiddlewareHandler } from "hono";

import {
  type AgentTokenContext,
  type AgentTokenVariables,
  createAgentTokenVerifier,
  type RequireAgentTokenOpts,
} from "./middleware.js";
import type {
  ResolvedWorkflowRunScope,
  WorkflowRunScopeEnv,
} from "./workflow-run-scope.js";

/** `(runId) => scope | null`: the host's lookup from a token's bound run ID
 * to the full run scope it names, or `null` for unknown runs.  Unlike
 * `resolveRun(runAddress)` in `AgentTokenAuth`, this resolves by the stored
 * run ID, not by a user-supplied address. */
export type ResolveRunById = (
  runId: string,
) => Promise<ResolvedWorkflowRunScope | null> | ResolvedWorkflowRunScope | null;

export type RequireRunBoundTokenOpts<TSchema extends Record<string, unknown>> =
  RequireAgentTokenOpts<TSchema> & {
    resolveRunById: ResolveRunById;
  };

/** Context variables set by `requireRunBoundToken`: the verified token
 * *and* the resolved workflow run scope. */
export type RunBoundTokenVariables = AgentTokenVariables & {
  workflowRunScope: ResolvedWorkflowRunScope;
};

/** Middleware that verifies a bearer, asserts it is bound to a run, resolves
 * that run, and sets both `agentToken` and `workflowRunScope` on the
 * context.  Every rejection — missing bearer, invalid token, unbound token,
 * unknown run, wrong tenant — returns the same `401 { "error":
 * "unauthorized" }` so a response never reveals whether a token is live.
 *
 * Must run behind the hub's tenant middleware. */
export function requireRunBoundToken<TSchema extends Record<string, unknown>>(
  opts: RequireRunBoundTokenOpts<TSchema>,
): MiddlewareHandler<TenantEnv & { Variables: RunBoundTokenVariables }> {
  const verify = createAgentTokenVerifier(opts);

  return async (c, next) => {
    const identity = await verify(c);

    // Token missing, invalid, revoked or wrong tenant.
    if (identity === undefined) {
      return c.json({ error: "unauthorized" }, 401);
    }

    // Token not bound to a run (definition-scoped only).
    if (identity.runId === null) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const scope = await opts.resolveRunById(identity.runId);

    // Run unknown or belongs to a different tenant.
    if (scope === null || scope.tenantId !== identity.tenantId) {
      return c.json({ error: "unauthorized" }, 401);
    }

    c.set("agentToken", identity);
    c.set("workflowRunScope", scope);
    await next();
    return undefined;
  };
}

/** The same check as a function, for a route that falls back to its own
 * authentication when no run-bound agent token is presented. */
export type RunBoundTokenVerifier = <E extends WorkflowRunScopeEnv>(
  c: Context<E>,
) => Promise<
  | {
      agentToken: AgentTokenContext;
      workflowRunScope: ResolvedWorkflowRunScope;
    }
  | undefined
>;

export function createRunBoundTokenVerifier<
  TSchema extends Record<string, unknown>,
>(opts: RequireRunBoundTokenOpts<TSchema>): RunBoundTokenVerifier {
  const verify = createAgentTokenVerifier(opts);

  return async (c) => {
    const identity = await verify(c);
    if (identity === undefined || identity.runId === null) return undefined;
    const scope = await opts.resolveRunById(identity.runId);
    if (scope === null || scope.tenantId !== identity.tenantId) {
      return undefined;
    }
    return { agentToken: identity, workflowRunScope: scope };
  };
}

// The run scope a host resolves for a deployed agent's call, shared by every
// run-scoped mount that accepts an agent token.
import type { TenantEnv } from "@intx/hub-api";

import type { AgentTokenVerifier } from "./middleware.js";

/** Who a run authenticates as, and which run it is acting on behalf of. */
export type ResolvedWorkflowRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunScopeEnv = TenantEnv & {
  Variables: TenantEnv["Variables"] & {
    workflowRunScope: ResolvedWorkflowRunScope;
  };
};

/**
 * The host's two halves of agent authentication. `verify` reads the
 * presented `Authorization` header and returns `undefined` when it is not an
 * agent token; `resolveRun` is the host's lookup from a run address to the
 * run it names.
 */
export type AgentTokenAuth = {
  verify: AgentTokenVerifier;
  resolveRun: (
    runAddress: string,
  ) =>
    | Promise<ResolvedWorkflowRunScope | null>
    | ResolvedWorkflowRunScope
    | null;
};

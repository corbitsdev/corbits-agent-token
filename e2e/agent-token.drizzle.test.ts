// DB-gated: skipped when no DATABASE_URL is reachable. Migrations run into
// a scratch schema so this test never touches a real tenant table;
// `runAgentTokenMigrations` is told that scratch schema so its
// `tenant_id` FK targets it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import type { TenantEnv } from "@intx/hub-api";
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { Hono, type MiddlewareHandler } from "hono";

import { runAgentTokenMigrations } from "../src/migrations";
import {
  hashAgentToken,
  mintAgentToken,
  mintRunScopedToken,
  revokeAgentToken,
  verifyAgentToken,
} from "../src/tokens";
import { mountAgentTokens } from "../src/mount";
import { mountRunScopedTokens } from "../src/mount-run-scoped";
import { createAgentTokenVerifier, requireAgentToken } from "../src/middleware";
import {
  createRunBoundTokenVerifier,
  requireRunBoundToken,
} from "../src/run-bound";
import type { WorkflowRunScopeEnv } from "../src/workflow-run-scope";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "agent_token_test";

const MintResponse = type({ token: { id: "string", token: "string" } });
const ListResponse = type({ tokens: "unknown[]" });
const VerifyResponse = type({ identity: "unknown" });

function dbTargetFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

/** Stands in for the hub's tenant middleware. */
function tenantFrom<E extends TenantEnv>(
  db: ReturnType<typeof createDB>["db"],
  tenantId: string,
): MiddlewareHandler<E> {
  return async (c, next) => {
    const [tenant] = await db
      .select()
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenantId));
    if (tenant === undefined) return c.json({ error: "not_found" }, 404);
    c.set("tenant", tenant);
    await next();
    return undefined;
  };
}

/** Every route runs the host's own middleware; these stand in for it. */
function mountedApp(
  db: ReturnType<typeof createDB>["db"],
  tenantId: string,
  options: { gate?: "allow" | "deny"; owns?: readonly string[] } = {},
) {
  const app = new Hono<TenantEnv>();
  app.use(tenantFrom(db, tenantId));
  const owns = options.owns ?? ["def_artifacts"];
  mountAgentTokens(app, {
    db,
    requireGrant: async (c, next) => {
      if (options.gate === "deny") return c.json({ error: "forbidden" }, 403);
      await next();
      return undefined;
    },
    resolveDefinition: (_tenantId, definitionId) => owns.includes(definitionId),
  });
  return app;
}

function mintRequest(definitionId: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ definitionId, name: "artifacts" }),
  };
}

describeIfDb("agent tokens", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await runAgentTokenMigrations(target, { schema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  async function seedTenant(db: ReturnType<typeof createDB>["db"], id: string) {
    await db.insert(schema.tenant).values({
      id,
      name: id,
      slug: id.replace(/_/g, "-"),
      domain: `${id.replace(/_/g, "-")}.workbench.test`,
    });
  }

  test("a minted token verifies once, and stops verifying after revoke", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_tok_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);

      const minted = await mintAgentToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "artifacts",
      });
      expect(minted.token.length).toBeGreaterThan(32);

      const verified = await verifyAgentToken(db, minted.token);
      expect(verified).toEqual({
        id: minted.id,
        tenantId,
        definitionId: "def_artifacts",
        runId: null,
      });

      expect(await verifyAgentToken(db, "not-a-token")).toBeUndefined();

      expect(await revokeAgentToken(db, { tenantId, id: minted.id })).toBe(
        true,
      );
      expect(await verifyAgentToken(db, minted.token)).toBeUndefined();
      expect(await revokeAgentToken(db, { tenantId, id: minted.id })).toBe(
        false,
      );
    } finally {
      await close();
    }
  });

  test("the mount returns the plaintext once and never stores it", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_mount_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);

      const app = mountedApp(db, tenantId);

      const created = await app.request(
        "/agent-tokens",
        mintRequest("def_artifacts"),
      );
      expect(created.status).toBe(201);
      const body = MintResponse.assert(await created.json());
      const plaintext = body.token.token;

      const listed = await app.request("/agent-tokens");
      const listedBody = ListResponse.assert(await listed.json());
      expect(listedBody.tokens).toHaveLength(1);
      expect(JSON.stringify(listedBody)).not.toContain(plaintext);
      expect(JSON.stringify(listedBody)).not.toContain(
        hashAgentToken(plaintext),
      );

      const revoked = await app.request(`/agent-tokens/${body.token.id}`, {
        method: "DELETE",
      });
      expect(revoked.status).toBe(200);
      expect(await verifyAgentToken(db, plaintext)).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("the host's gate and the definition check both fail closed", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_gate_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);

      const gated = mountedApp(db, tenantId, { gate: "deny" });
      expect(
        (await gated.request("/agent-tokens", mintRequest("def_artifacts")))
          .status,
      ).toBe(403);
      expect((await gated.request("/agent-tokens")).status).toBe(403);

      const app = mountedApp(db, tenantId);
      const foreign = await app.request(
        "/agent-tokens",
        mintRequest("def_somebody_else"),
      );
      expect(foreign.status).toBe(404);
      // No detail: a definition another tenant owns reads exactly like one
      // that never existed.
      expect(await foreign.json()).toEqual({ error: "not_found" });
    } finally {
      await close();
    }
  });

  test("the mount refuses a name or definitionId over 256 characters", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_len_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      const app = mountedApp(db, tenantId, { owns: ["x".repeat(257)] });
      const mint = (body: unknown) =>
        app.request("/agent-tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      expect(
        (await mint({ definitionId: "def_artifacts", name: "n".repeat(257) }))
          .status,
      ).toBe(400);
      expect(
        (await mint({ definitionId: "x".repeat(257), name: "artifacts" }))
          .status,
      ).toBe(400);
      expect(
        (await mint({ definitionId: "def_artifacts", name: "n".repeat(256) }))
          .status,
      ).toBe(404);
    } finally {
      await close();
    }
  });

  test("the middleware admits a live bearer on its own tenant and 401s everything else", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_mw_${randomUUID().slice(0, 8)}`;
      const otherTenantId = `tnt_mw_other_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedTenant(db, otherTenantId);
      const minted = await mintAgentToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "artifacts",
      });

      const app = new Hono<TenantEnv>();
      app.use("/tenants/:tenantId/*", async (c, next) => {
        const [tenant] = await db
          .select()
          .from(schema.tenant)
          .where(eq(schema.tenant.id, c.req.param("tenantId")));
        if (tenant === undefined) return c.json({ error: "not_found" }, 404);
        c.set("tenant", tenant);
        await next();
        return undefined;
      });
      app.get("/tenants/:tenantId/guarded", requireAgentToken({ db }), (c) =>
        c.json({ tenantId: c.get("agentToken").tenantId }),
      );
      app.get("/untenanted", requireAgentToken({ db }), (c) =>
        c.json({ ok: true }),
      );
      const bearer = { headers: { authorization: `Bearer ${minted.token}` } };

      const ok = await app.request(`/tenants/${tenantId}/guarded`, bearer);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ tenantId });

      const crossTenant = await app.request(
        `/tenants/${otherTenantId}/guarded`,
        bearer,
      );
      expect(crossTenant.status).toBe(401);

      // Mounted without the tenant middleware, a valid token gets 401.
      const untenanted = await app.request("/untenanted", bearer);
      expect(untenanted.status).toBe(401);
      expect(await untenanted.json()).toEqual({ error: "unauthorized" });

      expect((await app.request(`/tenants/${tenantId}/guarded`)).status).toBe(
        401,
      );
      expect(
        (
          await app.request(`/tenants/${tenantId}/guarded`, {
            headers: { authorization: "Bearer nope" },
          })
        ).status,
      ).toBe(401);
    } finally {
      await close();
    }
  });
  test("the verifier resolves a live bearer and nothing else", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_ver_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      const minted = await mintAgentToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "artifacts",
      });

      const otherTenantId = `tnt_ver_other_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, otherTenantId);

      const verify = createAgentTokenVerifier({ db });
      const app = new Hono<WorkflowRunScopeEnv>();
      app.use("/:tenantId/*", async (c, next) =>
        tenantFrom<WorkflowRunScopeEnv>(db, c.req.param("tenantId"))(c, next),
      );
      app.get("/:tenantId/verify", async (c) =>
        c.json({ identity: (await verify(c)) ?? null }),
      );
      const identityFor = async (
        authorization?: string,
        onTenant = tenantId,
      ) => {
        const res = await app.request(`/${onTenant}/verify`, {
          headers: authorization === undefined ? {} : { authorization },
        });
        return VerifyResponse.assert(await res.json()).identity;
      };

      expect(await identityFor(`Bearer ${minted.token}`)).toEqual({
        id: minted.id,
        tenantId,
        definitionId: "def_artifacts",
        runId: null,
      });
      expect(
        await identityFor(`Bearer ${minted.token}`, otherTenantId),
      ).toBeNull();
      expect(await identityFor()).toBeNull();
      expect(await identityFor("Bearer nope")).toBeNull();
      expect(await identityFor(`  bearer   ${minted.token}  `)).toEqual({
        id: minted.id,
        tenantId,
        definitionId: "def_artifacts",
        runId: null,
      });
      expect(await identityFor(`Basic ${minted.token}`)).toBeNull();
      expect(await identityFor("Bearer")).toBeNull();
      await revokeAgentToken(db, { tenantId, id: minted.id });
      expect(await identityFor(`Bearer ${minted.token}`)).toBeNull();
    } finally {
      await close();
    }
  });

  test("the verifier rejects, not throws, when the host has no tenant middleware", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const verify = createAgentTokenVerifier({ db });
      const app = new Hono<WorkflowRunScopeEnv>();
      app.get("/verify", (c) =>
        verify(c).then(
          () => c.text("resolved"),
          () => c.text("rejected"),
        ),
      );
      expect(await (await app.request("/verify")).text()).toBe("rejected");
    } finally {
      await close();
    }
  });

  test("run-scoped mint generates the token server-side and replaces on re-register", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_run_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);

      const first = await mintRunScopedToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "workflow",
        runId: "run_1",
      });
      expect(first.token.length).toBeGreaterThan(32);
      expect(first.runId).toBe("run_1");

      const verified = await verifyAgentToken(db, first.token);
      expect(verified).toEqual({
        id: first.id,
        tenantId,
        definitionId: "def_artifacts",
        runId: "run_1",
      });

      // Re-registering for the same run replaces the old token.
      const second = await mintRunScopedToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "workflow",
        runId: "run_1",
      });
      expect(second.id).not.toBe(first.id);
      expect(await verifyAgentToken(db, first.token)).toBeUndefined();
      expect(await verifyAgentToken(db, second.token)).toEqual({
        id: second.id,
        tenantId,
        definitionId: "def_artifacts",
        runId: "run_1",
      });
    } finally {
      await close();
    }
  });

  test("the run-scoped mount enforces the grant, validates the run, and server-generates the token", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_rsc_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);

      const runs: Record<
        string,
        { definitionId: string; runId: string; tenantId: string }
      > = {
        "runs/abc": {
          definitionId: "def_artifacts",
          runId: "run_abc",
          tenantId,
        },
      };

      function runScopedApp(gate: "allow" | "deny" = "allow") {
        const app = new Hono<TenantEnv>();
        app.use(tenantFrom(db, tenantId));
        mountRunScopedTokens(app, {
          db,
          requireGrant: async (c, next) => {
            if (gate === "deny") return c.json({ error: "forbidden" }, 403);
            await next();
            return undefined;
          },
          resolveRun: (addr) => runs[addr] ?? null,
        });
        return app;
      }

      // Without the grant → 403.
      const denied = await runScopedApp("deny").request(
        "/workflow-run-tokens",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runAddress: "runs/abc" }),
        },
      );
      expect(denied.status).toBe(403);

      // Unknown run → 404.
      const app = runScopedApp();
      const unknown = await app.request("/workflow-run-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runAddress: "runs/missing" }),
      });
      expect(unknown.status).toBe(404);

      // Happy path → 201, server-generated token.
      const ok = await app.request("/workflow-run-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runAddress: "runs/abc" }),
      });
      expect(ok.status).toBe(201);
      const body = MintResponse.assert(await ok.json());
      expect(body.token.token.length).toBeGreaterThan(32);

      // The token verifies with the correct run.
      const identity = await verifyAgentToken(db, body.token.token);
      expect(identity).toEqual({
        id: body.token.id,
        tenantId,
        definitionId: "def_artifacts",
        runId: "run_abc",
      });

      // Re-registering replaces the old token.
      const second = await app.request("/workflow-run-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runAddress: "runs/abc" }),
      });
      expect(second.status).toBe(201);
      const secondBody = MintResponse.assert(await second.json());
      expect(await verifyAgentToken(db, body.token.token)).toBeUndefined();
      expect(await verifyAgentToken(db, secondBody.token.token)).toEqual({
        id: secondBody.token.id,
        tenantId,
        definitionId: "def_artifacts",
        runId: "run_abc",
      });
    } finally {
      await close();
    }
  });

  test("the run-scoped mount rejects a run from another tenant", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_cross_${randomUUID().slice(0, 8)}`;
      const otherTenantId = `tnt_cross_other_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedTenant(db, otherTenantId);

      const app = new Hono<TenantEnv>();
      app.use(tenantFrom(db, tenantId));
      mountRunScopedTokens(app, {
        db,
        requireGrant: async (_c, next) => {
          await next();
          return undefined;
        },
        resolveRun: () => ({
          tenantId: otherTenantId,
          definitionId: "def_artifacts",
          runId: "run_other",
        }),
      });

      const res = await app.request("/workflow-run-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runAddress: "runs/cross" }),
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  test("requireRunBoundToken admits a run-bound bearer and sets workflowRunScope from the token", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_rb_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);

      const minted = await mintRunScopedToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "workflow",
        runId: "run_bound_1",
      });

      const scope = {
        tenantId,
        principalId: "principal_1",
        runId: "run_bound_1",
      };

      const app = new Hono<TenantEnv>();
      app.use(tenantFrom(db, tenantId));
      app.get(
        "/guarded",
        requireRunBoundToken({
          db,
          resolveRunById: (runId) => (runId === "run_bound_1" ? scope : null),
        }),
        (c) =>
          c.json({
            tokenRunId: c.get("agentToken").runId,
            scopeRunId: c.get("workflowRunScope").runId,
            principalId: c.get("workflowRunScope").principalId,
          }),
      );

      const ok = await app.request("/guarded", {
        headers: { authorization: `Bearer ${minted.token}` },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        tokenRunId: "run_bound_1",
        scopeRunId: "run_bound_1",
        principalId: "principal_1",
      });
    } finally {
      await close();
    }
  });

  test("requireRunBoundToken returns identical 401 for every rejection case", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_rb401_${randomUUID().slice(0, 8)}`;
      const otherTenantId = `tnt_rb401_o_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedTenant(db, otherTenantId);

      // A run-bound token.
      const bound = await mintRunScopedToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "workflow",
        runId: "run_401",
      });

      // A definition-scoped token (no runId).
      const unbound = await mintAgentToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "artifacts",
      });

      // A token from a different tenant.
      const foreign = await mintRunScopedToken(db, {
        tenantId: otherTenantId,
        definitionId: "def_artifacts",
        name: "workflow",
        runId: "run_foreign",
      });

      const app = new Hono<TenantEnv>();
      app.use(tenantFrom(db, tenantId));
      app.get(
        "/guarded",
        requireRunBoundToken({
          db,
          resolveRunById: (runId) =>
            runId === "run_401" ? { tenantId, principalId: "p1", runId } : null,
        }),
        (c) => c.json({ ok: true }),
      );

      const expected = { error: "unauthorized" };

      // No bearer.
      const noBear = await app.request("/guarded");
      expect(noBear.status).toBe(401);
      expect(await noBear.json()).toEqual(expected);

      // Fabricated bearer.
      const fake = await app.request("/guarded", {
        headers: { authorization: "Bearer invented" },
      });
      expect(fake.status).toBe(401);
      expect(await fake.json()).toEqual(expected);

      // Valid token but no runId (definition-scoped).
      const noRun = await app.request("/guarded", {
        headers: { authorization: `Bearer ${unbound.token}` },
      });
      expect(noRun.status).toBe(401);
      expect(await noRun.json()).toEqual(expected);

      // Valid token from another tenant.
      const cross = await app.request("/guarded", {
        headers: { authorization: `Bearer ${foreign.token}` },
      });
      expect(cross.status).toBe(401);
      expect(await cross.json()).toEqual(expected);

      // Valid run-bound token (positive control).
      const ok = await app.request("/guarded", {
        headers: { authorization: `Bearer ${bound.token}` },
      });
      expect(ok.status).toBe(200);
    } finally {
      await close();
    }
  });

  test("createRunBoundTokenVerifier resolves run-bound tokens and rejects everything else", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_rbv_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);

      const bound = await mintRunScopedToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "workflow",
        runId: "run_verifier",
      });

      const unbound = await mintAgentToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "artifacts",
      });

      const verify = createRunBoundTokenVerifier({
        db,
        resolveRunById: (runId) =>
          runId === "run_verifier"
            ? { tenantId, principalId: "p1", runId }
            : null,
      });

      const app = new Hono<WorkflowRunScopeEnv>();
      app.use("/:tenantId/*", async (c, next) =>
        tenantFrom<WorkflowRunScopeEnv>(db, c.req.param("tenantId"))(c, next),
      );
      app.get("/:tenantId/check", async (c) => {
        const result = await verify(c);
        return c.json({ result: result ?? null });
      });

      const ok = await app.request(`/${tenantId}/check`, {
        headers: { authorization: `Bearer ${bound.token}` },
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        result: { workflowRunScope: { runId: string } } | null;
      };
      expect(body.result).not.toBeNull();
      expect(body.result!.workflowRunScope.runId).toBe("run_verifier");

      // Unbound token returns null.
      const noRun = await app.request(`/${tenantId}/check`, {
        headers: { authorization: `Bearer ${unbound.token}` },
      });
      expect(((await noRun.json()) as { result: unknown }).result).toBeNull();

      // No bearer returns null.
      const noBear = await app.request(`/${tenantId}/check`);
      expect(((await noBear.json()) as { result: unknown }).result).toBeNull();
    } finally {
      await close();
    }
  });

  test("requireRunBoundToken returns 401 (not 500) when the host has no tenant middleware", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const app = new Hono<TenantEnv>();
      // No tenant middleware registered.
      app.get(
        "/guarded",
        requireRunBoundToken({
          db,
          resolveRunById: () => null,
        }),
        (c) => c.json({ ok: true }),
      );

      const res = await app.request("/guarded", {
        headers: { authorization: "Bearer any-value" },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    } finally {
      await close();
    }
  });
});

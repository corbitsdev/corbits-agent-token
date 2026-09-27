// DB-gated: skipped when no DATABASE_URL is reachable. Migrations run into
// a scratch schema so this test never touches a real tenant table;
// `applyAgentTokenMigrations` is told that scratch schema so its
// `tenant_id` FK targets it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import type { TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

import { applyAgentTokenMigrations } from "./schema";
import { hashAgentToken, mintAgentToken, revokeAgentToken, verifyAgentToken } from "./tokens";
import { mountAgentTokens } from "./mount";
import { createAgentTokenVerifier, requireAgentToken } from "./middleware";
import type { WorkflowRunScopeEnv } from "./workflow-run-scope";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "agent_token_test";

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

/** Every route runs the host's own middleware; these stand in for it. */
function mountedApp(
  db: ReturnType<typeof createDB>["db"],
  tenantId: string,
  options: { gate?: "allow" | "deny"; owns?: readonly string[] } = {},
) {
  const app = new Hono<TenantEnv>();
  const owns = options.owns ?? ["def_artifacts"];
  mountAgentTokens(app, {
    db,
    requireGrant: async (c, next) => {
      if (options.gate === "deny") return c.json({ error: "forbidden" }, 403);
      await next();
      return undefined;
    },
    resolveTenantId: () => tenantId,
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
  const target = dbTargetFromUrl(databaseUrl ?? "postgres://localhost:5432/unused");

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await applyAgentTokenMigrations(databaseUrl ?? "", { tenantSchema: SCHEMA });
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
      });

      expect(await verifyAgentToken(db, "not-a-token")).toBeUndefined();

      expect(await revokeAgentToken(db, { tenantId, id: minted.id })).toBe(true);
      expect(await verifyAgentToken(db, minted.token)).toBeUndefined();
      expect(await revokeAgentToken(db, { tenantId, id: minted.id })).toBe(false);
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

      const created = await app.request("/agent-tokens", mintRequest("def_artifacts"));
      expect(created.status).toBe(201);
      const body = (await created.json()) as { token: { id: string; token: string } };
      const plaintext = body.token.token;

      const listed = await app.request("/agent-tokens");
      const listedBody = (await listed.json()) as { tokens: Array<Record<string, unknown>> };
      expect(listedBody.tokens).toHaveLength(1);
      expect(JSON.stringify(listedBody)).not.toContain(plaintext);
      expect(JSON.stringify(listedBody)).not.toContain(hashAgentToken(plaintext));

      const revoked = await app.request(`/agent-tokens/${body.token.id}`, { method: "DELETE" });
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
      expect((await gated.request("/agent-tokens", mintRequest("def_artifacts"))).status).toBe(403);
      expect((await gated.request("/agent-tokens")).status).toBe(403);

      const app = mountedApp(db, tenantId);
      const foreign = await app.request("/agent-tokens", mintRequest("def_somebody_else"));
      expect(foreign.status).toBe(404);
      // No detail: a definition another tenant owns reads exactly like one
      // that never existed.
      expect(await foreign.json()).toEqual({ error: "not_found" });
    } finally {
      await close();
    }
  });

  test("the middleware admits a live bearer and 401s everything else", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_mw_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      const minted = await mintAgentToken(db, {
        tenantId,
        definitionId: "def_artifacts",
        name: "artifacts",
      });

      const app = new Hono<TenantEnv>();
      app.get("/guarded", requireAgentToken({ db }), (c) =>
        c.json({ tenantId: c.get("agentToken").tenantId }),
      );

      const ok = await app.request("/guarded", {
        headers: { authorization: `Bearer ${minted.token}` },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ tenantId });

      expect((await app.request("/guarded")).status).toBe(401);
      expect(
        (await app.request("/guarded", { headers: { authorization: "Bearer nope" } })).status,
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

      const verify = createAgentTokenVerifier({ db });
      const app = new Hono<WorkflowRunScopeEnv>();
      app.get("/verify", async (c) => c.json({ identity: (await verify(c)) ?? null }));
      const identityFor = async (authorization?: string) => {
        const res = await app.request("/verify", {
          headers: authorization === undefined ? {} : { authorization },
        });
        return ((await res.json()) as { identity: unknown }).identity;
      };

      expect(await identityFor(`Bearer ${minted.token}`)).toEqual({
        id: minted.id,
        tenantId,
        definitionId: "def_artifacts",
      });
      expect(await identityFor()).toBeNull();
      expect(await identityFor("Bearer nope")).toBeNull();
      await revokeAgentToken(db, { tenantId, id: minted.id });
      expect(await identityFor(`Bearer ${minted.token}`)).toBeNull();
    } finally {
      await close();
    }
  });
});

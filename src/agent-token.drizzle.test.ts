// DB-gated: skipped when no DATABASE_URL is reachable. Migrations run into
// a scratch schema so this test never touches a real tenant table;
// `applyAgentTokenMigrations` is told that scratch schema so its
// `tenant_id` FK targets it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import { Hono } from "hono";

import { applyAgentTokenMigrations } from "./schema";
import { hashAgentToken, mintAgentToken, revokeAgentToken, verifyAgentToken } from "./tokens";
import { mountAgentTokens } from "./mount";
import { requireAgentToken } from "./middleware";

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

      const app = new Hono();
      mountAgentTokens(app, { db, requireGrant: () => true });

      const created = await app.request(`/api/tenants/${tenantId}/agent-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_artifacts", name: "artifacts" }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { token: { id: string; token: string } };
      const plaintext = body.token.token;

      const listed = await app.request(`/api/tenants/${tenantId}/agent-tokens`);
      const listedBody = (await listed.json()) as { tokens: Array<Record<string, unknown>> };
      expect(listedBody.tokens).toHaveLength(1);
      expect(JSON.stringify(listedBody)).not.toContain(plaintext);
      expect(JSON.stringify(listedBody)).not.toContain(hashAgentToken(plaintext));

      const revoked = await app.request(
        `/api/tenants/${tenantId}/agent-tokens/${body.token.id}`,
        { method: "DELETE" },
      );
      expect(revoked.status).toBe(200);
      expect(await verifyAgentToken(db, plaintext)).toBeUndefined();
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

      const app = new Hono<{ Variables: { agentToken: { tenantId: string } } }>();
      app.use("/guarded", requireAgentToken({ db }));
      app.get("/guarded", (c) => c.json({ tenantId: c.get("agentToken").tenantId }));

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
});

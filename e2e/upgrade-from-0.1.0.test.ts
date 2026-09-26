// DB-gated: skipped when no DATABASE_URL is reachable. Builds a database
// with the published 0.1.0 package in a scratch database of its own, then
// upgrades it in place with this build: tokens minted by 0.1.0 keep working.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import type { TenantEnv } from "@intx/hub-api";
import * as published from "agent-token-0.1.0";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";

import { runAgentTokenMigrations } from "../src/migrations";
import { requireAgentToken } from "../src/middleware";
import { verifyAgentToken } from "../src/tokens";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const DATABASE = `agent_token_upgrade_${randomUUID().slice(0, 8)}`;
const TENANT_ID = "tnt_upgrade";

describeIfDb("upgrading a 0.1.0 database", () => {
  const adminUrl = databaseUrl ?? "postgres://localhost:5432/unused";
  const url = new URL(adminUrl);
  url.pathname = `/${DATABASE}`;
  const target = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: DATABASE,
  };
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  const live = { token: "", id: "" };
  const revoked = { token: "" };

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE "${DATABASE}"`);
    await runMigrations(target, { schema: "public" });
    await published.applyAgentTokenMigrations(url.toString());

    const { db, close } = createDB({ ...target, schema: "public" });
    try {
      await db.insert(schema.tenant).values({
        id: TENANT_ID,
        name: TENANT_ID,
        slug: "tnt-upgrade",
        domain: "tnt-upgrade.workbench.test",
      });
      const minted = await published.mintAgentToken(db, {
        tenantId: TENANT_ID,
        definitionId: "def_artifacts",
        name: "artifacts",
      });
      live.token = minted.token;
      live.id = minted.id;
      const gone = await published.mintAgentToken(db, {
        tenantId: TENANT_ID,
        definitionId: "def_artifacts",
        name: "gone",
      });
      revoked.token = gone.token;
      await published.revokeAgentToken(db, {
        tenantId: TENANT_ID,
        id: gone.id,
      });
    } finally {
      await close();
    }

    await runAgentTokenMigrations(target, { schema: "public" });
    await runAgentTokenMigrations(target, { schema: "public" });
  });

  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  test("tokens minted by 0.1.0 still verify, and revoked ones stay revoked", async () => {
    const { db, close } = createDB({ ...target, schema: "public" });
    try {
      expect(await verifyAgentToken(db, live.token)).toEqual({
        id: live.id,
        tenantId: TENANT_ID,
        definitionId: "def_artifacts",
      });
      expect(await verifyAgentToken(db, revoked.token)).toBeUndefined();
      const foreignKeys = await db.execute(sql`
        SELECT confrelid::regclass::text AS target FROM pg_constraint
        WHERE conrelid = 'agent_token.token'::regclass AND contype = 'f'
      `);
      expect([...foreignKeys]).toEqual([{ target: "tenant" }]);

      const app = new Hono<TenantEnv>();
      app.use(async (c, next) => {
        const [tenant] = await db.select().from(schema.tenant);
        if (tenant === undefined) return c.json({ error: "not_found" }, 404);
        c.set("tenant", tenant);
        await next();
        return undefined;
      });
      app.get("/guarded", requireAgentToken({ db }), (c) =>
        c.json({ id: c.get("agentToken").id }),
      );
      const ok = await app.request("/guarded", {
        headers: { authorization: `Bearer ${live.token}` },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ id: live.id });
      const gone = await app.request("/guarded", {
        headers: { authorization: `Bearer ${revoked.token}` },
      });
      expect(gone.status).toBe(401);
    } finally {
      await close();
    }
  });
});

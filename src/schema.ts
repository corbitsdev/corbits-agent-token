// The `agent_token` schema's one table: tokens a tenant minted for one of
// its agent definitions. Kept on its own Postgres schema, with a real FK
// back to Interchange's `tenant` table.
import { pgTable, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import postgres from "postgres";

const hostTenant = pgTable("tenant", { id: text("id").primaryKey() });

export const agentTokenSchema = pgSchema("agent_token");

export const agentTokenTable = agentTokenSchema.table("token", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => hostTenant.id, { onDelete: "cascade" }),
  definitionId: text("definition_id").notNull(),
  name: text("name").notNull(),
  // Only the digest is stored; the plaintext is returned once at mint time.
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Builds the FK against `tenantSchema.tenant` — `"public"` in every real
 * deployment, a scratch schema in tests. */
function agentTokenMigrationSql(tenantSchema: string): string {
  const tenantTable = `${quoteIdentifier(tenantSchema)}."tenant"`;
  return `
    CREATE SCHEMA IF NOT EXISTS "agent_token";
    CREATE TABLE IF NOT EXISTS "agent_token"."token" (
      "id" text PRIMARY KEY,
      "tenant_id" text NOT NULL REFERENCES ${tenantTable}("id") ON DELETE CASCADE,
      "definition_id" text NOT NULL,
      "name" text NOT NULL,
      "token_hash" text NOT NULL UNIQUE,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "revoked_at" timestamptz
    );
    CREATE INDEX IF NOT EXISTS "agent_token_token_tenant_id_idx" ON "agent_token"."token" ("tenant_id");
  `;
}

/** Applies the migration idempotently, inside one advisory-locked
 * transaction so concurrent hub replicas cannot race the same DDL. */
export async function applyAgentTokenMigrations(
  databaseUrl: string,
  options?: { tenantSchema?: string },
): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await client.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('corbits_agent_token'))`);
      await tx.unsafe(agentTokenMigrationSql(options?.tenantSchema ?? "public"));
    });
  } catch (error) {
    throw new Error(
      `@corbits/agent-token migration failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

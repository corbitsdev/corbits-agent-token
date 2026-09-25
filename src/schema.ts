// The `agent_token` schema's one table: tokens a tenant minted for one of
// its agent definitions. Kept on its own Postgres schema, with a real FK
// back to Interchange's `tenant` table.
import { pgTable, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

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

CREATE SCHEMA IF NOT EXISTS "agent_token";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_token"."token" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
  "definition_id" text NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_token_token_tenant_id_idx" ON "agent_token"."token" ("tenant_id");

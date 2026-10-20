ALTER TABLE "agent_token"."token" ADD COLUMN IF NOT EXISTS "run_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_token_token_run_id_active_idx"
  ON "agent_token"."token" ("tenant_id", "run_id")
  WHERE "revoked_at" IS NULL AND "run_id" IS NOT NULL;

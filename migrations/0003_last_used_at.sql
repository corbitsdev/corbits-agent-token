ALTER TABLE "agent_token"."token" ADD COLUMN IF NOT EXISTS "last_used_at" timestamptz;

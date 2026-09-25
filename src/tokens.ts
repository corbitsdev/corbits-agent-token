import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, isNull } from "drizzle-orm";

import { agentTokenTable } from "./schema.js";

export type AgentTokenDb<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = PostgresJsDatabase<TSchema>;

/** What a verified bearer proves: which tenant minted it, and for which
 * agent definition. */
export type AgentTokenIdentity = {
  id: string;
  tenantId: string;
  definitionId: string;
};

export type MintedAgentToken = AgentTokenIdentity & {
  name: string;
  createdAt: Date;
  /** Returned once, at mint time; only its digest is ever stored. */
  token: string;
};

const TOKEN_BYTES = 32;

export function generateAgentToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time compare of two hex digests, so a lookup that already
 * matched cannot be narrowed by timing. */
export function agentTokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function mintAgentToken<TSchema extends Record<string, unknown>>(
  db: AgentTokenDb<TSchema>,
  input: { tenantId: string; definitionId: string; name: string },
): Promise<MintedAgentToken> {
  const token = generateAgentToken();
  const [row] = await db
    .insert(agentTokenTable)
    .values({
      id: randomUUID(),
      tenantId: input.tenantId,
      definitionId: input.definitionId,
      name: input.name,
      tokenHash: hashAgentToken(token),
    })
    .returning();
  if (row === undefined) throw new Error("agent token insert returned no row");
  return {
    id: row.id,
    tenantId: row.tenantId,
    definitionId: row.definitionId,
    name: row.name,
    createdAt: row.createdAt,
    token,
  };
}

/** Resolves a presented bearer to its unrevoked row, or `undefined`. */
export async function verifyAgentToken<TSchema extends Record<string, unknown>>(
  db: AgentTokenDb<TSchema>,
  token: string,
): Promise<AgentTokenIdentity | undefined> {
  const presented = hashAgentToken(token);
  const [row] = await db
    .select()
    .from(agentTokenTable)
    .where(
      and(
        eq(agentTokenTable.tokenHash, presented),
        isNull(agentTokenTable.revokedAt),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  if (!agentTokenHashEquals(row.tokenHash, presented)) return undefined;
  return { id: row.id, tenantId: row.tenantId, definitionId: row.definitionId };
}

export async function revokeAgentToken<TSchema extends Record<string, unknown>>(
  db: AgentTokenDb<TSchema>,
  input: { tenantId: string; id: string },
): Promise<boolean> {
  const [row] = await db
    .update(agentTokenTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentTokenTable.tenantId, input.tenantId),
        eq(agentTokenTable.id, input.id),
        isNull(agentTokenTable.revokedAt),
      ),
    )
    .returning({ id: agentTokenTable.id });
  return row !== undefined;
}

/** Reads a `Bearer` credential out of an `Authorization` header value. */
export function bearerFromAuthorization(
  header: string | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1];
}

import { describe, expect, test } from "bun:test";

import { agentTokenHashEquals, bearerFromAuthorization, hashAgentToken } from "./tokens";

describe("bearerFromAuthorization", () => {
  test("reads a bearer, case-insensitively, and ignores anything else", () => {
    expect(bearerFromAuthorization("Bearer abc123")).toBe("abc123");
    expect(bearerFromAuthorization("  bearer   abc123  ")).toBe("abc123");
    expect(bearerFromAuthorization("Basic abc123")).toBeUndefined();
    expect(bearerFromAuthorization("Bearer")).toBeUndefined();
    expect(bearerFromAuthorization(undefined)).toBeUndefined();
  });
});

describe("agentTokenHashEquals", () => {
  test("compares digests without throwing on a length mismatch", () => {
    const digest = hashAgentToken("secret");
    expect(agentTokenHashEquals(digest, hashAgentToken("secret"))).toBe(true);
    expect(agentTokenHashEquals(digest, hashAgentToken("other"))).toBe(false);
    expect(agentTokenHashEquals(digest, "short")).toBe(false);
  });
});

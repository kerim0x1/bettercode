import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { sha256Hex } from "./sha256"

describe("the demo's SHA-256", () => {
  it("is Node's SHA-256 for empty, short, block-sized, long and non-ASCII text", () => {
    for (const text of [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "x".repeat(1000),
      "Grüße, 世界 😀\n",
    ]) {
      expect(sha256Hex(text), JSON.stringify(text.slice(0, 20))).toBe(
        createHash("sha256").update(text, "utf8").digest("hex")
      )
    }
  })
})

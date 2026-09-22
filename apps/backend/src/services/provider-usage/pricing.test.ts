import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PriceBook, priceModels, type PricedTokens } from "./pricing"

function tokens(partial: Partial<PricedTokens> = {}): PricedTokens {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    ...partial,
  }
}

describe("PriceBook", () => {
  const book = new PriceBook(null)

  it("prices a million of each token type at the published rates", () => {
    // Opus 5: $5 in, $25 out, cache read 0.1x, writes 1.25x / 2x.
    const cost = book.cost(
      "claude-opus-5",
      tokens({
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
      })
    )
    expect(cost).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25 + 10,
    })
  })

  it("uses the cheaper cache read rate where the model has one", () => {
    expect(
      book.cost("claude-fable-5-1", tokens({ cacheRead: 1_000_000 }))
    ).toMatchObject({ cacheRead: 0.25 })
    // Fable 5 keeps the usual 0.1x of its $10 input rate.
    expect(
      book.cost("claude-fable-5", tokens({ cacheRead: 1_000_000 }))
    ).toMatchObject({ cacheRead: 1 })
  })

  it("treats a dated model id as the model it names", () => {
    expect(book.rateFor("claude-haiku-4-5-20251001")).toEqual(
      book.rateFor("claude-haiku-4-5")
    )
  })

  it("prices the other providers from their own published rates", () => {
    // OpenAI and xAI list cached input explicitly; xAI's is 0.25x, not 0.1x.
    expect(book.rateFor("gpt-6-astra")).toMatchObject({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite5m: 12.5,
    })
    expect(book.rateFor("grok-4.6")).toMatchObject({
      input: 2,
      output: 6,
      cacheRead: 0.5,
    })
  })

  it("returns null rather than guessing an unknown model", () => {
    expect(book.rateFor("some-unreleased-model")).toBeNull()
    expect(
      book.cost("some-unreleased-model", tokens({ input: 1_000_000 }))
    ).toBeNull()
  })
})

describe("priceModels", () => {
  const book = new PriceBook(null)

  it("counts unpriced models instead of dropping them", () => {
    const { pricing, costByModel } = priceModels(
      book,
      new Map([
        ["claude-opus-5", tokens({ input: 1_000_000 })],
        ["some-unreleased-model", tokens({ input: 4_000_000 })],
      ])
    )
    expect(pricing?.total).toBe(5)
    expect(pricing?.pricedTokens).toBe(1_000_000)
    expect(pricing?.unpricedTokens).toBe(4_000_000)
    expect(pricing?.unpricedModels).toEqual(["some-unreleased-model"])
    expect(costByModel.get("claude-opus-5")).toBe(5)
    expect(costByModel.has("some-unreleased-model")).toBe(false)
  })

  it("reports nothing when no model has a rate", () => {
    const { pricing } = priceModels(
      book,
      new Map([["some-unreleased-model", tokens({ input: 1_000_000 })]])
    )
    expect(pricing).toBeNull()
  })
})

describe("price overrides", () => {
  let dataDir = ""

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-prices-"))
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  function write(body: unknown): void {
    fs.writeFileSync(
      path.join(dataDir, "model-prices.json"),
      JSON.stringify(body),
      "utf8"
    )
  }

  it("prices a model the bundled table does not know", () => {
    write({ "some-unreleased-model": { input: 2, output: 8 } })
    const book = new PriceBook(dataDir)
    expect(book.hasOverrides).toBe(true)
    expect(
      book.cost(
        "some-unreleased-model",
        tokens({ input: 1_000_000, output: 1_000_000 })
      )
    ).toMatchObject({ input: 2, output: 8 })
    // Cache rates fall out of the same multipliers when not given.
    expect(book.rateFor("some-unreleased-model")).toMatchObject({
      cacheRead: 0.2,
      cacheWrite5m: 2.5,
    })
  })

  it("wins over a bundled rate and keeps explicit cache rates", () => {
    write({
      "claude-opus-5": { input: 1, output: 2, cacheRead: 0.5, cacheWrite1h: 9 },
    })
    const rate = new PriceBook(dataDir).rateFor("claude-opus-5")
    expect(rate).toMatchObject({ input: 1, cacheRead: 0.5, cacheWrite1h: 9 })
    // Unspecified write rate still follows the 1.25x rule.
    expect(rate?.cacheWrite5m).toBe(1.25)
  })

  it("ignores malformed entries and an unreadable file", () => {
    write({ good: { input: 1, output: 1 }, bad: { input: "free" } })
    const book = new PriceBook(dataDir)
    expect(book.rateFor("good")).not.toBeNull()
    expect(book.rateFor("bad")).toBeNull()
    expect(new PriceBook(path.join(dataDir, "missing")).hasOverrides).toBe(
      false
    )
  })
})

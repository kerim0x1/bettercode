import fs from "node:fs"
import path from "node:path"
import type { UsagePricing } from "./types"

/**
 * List prices per million tokens.
 *
 * Only models with a published rate are listed. Anything else stays unpriced
 * and is reported as such rather than estimated — a made-up rate on billions
 * of tokens is worse than an honest gap. Add rates for other providers in
 * `model-prices.json` next to the database; see `readOverrides`.
 *
 * Anthropic rates from the bundled Claude API reference (cached 2026-06-24).
 * Cache reads are 0.1x the input rate except where noted; cache writes are
 * 1.25x for the 5-minute TTL and 2x for the 1-hour TTL.
 */

export interface ModelRate {
  /** USD per 1M tokens. */
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export interface PricedTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export interface CostBreakdown {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function rate(
  input: number,
  output: number,
  cacheRead = input * 0.1
): ModelRate {
  return {
    input,
    output,
    cacheRead,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
  }
}

const BUILT_IN: Readonly<Record<string, ModelRate>> = {
  // Anthropic — bundled Claude API reference, cached 2026-06-24.
  "claude-fable-5-1": rate(10, 50, 0.25),
  "claude-fable-5": rate(10, 50),
  "claude-opus-5-5": rate(4, 20, 0.2),
  "claude-opus-5": rate(5, 25),
  "claude-opus-4-8": rate(5, 25),
  "claude-opus-4-7": rate(5, 25),
  "claude-opus-4-6": rate(5, 25),
  "claude-sonnet-5": rate(2, 10),
  "claude-sonnet-4-6": rate(3, 15),
  "claude-haiku-4-5": rate(1, 5),

  // OpenAI — published rates, read 2026-09-22. Cached input is 0.1x and a
  // cache write 1.25x of input, the same shape as above.
  "gpt-6-astra": rate(10, 50),
  "gpt-6-sol": rate(2, 10),
  "gpt-6-luna": rate(0.1, 0.5),
  "gpt-5.6-cyber": rate(12.5, 75),
  "gpt-5.6-sol": rate(4, 20),
  "gpt-5.6-terra": rate(2, 12),
  "gpt-5.6-luna": rate(0.2, 1.2),
  "gpt-5.5-pro": rate(30, 180),
  "gpt-5.5-cyber": rate(12.5, 75),
  "gpt-5.5": rate(5, 30),
  "gpt-5.4-pro": rate(30, 180),
  "gpt-5.4-mini": rate(0.75, 4.5),
  "gpt-5.4-nano": rate(0.2, 1.25),
  "gpt-5.4": rate(2.5, 15),
  "gpt-5.3-codex": rate(1.75, 14),
  "gpt-5.2-pro": rate(21, 168),
  "gpt-5.2-codex": rate(1.75, 14),
  "gpt-5.2": rate(1.75, 14),

  // xAI — docs.x.ai pricing, read 2026-09-22. Cached input is 0.25x of
  // input here (0.15x on Grok 4.5), so those rates are given explicitly.
  "grok-4.7-build-fast": rate(4, 12, 1),
  "grok-4.7": rate(2, 6, 0.5),
  "grok-4.6": rate(2, 6, 0.5),
  "grok-4.5": rate(2, 6, 0.3),
  "grok-build-0.1": rate(1, 2, 0.2),
}

/**
 * Providers that bill a whole request at a higher rate once the prompt
 * crosses a context threshold — 272K on GPT-6 Astra, 200K on Grok. The
 * stores record no per-request prompt size, so the table uses the standard
 * rate and the report says the long-context share is not counted.
 */
export const LONG_CONTEXT_NOTE =
  "Rates are the standard short-context tier. OpenAI and xAI bill a whole request at roughly double once the prompt crosses their long-context threshold, and the local stores do not record per-request prompt size, so those requests are under-counted here."

const OVERRIDE_FILE = "model-prices.json"
const PER_MILLION = 1_000_000

/** `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are the same model. */
function normalize(model: string): string {
  return model.trim().replace(/-\d{8}$/, "")
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
}

/**
 * Rates the user added themselves, for providers this file does not ship —
 * `{ "gpt-6-astra": { "input": 1.25, "output": 10 } }`. `cacheRead` and the
 * two cache-write rates fall back to the same multipliers used above.
 */
function readOverrides(dataDir: string | null): Record<string, ModelRate> {
  if (!dataDir) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(dataDir, OVERRIDE_FILE), "utf8")
    )
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const rates: Record<string, ModelRate> = {}
  for (const [model, value] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const input = readNumber(entry.input)
    const output = readNumber(entry.output)
    if (input === null || output === null) continue
    const base = rate(input, output, readNumber(entry.cacheRead) ?? undefined)
    rates[normalize(model)] = {
      ...base,
      cacheWrite5m: readNumber(entry.cacheWrite5m) ?? base.cacheWrite5m,
      cacheWrite1h: readNumber(entry.cacheWrite1h) ?? base.cacheWrite1h,
    }
  }
  return rates
}

export class PriceBook {
  private readonly overrides: Record<string, ModelRate>
  /** Where a user adds rates this file does not ship. */
  readonly file: string | null

  constructor(dataDir: string | null) {
    this.overrides = readOverrides(dataDir)
    this.file = dataDir ? path.join(dataDir, OVERRIDE_FILE) : null
  }

  get hasOverrides(): boolean {
    return Object.keys(this.overrides).length > 0
  }

  rateFor(model: string): ModelRate | null {
    const key = normalize(model)
    return this.overrides[key] ?? BUILT_IN[key] ?? null
  }

  /** `null` when the model has no rate, so the caller can report the gap. */
  cost(model: string, tokens: PricedTokens): CostBreakdown | null {
    const found = this.rateFor(model)
    if (!found) return null
    return {
      input: (tokens.input * found.input) / PER_MILLION,
      output: (tokens.output * found.output) / PER_MILLION,
      cacheRead: (tokens.cacheRead * found.cacheRead) / PER_MILLION,
      cacheWrite:
        (tokens.cacheWrite5m * found.cacheWrite5m +
          tokens.cacheWrite1h * found.cacheWrite1h) /
        PER_MILLION,
    }
  }
}

export function addCost(target: CostBreakdown, source: CostBreakdown): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

export function emptyCost(): CostBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function costTotal(cost: CostBreakdown): number {
  return cost.input + cost.output + cost.cacheRead + cost.cacheWrite
}

/**
 * Price a whole report. Models without a rate are counted, not guessed, so
 * the renderer can say how much of the usage the number actually covers.
 */
export function priceModels(
  book: PriceBook,
  byModel: ReadonlyMap<string, PricedTokens>,
  notes: string[] = []
): { pricing: UsagePricing | null; costByModel: Map<string, number> } {
  const breakdown = emptyCost()
  const costByModel = new Map<string, number>()
  const unpricedModels: string[] = []
  let pricedTokens = 0
  let unpricedTokens = 0
  for (const [model, tokens] of byModel) {
    const cost = book.cost(model, tokens)
    if (!cost) {
      unpricedModels.push(model)
      unpricedTokens += tokenTotal(tokens)
      continue
    }
    addCost(breakdown, cost)
    pricedTokens += tokenTotal(tokens)
    costByModel.set(model, costTotal(cost))
  }
  if (pricedTokens === 0) return { pricing: null, costByModel }
  return {
    pricing: {
      currency: "USD",
      total: costTotal(breakdown),
      breakdown,
      pricedTokens,
      unpricedTokens,
      unpricedModels: unpricedModels.sort(),
      hasOverrides: book.hasOverrides,
      notes,
    },
    costByModel,
  }
}

export function tokenTotal(tokens: PricedTokens): number {
  return (
    tokens.input +
    tokens.output +
    tokens.cacheRead +
    tokens.cacheWrite5m +
    tokens.cacheWrite1h
  )
}

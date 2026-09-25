import { describe, expect, it } from "vitest"
import {
  buildFavoriteProviderIndex,
  favoriteProvidersSignature,
  normalizeFavoriteKeysForProviders,
} from "@/hooks/use-favorites"
import type { UiProvider } from "@/lib/provider-types"

function provider(id: string, models: string[]): UiProvider {
  return {
    id,
    name: id,
    logo: "",
    models: models.map((model) => ({
      id: model,
      name: model,
      context: "test",
      tier: "test",
    })),
  }
}

describe("normalizeFavoriteKeysForProviders", () => {
  it("migrates legacy bare model ids to provider-scoped favorite keys", () => {
    const index = buildFavoriteProviderIndex([
      provider("codex", ["gpt-5.5"]),
      provider("claude", ["claude-opus-4-7"]),
    ])

    expect(
      normalizeFavoriteKeysForProviders(
        ["gpt-5.5", "claude::claude-opus-4-7"],
        index
      )
    ).toEqual(["codex::gpt-5.5", "claude::claude-opus-4-7"])
  })

  it("dedupes and preserves temporarily missing models and providers", () => {
    const index = buildFavoriteProviderIndex([provider("codex", ["gpt-5.5"])])

    expect(
      normalizeFavoriteKeysForProviders(
        [
          "codex::gpt-5.5",
          "codex::gpt-5.5",
          "codex::missing",
          "disabled-provider::future-model",
        ],
        index
      )
    ).toEqual([
      "codex::gpt-5.5",
      "codex::missing",
      "disabled-provider::future-model",
    ])
  })

  it("moves old Claude API favorites to its visible provider entry", () => {
    const index = buildFavoriteProviderIndex([
      provider("anthropic-api", ["claude-opus-5-5"]),
    ])
    expect(
      normalizeFavoriteKeysForProviders(["anthropic::claude-opus-5-5"], index)
    ).toEqual(["anthropic-api::claude-opus-5-5"])
  })
})

describe("favoriteProvidersSignature", () => {
  it("is stable for equivalent provider/model content", () => {
    expect(favoriteProvidersSignature([provider("codex", ["gpt-5.5"])])).toBe(
      favoriteProvidersSignature([provider("codex", ["gpt-5.5"])])
    )
    expect(
      favoriteProvidersSignature([provider("codex", ["gpt-5.5"])])
    ).not.toBe(favoriteProvidersSignature([provider("codex", ["gpt-5.4"])]))
  })
})

import type { Hono } from "hono"
import { apiKeyProviderSchema } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { ApiKeyPool, readApiKeyResponseError } from "../../auth/apiKeyPool"
import { requestIdentity } from "../../remote/http"
import { contractJson, handleHttpContract } from "../contracts"
import { HttpError } from "../errors"

/**
 * The desktop owner's API keys. Every route answers with the provider's key
 * list, checked against its shared contract
 * (`@betterc0de/schema/http-contracts`).
 */
export function registerApiKeyRoutes(api: Hono, state: AppState): void {
  const pool = state.apiKeyPool ?? new ApiKeyPool(state.settings)
  api.use("/providers/api-keys/*", async (c, next) => {
    if (requestIdentity(c, state.config, state)?.kind !== "local")
      return c.json(
        { error: "Only the desktop owner can manage API keys." },
        403
      )
    await next()
  })
  const provider = (id: string) => {
    const parsed = apiKeyProviderSchema.safeParse(id)
    if (!parsed.success)
      throw new HttpError(400, "Unsupported API-key provider")
    return parsed.data
  }
  api.get("/providers/api-keys/:provider", (c) =>
    contractJson(c, "apiKeysList", pool.view(provider(c.req.param("provider"))))
  )
  api.delete("/providers/api-keys/:provider", (c) =>
    contractJson(
      c,
      "apiKeysUseExternal",
      pool.useExternal(provider(c.req.param("provider")))
    )
  )
  api.post("/providers/api-keys/:provider", (c) =>
    handleHttpContract(
      c,
      "apiKeysAdd",
      async (body) =>
        pool.add(provider(c.req.param("provider")), body.label, body.apiKey),
      { operation: "API key add" }
    )
  )
  api.put("/providers/api-keys/:provider/order", (c) =>
    handleHttpContract(
      c,
      "apiKeysReorder",
      async (body) => pool.reorder(provider(c.req.param("provider")), body.ids),
      { operation: "API key reorder" }
    )
  )
  api.patch("/providers/api-keys/:provider/:id", (c) =>
    handleHttpContract(
      c,
      "apiKeysUpdate",
      async (body) =>
        pool.update(provider(c.req.param("provider")), c.req.param("id"), body),
      { operation: "API key update" }
    )
  )
  api.delete("/providers/api-keys/:provider/:id", (c) =>
    contractJson(
      c,
      "apiKeysRemove",
      pool.remove(provider(c.req.param("provider")), c.req.param("id"))
    )
  )
  api.post("/providers/api-keys/:provider/:id/retry", (c) =>
    contractJson(
      c,
      "apiKeysRetry",
      pool.reset(provider(c.req.param("provider")), c.req.param("id"))
    )
  )
  api.post("/providers/api-keys/:provider/:id/test", async (c) => {
    const kind = provider(c.req.param("provider"))
    const key = pool.requireKey(kind, c.req.param("id"))
    const info = pool.view(kind).keys.find((entry) => entry.id === key.id)!
    const version = pool.version(kind, key)
    if ((info.retryAt ?? 0) > Date.now())
      throw new HttpError(
        409,
        "Wait for the provider's retry delay before checking this key."
      )
    const url =
      kind === "anthropic"
        ? "https://api.anthropic.com/v1/models?limit=1"
        : kind === "openai"
          ? "https://api.openai.com/v1/models"
          : "https://api.x.ai/v1/models"
    const headers: Record<string, string> =
      kind === "anthropic"
        ? { "x-api-key": key.key, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${key.key}` }
    let checkError: string | null = null
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined)
        // Model listing proves authentication, not that billing has recovered.
        if (info.status !== "quota") pool.success(kind, key, version)
      } else {
        const failure = pool.failure(
          kind,
          key,
          await readApiKeyResponseError(response),
          version
        )
        if (failure.kind === "request") checkError = failure.message
      }
    } catch (error) {
      const failure = pool.failure(kind, key, error, version)
      if (failure.kind === "request") checkError = failure.message
    }
    if (checkError) throw new HttpError(400, checkError)
    return contractJson(c, "apiKeysTest", pool.view(kind))
  })
}

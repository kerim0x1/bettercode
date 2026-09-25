import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  anthropicContextLabel,
  anthropicModelDisplayName,
  anthropicModelTier,
  compareAnthropicModelIds,
  parseAnthropicModelId,
} from "@betterc0de/schema"
import type { ModelDefinition } from "../types"

export type ApiCatalogProvider = "anthropic" | "openai" | "grok"

const TTL_MS = 15 * 60_000
const FAILURE_RETRY_MS = 30_000
const TIMEOUT_MS = 5_000
const MAX_ANTHROPIC_PAGES = 20

interface Entry {
  readonly models: ModelDefinition[]
  readonly fetchedAt: number
}

/** Only model metadata is written to disk. The filename contains a hash of the
 * whole credential, so separate API accounts never share a stale catalog. */
export class ApiModelCatalog {
  private readonly entries = new Map<string, Entry>()
  private readonly inFlight = new Map<string, Promise<ModelDefinition[]>>()
  private readonly retryAfter = new Map<string, number>()

  constructor(
    private readonly directory?: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  invalidate(provider: ApiCatalogProvider, apiKey: string): void {
    const id = this.cacheId(provider, apiKey)
    this.entries.delete(id)
    this.retryAfter.delete(id)
  }

  async list(
    provider: ApiCatalogProvider,
    apiKey: string | null,
    force = false
  ): Promise<ModelDefinition[]> {
    if (!apiKey?.trim()) return []
    const id = this.cacheId(provider, apiKey)
    const now = Date.now()
    const cached = this.entries.get(id) ?? this.load(id, provider)
    if (!force && cached && now - cached.fetchedAt < TTL_MS)
      return cached.models
    if (!force && now < (this.retryAfter.get(id) ?? 0))
      return cached?.models ?? []
    const pending = this.inFlight.get(id)
    if (pending) return pending
    const request = this.fetchCatalog(provider, apiKey)
      .then(
        (models) => {
          const entry = { models, fetchedAt: Date.now() }
          this.entries.set(id, entry)
          this.retryAfter.delete(id)
          this.save(id, entry)
          return models
        },
        () => {
          this.retryAfter.set(id, Date.now() + FAILURE_RETRY_MS)
          return cached?.models ?? []
        }
      )
      .finally(() => {
        this.inFlight.delete(id)
      })
    this.inFlight.set(id, request)
    return request
  }

  private cacheId(provider: ApiCatalogProvider, apiKey: string): string {
    return `${provider}-${createHash("sha256").update(apiKey).digest("hex")}`
  }

  private load(id: string, provider: ApiCatalogProvider): Entry | null {
    if (!this.directory) return null
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(path.join(this.directory, `${id}.json`), "utf8")
      )
      if (!isRecord(value) || !Array.isArray(value.models)) return null
      const models = value.models.filter(
        (model): model is ModelDefinition =>
          isRecord(model) &&
          model.provider === provider &&
          typeof model.slug === "string" &&
          typeof model.name === "string"
      )
      const entry = { models, fetchedAt: 0 }
      this.entries.set(id, entry)
      return entry
    } catch {
      return null
    }
  }

  private save(id: string, entry: Entry): void {
    if (!this.directory) return
    try {
      fs.mkdirSync(this.directory, { recursive: true })
      const target = path.join(this.directory, `${id}.json`)
      const temporary = `${target}.${process.pid}.tmp`
      fs.writeFileSync(temporary, JSON.stringify({ models: entry.models }))
      fs.renameSync(temporary, target)
    } catch {
      // A disk error must not hide a successful in-memory catalog.
    }
  }

  private async fetchCatalog(
    provider: ApiCatalogProvider,
    apiKey: string
  ): Promise<ModelDefinition[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      if (provider === "anthropic") {
        const models: ModelDefinition[] = []
        let afterId: string | null = null
        for (let page = 0; page < MAX_ANTHROPIC_PAGES; page += 1) {
          const url = new URL("https://api.anthropic.com/v1/models")
          url.searchParams.set("limit", "100")
          if (afterId) url.searchParams.set("after_id", afterId)
          const body = await this.request(
            url.toString(),
            {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            controller.signal
          )
          if (!Array.isArray(body.data))
            throw new Error("Invalid Anthropic model list")
          for (const item of body.data) {
            if (!isRecord(item) || typeof item.id !== "string") continue
            const slug = item.id.trim()
            if (!slug) continue
            models.push({
              provider,
              slug,
              name:
                typeof item.display_name === "string"
                  ? item.display_name
                  : (anthropicModelDisplayName(slug) ?? slug),
              ...(parseAnthropicModelId(slug)
                ? { context: anthropicContextLabel(slug) }
                : {}),
              tier: anthropicModelTier(slug) ?? "Runtime",
              ...(slug === "claude-opus-5-5"
                ? {
                    capabilities: {
                      optionDescriptors: [
                        {
                          id: "effort",
                          label: "Reasoning",
                          type: "select",
                          currentValue: "medium",
                          options: [
                            "low",
                            "medium",
                            "high",
                            "xhigh",
                            "max",
                          ].map((id) => ({
                            id,
                            label: effortLabel(id),
                            ...(id === "medium" ? { isDefault: true } : {}),
                          })),
                        },
                      ],
                    },
                  }
                : {}),
            })
          }
          if (body.has_more !== true) break
          if (typeof body.last_id !== "string" || body.last_id === afterId)
            throw new Error("Invalid Anthropic model pagination")
          if (page === MAX_ANTHROPIC_PAGES - 1)
            throw new Error("Anthropic model list exceeded pagination limit")
          afterId = body.last_id
        }
        return dedupe(models).sort((a, b) =>
          compareAnthropicModelIds(a.slug, b.slug)
        )
      }
      if (provider === "openai") {
        const body = await this.request(
          "https://api.openai.com/v1/models",
          { Authorization: `Bearer ${apiKey}` },
          controller.signal
        )
        if (!Array.isArray(body.data))
          throw new Error("Invalid OpenAI model list")
        return dedupe(
          body.data.flatMap((item): ModelDefinition[] => {
            if (!isRecord(item) || typeof item.id !== "string") return []
            const slug = item.id.trim()
            if (!isOpenAiChatModel(slug)) return []
            return [
              {
                provider,
                slug,
                name: slug,
                tier: "Runtime",
                ...(slug === "gpt-5.6-sol"
                  ? {
                      context: "1.05M",
                      capabilities: {
                        optionDescriptors: [
                          {
                            id: "reasoningEffort",
                            label: "Reasoning",
                            type: "select",
                            currentValue: "medium",
                            options: [
                              "none",
                              "low",
                              "medium",
                              "high",
                              "xhigh",
                              "max",
                            ].map((id) => ({
                              id,
                              label: effortLabel(id),
                              ...(id === "medium" ? { isDefault: true } : {}),
                            })),
                          },
                        ],
                      },
                    }
                  : {}),
              },
            ]
          })
        ).sort((a, b) => b.slug.localeCompare(a.slug, "en"))
      }
      const body = await this.request(
        "https://api.x.ai/v1/language-models",
        { Authorization: `Bearer ${apiKey}` },
        controller.signal
      )
      if (!Array.isArray(body.models)) throw new Error("Invalid xAI model list")
      return dedupe(
        body.models.flatMap((item): ModelDefinition[] => {
          if (!isRecord(item) || typeof item.id !== "string") return []
          if (
            Array.isArray(item.output_modalities) &&
            !item.output_modalities.includes("text")
          )
            return []
          const slug = item.id.trim()
          if (!slug) return []
          const details = isRecord(item.capabilities) ? item.capabilities : {}
          const effort = Array.isArray(details.reasoning_effort)
            ? details.reasoning_effort.filter(
                (value): value is string =>
                  typeof value === "string" && value.trim().length > 0
              )
            : []
          const defaultEffort =
            typeof details.default_reasoning_effort === "string"
              ? details.default_reasoning_effort
              : null
          return [
            {
              provider,
              slug,
              name: slug,
              tier: "Runtime",
              ...(typeof item.context_length === "number"
                ? { context: contextLabel(item.context_length) }
                : {}),
              capabilities: {
                optionDescriptors:
                  effort.length > 0
                    ? [
                        {
                          id: "reasoningEffort",
                          label: "Reasoning",
                          type: "select",
                          options: effort.map((id) => ({
                            id,
                            label: effortLabel(id),
                            ...(id === defaultEffort
                              ? { isDefault: true }
                              : {}),
                          })),
                          ...(defaultEffort
                            ? { currentValue: defaultEffort }
                            : {}),
                        },
                      ]
                    : [],
              },
            },
          ]
        })
      ).sort((a, b) => b.slug.localeCompare(a.slug, "en"))
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers,
      signal,
    })
    if (!response.ok)
      throw new Error(`Model list failed with ${response.status}`)
    const body: unknown = await response.json()
    if (!isRecord(body)) throw new Error("Invalid model list")
    return body
  }
}

export function isOpenAiChatModel(slug: string): boolean {
  const id = slug.toLowerCase()
  if (!/^(?:gpt-(?:\d|oss-)|o\d|chatgpt-)/.test(id)) return false
  return !/(?:image|audio|realtime|transcrib|tts|speech|embedding|moderation|search|instruct|diariz|video)/.test(
    id
  )
}

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return "runtime"
}

function effortLabel(id: string): string {
  if (id === "none") return "No Reasoning"
  if (id === "xhigh") return "Extra High"
  return id[0].toUpperCase() + id.slice(1)
}

function dedupe(models: ModelDefinition[]): ModelDefinition[] {
  return [...new Map(models.map((model) => [model.slug, model])).values()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

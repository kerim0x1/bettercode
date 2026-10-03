import { z } from "zod"
import { secretStateSchema } from "./secret"

export const apiKeyProviderSchema = z.enum(["anthropic", "openai", "grok"])
export type ApiKeyProvider = z.infer<typeof apiKeyProviderSchema>

export const storedApiKeySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    // Ciphertext on disk; plaintext only inside the backend.
    api_key: z.string(),
  })
  .strict()

export const storedApiKeysSchema = z
  .array(storedApiKeySchema)
  .max(20)
  .refine(
    (keys) => new Set(keys.map((key) => key.id)).size === keys.length,
    "API key IDs must be unique"
  )

export const apiKeyStatusSchema = z.enum([
  "untested",
  "ready",
  "invalid",
  "quota",
  "cooldown",
  "disabled",
])
export const apiKeyInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  source: z.enum(["settings", "environment", "cliConfig"]),
  secret: secretStateSchema,
  status: apiKeyStatusSchema,
  message: z.string().nullable(),
  retryAt: z.number().nullable(),
  checkedAt: z.number().nullable(),
})
export const apiKeyPoolViewSchema = z.object({
  provider: apiKeyProviderSchema,
  enabled: z.boolean(),
  managed: z.boolean(),
  keys: z.array(apiKeyInfoSchema),
})
export const addApiKeySchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    apiKey: z.string().trim().min(1).max(4096),
  })
  .strict()
export const updateApiKeySchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
    apiKey: z.string().trim().min(1).max(4096).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Empty key update")
export const reorderApiKeysSchema = z
  .object({
    ids: z.array(z.string().min(1).max(128)).max(20),
  })
  .strict()

export type StoredApiKey = z.infer<typeof storedApiKeySchema>
export type ApiKeyInfo = z.infer<typeof apiKeyInfoSchema>
export type ApiKeyPoolView = z.infer<typeof apiKeyPoolViewSchema>

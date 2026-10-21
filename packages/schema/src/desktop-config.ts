import { z } from "zod"
import {
  RUNTIME_HOOK_LIMITS,
  RUNTIME_MCP_LIMITS,
  type RuntimeHookRecord,
  type RuntimeMcpServerRecord,
} from "./runtime-records"

/**
 * The desktop configuration the backend owns: `mcp-servers.json`,
 * `hooks.json`, `rules.md`, `skills/<id>/` and `subagents/<id>/` in the
 * runtime home (`ServerConfig.runtimeHome`). The desktop's main process
 * reads and writes them only through `/api/v1/config/*` (apps/shell
 * `shared/desktop-config-client.cjs`); the backend writes each file
 * atomically under a per-file lock.
 *
 * The routes are desktop-only: they require the main process's capability
 * header, so neither the renderer nor a paired device reaches them. The
 * stored shapes are exactly the desktop's, approval markers and `enc:v1:`
 * secrets included: the backend keeps what the main process wrote and never
 * decrypts, re-signs or drops a field on a write.
 */

/** Bounds of the documents and entries behind `/api/v1/config/*`. */
export const DESKTOP_CONFIG_LIMITS = {
  /** A skill or subagent id: the desktop's slug (`[a-z0-9-]`, 120 chars). */
  maxIdChars: 120,
  /** Skills or subagents listed at most. */
  maxDirectoryEntries: 1_000,
  /** One `manifest.json` of a skill or subagent. */
  maxManifestBytes: 256 * 1024,
  /** `rules.md`, a skill's `content.md`, a subagent's `prompt.md`. */
  maxTextBytes: 4 * 1024 * 1024,
  /** A revision token. */
  maxRevisionChars: 128,
  /** Request bodies of these routes (the MCP store alone may hold 4 MB). */
  maxRequestBytes: 10 * 1024 * 1024,
} as const

/**
 * The capability header the desktop's main process sends with every
 * `/config` request. Its value is the backend's bearer, which renderer code
 * never sees (the main process injects it at the network layer), so a
 * request that carries it comes from the main process.
 */
export const DESKTOP_SHELL_CAPABILITY_HEADER = "X-BetterC0de-Desktop-Shell"

const utf8 = new TextEncoder()

const slugIdSchema = z
  .string()
  .min(1)
  .max(DESKTOP_CONFIG_LIMITS.maxIdChars)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected a lowercase slug id")

/**
 * A document's version: `sha256:<hex>` of the bytes on disk, or `absent`
 * for a missing file. A write that names the revision it was computed from
 * fails with `409 desktop_config_conflict` when the file changed since.
 */
export const desktopConfigRevisionSchema = z
  .string()
  .min(1)
  .max(DESKTOP_CONFIG_LIMITS.maxRevisionChars)

/**
 * An entry as stored. Only the identity is required: the files outlive
 * releases, entries an older desktop wrote must keep round-tripping, and
 * the main process checks every record it builds against the shared
 * record schemas (`runtime-records`) before it sends it.
 */
function storedRecordSchema(maxIdChars: number) {
  return z
    .object({
      id: z
        .string()
        .max(maxIdChars)
        .refine(
          (value) => value.trim().length > 0,
          "Entry id must not be blank"
        ),
    })
    .passthrough()
}

function uniqueIds(entries: ReadonlyArray<{ id: string }>): boolean {
  return new Set(entries.map((entry) => entry.id)).size === entries.length
}

const storedMcpRecordSchema = storedRecordSchema(
  RUNTIME_MCP_LIMITS.maxNameChars
)
const storedHookRecordSchema = storedRecordSchema(
  RUNTIME_HOOK_LIMITS.maxIdChars
)

/**
 * `GET /config/mcp` and `GET /config/hooks`. `problem` is set when the file
 * exists but could not be read as a list of entries; `entries` is then
 * empty. A write replaces a file that is not JSON (keeping a `.corrupt-*`
 * copy next to it) and is refused (409) for JSON that is not such a list.
 */
function documentSchema<T extends z.ZodType>(entry: T, maxEntries: number) {
  return z.object({
    entries: z.array(entry).max(maxEntries),
    revision: desktopConfigRevisionSchema,
    problem: z.string().max(4_096).optional(),
  })
}

function documentWriteSchema<T extends z.ZodType<{ id: string }>>(
  entry: T,
  maxEntries: number
) {
  return z
    .object({
      entries: z.array(entry).max(maxEntries),
      /** The revision the entries were computed from; omit to overwrite. */
      expectedRevision: desktopConfigRevisionSchema.nullable().optional(),
    })
    .strict()
    .refine((body) => uniqueIds(body.entries), {
      message: "Entry ids must be unique",
      path: ["entries"],
    })
}

export const desktopConfigMcpDocumentSchema = documentSchema(
  storedMcpRecordSchema,
  RUNTIME_MCP_LIMITS.maxServers
)
export const desktopConfigMcpWriteSchema = documentWriteSchema(
  storedMcpRecordSchema,
  RUNTIME_MCP_LIMITS.maxServers
)
export const desktopConfigHooksDocumentSchema = documentSchema(
  storedHookRecordSchema,
  RUNTIME_HOOK_LIMITS.maxHooks
)
export const desktopConfigHooksWriteSchema = documentWriteSchema(
  storedHookRecordSchema,
  RUNTIME_HOOK_LIMITS.maxHooks
)

const textSchema = z
  .string()
  .refine(
    (value) => utf8.encode(value).length <= DESKTOP_CONFIG_LIMITS.maxTextBytes,
    `At most ${DESKTOP_CONFIG_LIMITS.maxTextBytes} bytes`
  )

/** `GET /config/rules`: the user's own rules (`rules.md`). */
export const desktopConfigRulesSchema = z.object({
  content: textSchema,
  revision: desktopConfigRevisionSchema,
})

export const desktopConfigRulesWriteSchema = z
  .object({
    content: textSchema,
    expectedRevision: desktopConfigRevisionSchema.nullable().optional(),
  })
  .strict()

/** A skill's or subagent's `manifest.json`, as the desktop writes it. */
const manifestSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) =>
      utf8.encode(JSON.stringify(value)).length <=
      DESKTOP_CONFIG_LIMITS.maxManifestBytes,
    `A manifest is at most ${DESKTOP_CONFIG_LIMITS.maxManifestBytes} bytes`
  )

/**
 * One skill (`skills/<id>/manifest.json` + `content.md`) or subagent
 * (`subagents/<id>/manifest.json` + `prompt.md`). `id` is the folder name;
 * `text` is the markdown file.
 */
export const desktopConfigDirectoryEntrySchema = z.object({
  id: z.string().min(1).max(255),
  manifest: manifestSchema,
  text: z.string(),
})

export const desktopConfigDirectoryListSchema = z.object({
  entries: z
    .array(desktopConfigDirectoryEntrySchema)
    .max(DESKTOP_CONFIG_LIMITS.maxDirectoryEntries),
})

export const desktopConfigDirectoryEntryResultSchema = z.object({
  entry: desktopConfigDirectoryEntrySchema.nullable(),
})

export const desktopConfigDirectoryWriteSchema = z
  .object({
    manifest: manifestSchema,
    text: textSchema,
  })
  .strict()

export const desktopConfigDirectoryWriteResultSchema = z.object({
  id: slugIdSchema,
})

export const desktopConfigRemoveResultSchema = z.object({
  removed: z.boolean(),
})

/** The slug a skill or subagent folder written through the API must have. */
export const desktopConfigEntryIdSchema = slugIdSchema

export type DesktopConfigMcpDocument = Omit<
  z.infer<typeof desktopConfigMcpDocumentSchema>,
  "entries"
> & { entries: RuntimeMcpServerRecord[] }
export type DesktopConfigHooksDocument = Omit<
  z.infer<typeof desktopConfigHooksDocumentSchema>,
  "entries"
> & { entries: RuntimeHookRecord[] }
export type DesktopConfigRules = z.infer<typeof desktopConfigRulesSchema>
export type DesktopConfigDirectoryEntry = z.infer<
  typeof desktopConfigDirectoryEntrySchema
>

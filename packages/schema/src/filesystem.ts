import { z } from "zod"

const MAX_PATH_LEN = 2048
const MAX_QUERY_LEN = 256
const SEARCH_ABSOLUTE_MAX = 5000

export const filesystemListSchema = z.object({
  path: z.string().min(1).max(MAX_PATH_LEN),
  showHidden: z.boolean().default(false),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
})
export type FilesystemListBody = z.infer<typeof filesystemListSchema>

export const filesystemSearchSchema = z.object({
  root: z.string().min(1).max(MAX_PATH_LEN),
  query: z.string().max(MAX_QUERY_LEN).default(""),
  limit: z.number().int().positive().max(SEARCH_ABSOLUTE_MAX).optional(),
})
export type FilesystemSearchBody = z.infer<typeof filesystemSearchSchema>

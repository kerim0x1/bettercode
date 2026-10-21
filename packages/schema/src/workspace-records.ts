import { z } from "zod"

/**
 * What the `/workspace/*` read routes answer. The backend validates its
 * responses with these schemas (`handleHttpContract`) and the renderer reads
 * them through `invokeContract`, so the two sides share one definition
 * instead of a hand-copied interface each.
 *
 * Every object is `passthrough`: a newer backend may add a field, and an
 * older client must keep it rather than fail or drop it. The interfaces are
 * the named types callers use; each schema is checked against its interface
 * when this package compiles, so the two cannot drift.
 */

const text = z.string()
const num = z.number()
const bool = z.boolean()
const textList = z.array(text)
const stringRecord = z.record(text, text)

/** A schema whose parsed value and accepted input are both `T`. */
type RecordSchema<T> = z.ZodType<T, T>

// ── Search ──────────────────────────────────────────────────────────────

/** One row of `/workspace/search`: project-relative, forward-slash `path`. */
export interface WorkspaceSearchEntry {
  path: string
  name: string
  is_dir: boolean
}

/** Why the backend stopped an entry walk early (`services/workspace/search`). */
export type WorkspaceSearchEntriesTruncationReason =
  | "results"
  | "visited"
  | "deadline"

export interface WorkspaceSearchEntriesResult {
  entries: WorkspaceSearchEntry[]
  /** True when a cap stopped the walk; `entries` is then incomplete. */
  truncated: boolean
  truncatedReason?: WorkspaceSearchEntriesTruncationReason
}

export const workspaceSearchEntrySchema: RecordSchema<WorkspaceSearchEntry> = z
  .object({ path: text, name: text, is_dir: bool })
  .passthrough()

export const workspaceSearchEntriesResultSchema: RecordSchema<WorkspaceSearchEntriesResult> =
  z
    .object({
      entries: z.array(workspaceSearchEntrySchema),
      truncated: bool,
      truncatedReason: z.enum(["results", "visited", "deadline"]).optional(),
    })
    .passthrough()

export interface WorkspaceQuickOpenFile {
  path: string
  name: string
}

export const workspaceQuickOpenFileSchema: RecordSchema<WorkspaceQuickOpenFile> =
  z.object({ path: text, name: text }).passthrough()

// ── Workspace map ───────────────────────────────────────────────────────

export type WorkspaceMapFileKind = "source" | "config" | "docs" | "data"

export interface WorkspaceMapFile {
  path: string
  name: string
  directory: string
  extension: string
  sizeBytes: number
  kind: WorkspaceMapFileKind
}

export interface WorkspaceMapDirectory {
  path: string
  name: string
  fileCount: number
  codeFileCount: number
  totalBytes: number
}

export interface WorkspaceMapExtension {
  extension: string
  label: string
  fileCount: number
  codeFileCount: number
  totalBytes: number
}

export interface WorkspaceMapOverview {
  rootName: string
  totalFiles: number
  scannedFiles: number
  codeFiles: number
  totalBytes: number
  truncated: boolean
  files: WorkspaceMapFile[]
  topDirectories: WorkspaceMapDirectory[]
  extensions: WorkspaceMapExtension[]
  importantFiles: WorkspaceMapFile[]
  largestFiles: WorkspaceMapFile[]
}

const workspaceMapFileSchema: RecordSchema<WorkspaceMapFile> = z
  .object({
    path: text,
    name: text,
    directory: text,
    extension: text,
    sizeBytes: num,
    kind: z.enum(["source", "config", "docs", "data"]),
  })
  .passthrough()

const workspaceMapDirectorySchema: RecordSchema<WorkspaceMapDirectory> = z
  .object({
    path: text,
    name: text,
    fileCount: num,
    codeFileCount: num,
    totalBytes: num,
  })
  .passthrough()

const workspaceMapExtensionSchema: RecordSchema<WorkspaceMapExtension> = z
  .object({
    extension: text,
    label: text,
    fileCount: num,
    codeFileCount: num,
    totalBytes: num,
  })
  .passthrough()

export const workspaceMapOverviewSchema: RecordSchema<WorkspaceMapOverview> = z
  .object({
    rootName: text,
    totalFiles: num,
    scannedFiles: num,
    codeFiles: num,
    totalBytes: num,
    truncated: bool,
    files: z.array(workspaceMapFileSchema),
    topDirectories: z.array(workspaceMapDirectorySchema),
    extensions: z.array(workspaceMapExtensionSchema),
    importantFiles: z.array(workspaceMapFileSchema),
    largestFiles: z.array(workspaceMapFileSchema),
  })
  .passthrough()

// ── Project configuration (commands, agents, skills, …) ─────────────────

export interface WorkspaceProjectCommand {
  name: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
  sourcePath: string
  template: string
}

export const workspaceProjectCommandSchema: RecordSchema<WorkspaceProjectCommand> =
  z
    .object({
      name: text,
      description: text.optional(),
      agent: text.optional(),
      model: text.optional(),
      subtask: bool.optional(),
      sourcePath: text,
      template: text,
    })
    .passthrough()

export interface WorkspaceProjectPermissionRule {
  permission: string
  pattern: string
  action: "ask" | "allow" | "deny"
  sourcePath: string
}

export const workspaceProjectPermissionRuleSchema: RecordSchema<WorkspaceProjectPermissionRule> =
  z
    .object({
      permission: text,
      pattern: text,
      action: z.enum(["ask", "allow", "deny"]),
      sourcePath: text,
    })
    .passthrough()

export interface WorkspaceProjectAgent {
  id: string
  name: string
  description?: string
  enabled: boolean
  hidden?: boolean
  mode?: string
  model?: string
  variant?: string
  temperature?: number
  topP?: number
  color?: string
  steps?: number
  tools: Record<string, boolean>
  optionKeys: string[]
  permissions: WorkspaceProjectPermissionRule[]
  sourcePath: string
  prompt: string
}

export const workspaceProjectAgentSchema: RecordSchema<WorkspaceProjectAgent> =
  z
    .object({
      id: text,
      name: text,
      description: text.optional(),
      enabled: bool,
      hidden: bool.optional(),
      mode: text.optional(),
      model: text.optional(),
      variant: text.optional(),
      temperature: num.optional(),
      topP: num.optional(),
      color: text.optional(),
      steps: num.optional(),
      tools: z.record(text, bool),
      optionKeys: textList,
      permissions: z.array(workspaceProjectPermissionRuleSchema),
      sourcePath: text,
      prompt: text,
    })
    .passthrough()

export interface WorkspaceProjectSkill {
  id: string
  name: string
  description?: string
  sourcePath: string
  sourceUrl?: string
  content: string
}

export const workspaceProjectSkillSchema: RecordSchema<WorkspaceProjectSkill> =
  z
    .object({
      id: text,
      name: text,
      description: text.optional(),
      sourcePath: text,
      sourceUrl: text.optional(),
      content: text,
    })
    .passthrough()

/**
 * An MCP server a project configuration declares (`opencode.json`-style
 * `mcp` entries, merged with the user's global config). A paired device gets
 * the names only: command, arguments, environment and source are blanked.
 */
export interface WorkspaceProjectMcpServer {
  id: string
  name: string
  type: "local" | "remote"
  command: string
  args: string[]
  env: Record<string, string>
  envKeys?: string[]
  headerKeys?: string[]
  enabled: boolean
  sourcePath: string
  url?: string | null
  timeoutMs?: number
  oauth?: "auto" | "disabled" | "configured"
  oauthKeys?: string[]
  authStatus?: "authenticated" | "expired" | "not_authenticated"
  authStorageKeys?: string[]
  authSourcePath?: string
  authServerUrl?: string | null
  /** True when the opened repository (not the user's own config) declared it. */
  workspaceControlled?: boolean
}

export const workspaceProjectMcpServerSchema: RecordSchema<WorkspaceProjectMcpServer> =
  z
    .object({
      id: text,
      name: text,
      type: z.enum(["local", "remote"]),
      command: text,
      args: textList,
      env: stringRecord,
      envKeys: textList.optional(),
      headerKeys: textList.optional(),
      enabled: bool,
      sourcePath: text,
      url: text.nullable().optional(),
      timeoutMs: num.optional(),
      oauth: z.enum(["auto", "disabled", "configured"]).optional(),
      oauthKeys: textList.optional(),
      authStatus: z
        .enum(["authenticated", "expired", "not_authenticated"])
        .optional(),
      authStorageKeys: textList.optional(),
      authSourcePath: text.optional(),
      authServerUrl: text.nullable().optional(),
      workspaceControlled: bool.optional(),
    })
    .passthrough()

export interface WorkspaceProjectInstruction {
  sourcePath: string
  content: string
}

export const workspaceProjectInstructionSchema: RecordSchema<WorkspaceProjectInstruction> =
  z.object({ sourcePath: text, content: text }).passthrough()

export interface WorkspaceProjectReference {
  id: string
  name: string
  kind: "local" | "git" | "invalid"
  sourcePath: string
  path?: string
  relativePath?: string
  repository?: string
  branch?: string
  exists?: boolean
  message?: string
}

export const workspaceProjectReferenceSchema: RecordSchema<WorkspaceProjectReference> =
  z
    .object({
      id: text,
      name: text,
      kind: z.enum(["local", "git", "invalid"]),
      sourcePath: text,
      path: text.optional(),
      relativePath: text.optional(),
      repository: text.optional(),
      branch: text.optional(),
      exists: bool.optional(),
      message: text.optional(),
    })
    .passthrough()

export interface WorkspaceProjectFormatter {
  id: string
  name: string
  enabled: boolean
  available?: boolean
  sourcePath: string
  command: string
  args: string[]
  env: Record<string, string>
  extensions: string[]
  builtin: boolean
  /** True when the opened repository (not the user's own config) declared it. */
  workspaceControlled?: boolean
}

export const workspaceProjectFormatterSchema: RecordSchema<WorkspaceProjectFormatter> =
  z
    .object({
      id: text,
      name: text,
      enabled: bool,
      available: bool.optional(),
      sourcePath: text,
      command: text,
      args: textList,
      env: stringRecord,
      extensions: textList,
      builtin: bool,
      workspaceControlled: bool.optional(),
    })
    .passthrough()

export interface WorkspaceProjectFormatRun {
  id: string
  name: string
  sourcePath: string
  command: string
  args: string[]
  success: boolean
  exitCode: number | null
  signal?: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  skippedReason?: string
}

export interface WorkspaceProjectFormatResult {
  file: string
  formatted: boolean
  results: WorkspaceProjectFormatRun[]
  skippedReason?: string
}

const workspaceProjectFormatRunSchema: RecordSchema<WorkspaceProjectFormatRun> =
  z
    .object({
      id: text,
      name: text,
      sourcePath: text,
      command: text,
      args: textList,
      success: bool,
      exitCode: num.nullable(),
      signal: text.nullable().optional(),
      stdout: text,
      stderr: text,
      timedOut: bool,
      skippedReason: text.optional(),
    })
    .passthrough()

export const workspaceProjectFormatResultSchema: RecordSchema<WorkspaceProjectFormatResult> =
  z
    .object({
      file: text,
      formatted: bool,
      results: z.array(workspaceProjectFormatRunSchema),
      skippedReason: text.optional(),
    })
    .passthrough()

export interface WorkspaceProjectLspServer {
  id: string
  name: string
  enabled: boolean
  sourcePath: string
  command: string
  args: string[]
  env: Record<string, string>
  extensions: string[]
  initialization: Record<string, unknown>
  builtin: boolean
}

export const workspaceProjectLspServerSchema: RecordSchema<WorkspaceProjectLspServer> =
  z
    .object({
      id: text,
      name: text,
      enabled: bool,
      sourcePath: text,
      command: text,
      args: textList,
      env: stringRecord,
      extensions: textList,
      initialization: z.record(text, z.unknown()),
      builtin: bool,
    })
    .passthrough()

export interface WorkspaceProjectConfigSetting {
  key: string
  label: string
  kind: "scalar" | "toggle" | "list" | "object"
  value: string
  sourcePath: string
}

export const workspaceProjectConfigSettingSchema: RecordSchema<WorkspaceProjectConfigSetting> =
  z
    .object({
      key: text,
      label: text,
      kind: z.enum(["scalar", "toggle", "list", "object"]),
      value: text,
      sourcePath: text,
    })
    .passthrough()

export interface WorkspaceProjectProviderModel {
  id: string
  name?: string
  family?: string
  releaseDate?: string
  sourcePath: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  toolCall?: boolean
  interleaved?: boolean
  interleavedField?: string
  experimental?: boolean
  status?: string
  contextLimit?: number
  inputLimit?: number
  outputLimit?: number
  inputModalities?: string[]
  outputModalities?: string[]
  cost?: Record<string, number>
  contextOver200kCost?: Record<string, number>
  providerApi?: string
  providerNpm?: string
  optionKeys: string[]
  headerKeys: string[]
  variants: string[]
  disabledVariants: string[]
}

export interface WorkspaceProjectProvider {
  id: string
  name?: string
  sourcePath: string
  api?: string
  npm?: string
  env: string[]
  whitelist: string[]
  blacklist: string[]
  optionKeys: string[]
  hasApiKey: boolean
  baseURL?: string
  enterpriseUrl?: string
  setCacheKey?: boolean
  timeout?: number | false
  chunkTimeout?: number
  models: WorkspaceProjectProviderModel[]
}

export interface WorkspaceProjectProviderAuth {
  serviceId: string
  sourcePath: string
  accountCount: number
  credentialTypes: string[]
  activeAccountId?: string
  activeDescription?: string
  activeCredentialType?: string
  activeExpiresAt?: number
  activeExpired?: boolean
  metadataKeys?: string[]
}

export interface WorkspaceProjectProvidersSummary {
  defaultModel?: string
  smallModel?: string
  enabledProviders: string[]
  disabledProviders: string[]
  providers: WorkspaceProjectProvider[]
  authAccounts: WorkspaceProjectProviderAuth[]
}

const numberRecord = z.record(text, num)

const workspaceProjectProviderModelSchema: RecordSchema<WorkspaceProjectProviderModel> =
  z
    .object({
      id: text,
      name: text.optional(),
      family: text.optional(),
      releaseDate: text.optional(),
      sourcePath: text,
      attachment: bool.optional(),
      reasoning: bool.optional(),
      temperature: bool.optional(),
      toolCall: bool.optional(),
      interleaved: bool.optional(),
      interleavedField: text.optional(),
      experimental: bool.optional(),
      status: text.optional(),
      contextLimit: num.optional(),
      inputLimit: num.optional(),
      outputLimit: num.optional(),
      inputModalities: textList.optional(),
      outputModalities: textList.optional(),
      cost: numberRecord.optional(),
      contextOver200kCost: numberRecord.optional(),
      providerApi: text.optional(),
      providerNpm: text.optional(),
      optionKeys: textList,
      headerKeys: textList,
      variants: textList,
      disabledVariants: textList,
    })
    .passthrough()

const workspaceProjectProviderSchema: RecordSchema<WorkspaceProjectProvider> = z
  .object({
    id: text,
    name: text.optional(),
    sourcePath: text,
    api: text.optional(),
    npm: text.optional(),
    env: textList,
    whitelist: textList,
    blacklist: textList,
    optionKeys: textList,
    hasApiKey: bool,
    baseURL: text.optional(),
    enterpriseUrl: text.optional(),
    setCacheKey: bool.optional(),
    timeout: z.union([num, z.literal(false)]).optional(),
    chunkTimeout: num.optional(),
    models: z.array(workspaceProjectProviderModelSchema),
  })
  .passthrough()

const workspaceProjectProviderAuthSchema: RecordSchema<WorkspaceProjectProviderAuth> =
  z
    .object({
      serviceId: text,
      sourcePath: text,
      accountCount: num,
      credentialTypes: textList,
      activeAccountId: text.optional(),
      activeDescription: text.optional(),
      activeCredentialType: text.optional(),
      activeExpiresAt: num.optional(),
      activeExpired: bool.optional(),
      metadataKeys: textList.optional(),
    })
    .passthrough()

export const workspaceProjectProvidersSummarySchema: RecordSchema<WorkspaceProjectProvidersSummary> =
  z
    .object({
      defaultModel: text.optional(),
      smallModel: text.optional(),
      enabledProviders: textList,
      disabledProviders: textList,
      providers: z.array(workspaceProjectProviderSchema),
      authAccounts: z.array(workspaceProjectProviderAuthSchema),
    })
    .passthrough()

export interface WorkspaceProjectPlugin {
  id: string
  spec: string
  kind: "npm" | "file" | "url" | "invalid"
  sourcePath: string
  optionsKeys: string[]
  path?: string
  relativePath?: string
  exists?: boolean
  message?: string
  skipped?: boolean
  skippedReason?: string
  metaSourcePath?: string
  metaSource?: "file" | "npm"
  metaTarget?: string
  metaRequested?: string
  metaVersion?: string
  metaLoadCount?: number
  metaLastTime?: number
  metaTimeChanged?: number
  metaThemes?: string[]
}

export const workspaceProjectPluginSchema: RecordSchema<WorkspaceProjectPlugin> =
  z
    .object({
      id: text,
      spec: text,
      kind: z.enum(["npm", "file", "url", "invalid"]),
      sourcePath: text,
      optionsKeys: textList,
      path: text.optional(),
      relativePath: text.optional(),
      exists: bool.optional(),
      message: text.optional(),
      skipped: bool.optional(),
      skippedReason: text.optional(),
      metaSourcePath: text.optional(),
      metaSource: z.enum(["file", "npm"]).optional(),
      metaTarget: text.optional(),
      metaRequested: text.optional(),
      metaVersion: text.optional(),
      metaLoadCount: num.optional(),
      metaLastTime: num.optional(),
      metaTimeChanged: num.optional(),
      metaThemes: textList.optional(),
    })
    .passthrough()

export interface WorkspaceProjectToolFlag {
  tool: string
  enabled: boolean
  sourcePath: string
  kind?: "flag" | "custom"
  exportName?: string
}

export const workspaceProjectToolFlagSchema: RecordSchema<WorkspaceProjectToolFlag> =
  z
    .object({
      tool: text,
      enabled: bool,
      sourcePath: text,
      kind: z.enum(["flag", "custom"]).optional(),
      exportName: text.optional(),
    })
    .passthrough()

// ── Files ───────────────────────────────────────────────────────────────

/**
 * A file read as text. `sha256` covers the exact bytes read, so an editor
 * can send it back as `expectedSha256` and never overwrite a newer change;
 * `isUtf8` is false when decoding lost bytes. Desktops older than the
 * `workspace.write.ifMatch` feature send only `content` and `path`.
 */
export interface WorkspaceFileContent {
  content: string
  path: string
  sha256?: string
  size?: number
  isUtf8?: boolean
}

export const workspaceFileContentSchema: RecordSchema<WorkspaceFileContent> = z
  .object({
    content: text,
    path: text,
    sha256: text.optional(),
    size: num.optional(),
    isUtf8: bool.optional(),
  })
  .passthrough()

export interface WorkspaceBinaryFile {
  base64: string
  path: string
  size: number
}

export const workspaceBinaryFileSchema: RecordSchema<WorkspaceBinaryFile> = z
  .object({ base64: text, path: text, size: num })
  .passthrough()

/** A workspace folder the backend registered: its canonical path. */
export interface WorkspaceOpenResult {
  path: string
}

export const workspaceOpenResultSchema: RecordSchema<WorkspaceOpenResult> = z
  .object({ path: text })
  .passthrough()

/**
 * A scratch workspace copied into a repository. Files already present in
 * the destination are listed in `skipped`, never overwritten; `truncated`
 * when a cap cut the copy short.
 */
export interface WorkspaceScratchAdoptResult {
  copied: number
  skipped: string[]
  truncated?: boolean
}

export const workspaceScratchAdoptResultSchema: RecordSchema<WorkspaceScratchAdoptResult> =
  z
    .object({ copied: num, skipped: textList, truncated: bool.optional() })
    .passthrough()

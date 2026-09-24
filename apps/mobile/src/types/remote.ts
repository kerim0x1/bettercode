import type {
  ChatMessage,
  ChatThread,
  PermissionUpdate,
  ThreadActivity,
  ProviderInstanceSnapshot,
} from "@betterc0de/schema"
import type {
  RemoteAccessLevel,
  RemoteProtocol,
} from "@betterc0de/schema/remote-protocol"

export type { ChatMessage, ChatThread, ThreadActivity }
export type { RemoteAccessLevel, RemoteProtocol }

export interface RemoteSessionSummary {
  id: string
  label: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  /**
   * `read_only` for sessions paired over public plain HTTP. Profiles stored
   * before the field existed read as `full`, which is what they were.
   */
  accessLevel?: RemoteAccessLevel
}

export interface ConnectionProfile {
  baseUrl: string
  environmentId: string
  sessionToken: string
  session: RemoteSessionSummary
  pairedAt: string
}

export interface RemoteBootstrap {
  enabled: boolean
  authenticated: boolean
  authentication: "local" | "remote" | null
  environmentId: string | null
  session: RemoteSessionSummary | null
  /** `null` from desktops that predate protocol negotiation. */
  protocol: RemoteProtocol | null
}

export interface RemotePairResponse {
  enabled: true
  authenticated: true
  authentication: "remote"
  environmentId: string
  tokenType: "Bearer"
  sessionToken: string
  session: RemoteSessionSummary
  protocol: RemoteProtocol | null
}

export interface RemoteStatus {
  enabled: boolean
  listeningOnNetwork: boolean
  environmentId: string
  host: string
  port: number
  authentication: "local" | "remote" | null
  currentSessionId: string | null
  endpoints: Array<{
    id: string
    label: string
    httpBaseUrl: string
    wsBaseUrl: string
    reachability: string
    hostedHttpsCompatible: boolean
    isDefault: boolean
  }>
}

export interface ProjectSummary {
  id?: string
  name: string
  path: string
  createdAt?: string
  updatedAt?: string
}

export type ProviderModel = Pick<
  ProviderInstanceSnapshot["models"][number],
  "slug" | "name" | "shortName"
> &
  Partial<
    Pick<
      ProviderInstanceSnapshot["models"][number],
      "isCustom" | "capabilities"
    >
  >

export interface ProviderInstance extends Pick<
  ProviderInstanceSnapshot,
  | "instanceId"
  | "driver"
  | "displayName"
  | "enabled"
  | "configured"
  | "installed"
  | "status"
  | "availability"
> {
  models: ProviderModel[]
}

export interface ModelOption {
  key: string
  providerKind: string
  providerInstanceId: string | null
  providerLabel: string
  modelId: string
  modelLabel: string
  capabilities: NonNullable<ProviderModel["capabilities"]> | null
}

export interface DirectoryEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number | null
  mtime: number | null
}

export interface DirectoryResult {
  path: string
  parent: string | null
  entries: DirectoryEntry[]
  truncated: boolean
}

export interface FileSearchResult {
  entries: Array<{
    path: string
    name: string
    isDir: boolean
    score: number
  }>
  truncated: boolean
  tookMs: number
}

export interface ThreadDiffs {
  turnDiffs: Array<{
    threadId: string
    turnIndex: number
    diffText: string
    filesChanged: number
    insertions: number
    deletions: number
    createdAt: string
  }>
  checkpointDiffs: Array<{
    id: string
    threadId: string
    turnId: string
    checkpointRef: string
    diffContent: string
    createdAt: string
  }>
}

export type PendingRequestKind = "approval" | "plan" | "user-input"

export interface PendingRequest {
  id: string
  threadId: string
  kind: PendingRequestKind
  providerKind: string
  providerInstanceId: string | null
  title: string
  detail?: string
  input?: unknown
  /** The tool a tool approval is for, which "Always allow" scopes its rule to. */
  toolName?: string
  /** The provider's own "Always allow" suggestion, validated. */
  suggestions?: PermissionUpdate[]
  questions?: Array<{
    id: string
    header?: string
    question: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

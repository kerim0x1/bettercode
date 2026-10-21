import type {
  ChatMessage,
  ChatThread,
  FilesystemListEntry,
  FilesystemListResult,
  FilesystemSearchResult,
  PermissionUpdate,
  ThreadActivity,
  ProviderInstanceSnapshot,
} from "@betterc0de/schema"
import type { ProjectSummary } from "@betterc0de/schema/http-contracts"
import type {
  RemoteAccessLevel,
  RemoteBootstrapResponse,
  RemoteMobilePairResponse,
  RemoteProtocol,
  RemoteSession,
  RemoteStatus,
} from "@betterc0de/schema/remote-protocol"

export type { ChatMessage, ChatThread, ThreadActivity }
export type { RemoteAccessLevel, RemoteProtocol, RemoteStatus }

/**
 * The part of the desktop's session record (`RemoteSession`) this app keeps.
 * `accessLevel` is `read_only` for sessions paired over plain HTTP (a local
 * network, or a public address the desktop allows), which last one hour.
 * Profiles stored before the field existed read as `full`, which is what
 * they were.
 */
export type RemoteSessionSummary = Pick<
  RemoteSession,
  "id" | "label" | "createdAt" | "lastSeenAt" | "expiresAt" | "accessLevel"
>

export interface ConnectionProfile {
  baseUrl: string
  environmentId: string
  sessionToken: string
  session: RemoteSessionSummary
  pairedAt: string
}

/** `/remote/bootstrap` as `parseRemoteBootstrap` reads it. */
export interface RemoteBootstrap extends Omit<
  RemoteBootstrapResponse,
  "session" | "protocol"
> {
  session: RemoteSessionSummary | null
  /** `null` from desktops that predate protocol negotiation. */
  protocol: RemoteProtocol | null
}

/** `/remote/mobile/pair` as `parseRemotePairResponse` reads it. */
export interface RemotePairResponse extends Omit<
  RemoteMobilePairResponse,
  "session" | "protocol"
> {
  session: RemoteSessionSummary
  protocol: RemoteProtocol | null
}

/** A project on the desktop (`/projects`). */
export type { ProjectSummary }

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

/** One child of a folder on the desktop (`/filesystem/list`). */
export type DirectoryEntry = FilesystemListEntry

/** A folder on the desktop and its children (`/filesystem/list`). */
export type DirectoryResult = FilesystemListResult

/** Name matches below a folder on the desktop (`/filesystem/search`). */
export type FileSearchResult = FilesystemSearchResult

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
  /** The tool a tool approval is for, which "Allow for this session" scopes its rule to. */
  toolName?: string
  /** The provider's own "always allow" suggestion, validated. */
  suggestions?: PermissionUpdate[]
  questions?: Array<{
    id: string
    header?: string
    question: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

// Window augmentations live in src/types/electron-api.d.ts

export type RuntimeConfig = {
  port: number
  mode: string
  baseUrl?: string
  electronPath?: string
  previewPartition?: string
}

export type BackendMode = "local_sidecar" | "remote_http"

export type RequestOptions = {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  // Milliseconds before the request is aborted locally. 0 or undefined keeps
  // the transport's default (60s for sidecar calls). Long-running streams
  // should either pass a larger value or a signal that never auto-aborts.
  timeoutMs?: number
  // Status codes the caller treats as "expected absence" — the transport will
  // still throw an HttpError so try/catch logic works, but it skips the
  // automatic `console.error([backend] …)` log. Used by soft-probe callers
  // (e.g. @-mention file resolution, project-rules detection) that fan out
  // optimistic readFile() calls and don't want a wall of 404 noise in
  // DevTools when the target file simply doesn't exist.
  silentStatuses?: number[]
}

export interface BackendTransport {
  request<T>(path: string, opts?: RequestOptions): Promise<T>
}

// The shell and terminal read models are the shared contracts' own
// (`@betterc0de/schema/http-contracts`, `shell-contracts.ts`).
export type {
  ShellCommandResult,
  TerminalPtyEvent,
  TerminalPtySnapshot,
} from "@betterc0de/schema/http-contracts"

export type WsEventHandler = (event: { channel: string; data: unknown }) => void

import path from "node:path"

/**
 * Cursor-specific ACP launch settings. The protocol-generic config-option
 * helpers every ACP agent shares live in `../acp/AcpSessionConfig`.
 */

export interface CursorAcpRuntimeSettings {
  readonly binaryPath?: string | null
  readonly apiEndpoint?: string | null
}

export interface CursorAcpSpawnInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
}

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv
): CursorAcpSpawnInput {
  const command = cursorSettings?.binaryPath?.trim() ?? ""
  if (!path.isAbsolute(command)) {
    throw new Error("Cursor Agent CLI path must be an absolute file path.")
  }
  return {
    command,
    args: [
      ...(cursorSettings?.apiEndpoint
        ? ["-e", cursorSettings.apiEndpoint]
        : []),
      "acp",
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  }
}

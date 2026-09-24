import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import type { RemoteClientInfo } from "@betterc0de/schema/remote-protocol"
import { vi } from "vitest"
import { createLiveApi, pairMobile } from "@/transport/live/api"

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const BACKEND_ENTRY = path.join(REPO, "apps", "backend", "dist", "inProcess.js")

/** The release the app belongs to, as the desktop sees it in the client header. */
export const RELEASE_VERSION = (
  JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as {
    version: string
  }
).version

export const CLIENT: RemoteClientInfo = {
  name: "betterc0de-remote",
  version: RELEASE_VERSION,
  platform: "android",
}

interface StartedBackend {
  readonly port: number
  readonly token: string
  stop(): Promise<void>
}

export interface TestDesktop {
  readonly baseUrl: string
  /** A project folder the desktop knows, for file access. Starts empty. */
  readonly workspace: string
  /** A request from the desktop app itself (the owner's process bearer). */
  asDesktop<T = unknown>(
    method: string,
    route: string,
    body?: unknown
  ): Promise<T>
  setSettings(patch: Record<string, unknown>): Promise<void>
  pairingCode(): Promise<string>
  /** Pairs a phone. The desktop allows 8 pairing attempts per client in a burst. */
  pairPhone(client?: RemoteClientInfo): Promise<{
    paired: Awaited<ReturnType<typeof pairMobile>>
    api: ReturnType<typeof createLiveApi>
  }>
  /** A chat in the workspace, created the way the desktop creates one. */
  saveThread(id: string, updatedAt: string): Promise<void>
  stop(): Promise<void>
}

/**
 * The desktop backend, started in this process from its build output with
 * Remote Access on. Its data, home directory and workspace live in a
 * temporary directory; nothing reaches a real installation on this machine.
 */
export async function startTestDesktop(): Promise<TestDesktop> {
  if (!fs.existsSync(BACKEND_ENTRY)) {
    throw new Error(
      `${path.relative(REPO, BACKEND_ENTRY)} is missing. Build it first: npm run build:backend`
    )
  }
  // The desktop answers with canonical paths, as its folder picker records
  // them, and the tests compare against those. The temporary folder often
  // is not canonical: macOS keeps it behind a symlink (/var → /private/var),
  // and Windows runners name it with 8.3 short names (C:\Users\RUNNER~1).
  // Only the native realpath resolves both.
  const tempRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-mobile-e2e-"))
  )
  const home = path.join(tempRoot, "home")
  const workspace = path.join(tempRoot, "workspace")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  vi.spyOn(os, "homedir").mockReturnValue(home)
  vi.stubEnv("HOME", home)
  vi.stubEnv("USERPROFILE", home)
  vi.stubEnv("APPDATA", path.join(home, "AppData", "Roaming"))
  vi.stubEnv("BETTERC0DE_HOME", home)
  vi.stubEnv("BETTERC0DE_PROVIDER_SESSION_REAPER", "0")
  vi.stubEnv("BETTERC0DE_WEB_ROOT", "")

  // Loaded by Node itself: the backend is CommonJS with native modules.
  const backend = createRequire(import.meta.url)(BACKEND_ENTRY) as {
    startNodeBackend(options: {
      dataDir: string
      preferredPort: number
    }): Promise<StartedBackend>
  }
  let started: StartedBackend
  try {
    started = await backend.startNodeBackend({
      dataDir: path.join(tempRoot, "data"),
      preferredPort: 0,
    })
  } catch (error) {
    cleanUp(tempRoot)
    throw error
  }
  const baseUrl = `http://127.0.0.1:${started.port}`

  const asDesktop = async <T>(
    method: string,
    route: string,
    body?: unknown
  ): Promise<T> => {
    const response = await fetch(`${baseUrl}/api/v1${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${started.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`${method} ${route}: HTTP ${response.status} ${text}`)
    return (text ? JSON.parse(text) : null) as T
  }
  const pairingCode = async () =>
    (
      await asDesktop<{ credential: string }>("POST", "/remote/pairing-links", {
        label: "End-to-end phone",
      })
    ).credential

  const desktop: TestDesktop = {
    baseUrl,
    workspace,
    asDesktop,
    setSettings: async (patch) => {
      await asDesktop("PATCH", "/settings", { patch })
    },
    pairingCode,
    pairPhone: async (client = CLIENT) => {
      const paired = await pairMobile(
        baseUrl,
        await pairingCode(),
        "End-to-end phone",
        client
      )
      return {
        paired,
        api: createLiveApi({ baseUrl, token: paired.sessionToken, client }),
      }
    },
    saveThread: async (id, updatedAt) => {
      await asDesktop("PATCH", `/threads/${id}`, {
        title: `Chat ${id}`,
        projectName: path.basename(workspace),
        projectPath: workspace,
        createdAt: updatedAt,
        updatedAt,
      })
    },
    stop: async () => {
      try {
        await started.stop()
      } finally {
        cleanUp(tempRoot)
      }
    },
  }
  await desktop.setSettings({ remote_access_enabled: true })
  return desktop
}

function cleanUp(tempRoot: string) {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  // Retries: on Windows a shell that just ended can hold its folder a moment.
  fs.rmSync(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  })
}

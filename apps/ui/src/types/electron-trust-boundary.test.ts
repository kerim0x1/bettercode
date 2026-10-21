/// <reference types="node" />

import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

const requireCjs = createRequire(import.meta.url)
const { buildRuntimeConfig } = requireCjs(
  "../../../shell/shared/runtimeConfig.cjs"
) as {
  buildRuntimeConfig: (
    config: Record<string, unknown>
  ) => Record<string, unknown>
}
const {
  assertTrustedIpcSender,
  forcePreviewPartition,
  isAllowedWebviewUrl,
  isTrustedRendererRequest,
  isTrustedRendererUrl,
} = requireCjs("../../../shell/shared/urlPolicy.cjs") as {
  assertTrustedIpcSender: (
    event: Record<string, unknown>,
    channel: string,
    policy: Record<string, unknown>
  ) => void
  forcePreviewPartition: (
    webPreferences: Record<string, unknown>,
    params: Record<string, unknown>,
    partition: string
  ) => void
  isAllowedWebviewUrl: (url: string) => boolean
  isTrustedRendererRequest: (
    details: Record<string, unknown>,
    policy: Record<string, unknown>
  ) => boolean
  isTrustedRendererUrl: (
    url: string,
    policy: Record<string, unknown>
  ) => boolean
}

describe("Electron renderer trust boundary", () => {
  it("allows issued HTML preview URL shapes without allowing raw local files", () => {
    expect(
      isAllowedWebviewUrl(
        "betterc0de-html://28c28eaf-00a7-45c8-91c2-75957ab2ed68/pages/index.html"
      )
    ).toBe(true)
    expect(isAllowedWebviewUrl("betterc0de-html://arbitrary/path.html")).toBe(
      false
    )
    expect(isAllowedWebviewUrl("file:///C:/private/index.html")).toBe(false)
    expect(isAllowedWebviewUrl("javascript:alert(1)")).toBe(false)
    expect(isAllowedWebviewUrl("http://localhost:3000")).toBe(true)
  })
  // The main process must not expose a provider bridge that takes its
  // permission decision from its caller. `claude:send` did exactly that —
  // `permissionLevel: "bypass"` from the renderer produced unattended
  // Bash/Write/Edit at an arbitrary `projectPath` — so the whole bridge was
  // removed. This guards the removal: provider turns belong to the
  // authenticated backend, which owns the policy.
  it("exposes no main-process provider bridge to the renderer", () => {
    const shellDir = path.resolve(import.meta.dirname, "../../../shell")
    expect(fs.existsSync(path.join(shellDir, "claude-provider.cjs"))).toBe(
      false
    )
    expect(fs.existsSync(path.join(shellDir, "claude-ipc.cjs"))).toBe(false)

    const preload = fs.readFileSync(path.join(shellDir, "preload.cjs"), "utf8")
    // Channel strings, not prose — the file documents why the bridge is gone.
    expect(preload).not.toMatch(/ipcRenderer\.\w+\(\s*"claude:/)
    expect(preload).not.toMatch(/^\s*claudeSend:/m)
  })

  it("mints shell capabilities only through trusted desktop IPC", () => {
    const preloadSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../shell/preload.cjs"),
      "utf8"
    )
    // The app-level IPC handlers moved out of main.cjs into shared/app-ipc.cjs.
    const appIpcSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../shell/shared/app-ipc.cjs"),
      "utf8"
    )
    const workspaceApiSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../services/backend/workspaceApi.ts"),
      "utf8"
    )

    // The main process decides (approved hook command, or real input to the
    // window it observes itself); the preload no longer gates on
    // `navigator.userActivation`, which expired before automatic hooks ran.
    expect(preloadSource).not.toContain("navigator.userActivation")
    expect(preloadSource).toContain('ipcRenderer.invoke("shell:capability"')
    expect(appIpcSource).toContain(
      "isShellCapabilityAuthorized(event, scope, {"
    )
    expect(appIpcSource).toContain(
      '"X-BetterC0de-Human-Capability": serverToken'
    )
    expect(appIpcSource).toContain("/api/v1/shell/capability")
    expect(appIpcSource).not.toMatch(
      /127\.0\.0\.1:\$\{serverPort\}\/api\/shell\/capability/
    )
    expect(workspaceApiSource).toContain(
      "window.electronAPI?.requestShellCapability"
    )
    expect(workspaceApiSource).toContain("if (!isRemoteRuntime())")
    expect(workspaceApiSource).toMatch(
      /httpInvoke<[^>]+>\(\s*["']\/shell\/capability/
    )
    // A paired device asks the backend every time and, when refused, is told
    // which desktop switch grants it — it never decides locally.
    expect(workspaceApiSource).toContain("Allow terminal from remote devices")
    expect(workspaceApiSource).toContain("remoteShellCapabilityError(error)")
    // The backend half of this boundary — the header secret as the only
    // proof of a human on the desktop, the owner grant
    // (`remote_access_allow_terminal`) plus a full session for a paired
    // device, and the grant being desktop-owner-only in the settings route —
    // is no longer asserted here as source substrings. It is covered by
    // behavioural tests that live next to that code:
    // `backend/src/http/routes/shell-security.test.ts` and
    // `backend/src/http/routes/settings.test.ts`. A renderer test reading
    // backend files could only ever tell that a string exists, not that the
    // route refuses anything.
  })

  it("never exposes the backend bearer in the renderer runtime config", () => {
    const secret = "must-not-reach-renderer"
    const config = buildRuntimeConfig({
      port: 3773,
      token: secret,
      electronPath: "C:/app/apps/shell",
      previewPartition: "betterc0de-preview",
    })

    expect(JSON.stringify(config)).not.toContain(secret)
    expect(config).not.toHaveProperty("token")
    expect(config).toEqual({
      port: 3773,
      mode: "local_sidecar",
      electronPath: "C:/app/apps/shell",
      previewPartition: "betterc0de-preview",
    })
  })

  it("delivers runtime config over IPC instead of injecting page JavaScript", () => {
    const shellDir = path.resolve(import.meta.dirname, "../../../shell")
    const mainSource = fs.readFileSync(path.join(shellDir, "main.cjs"), "utf8")
    const preloadSource = fs.readFileSync(
      path.join(shellDir, "preload.cjs"),
      "utf8"
    )
    expect(mainSource).not.toContain("executeJavaScript(")
    expect(preloadSource).toContain('ipcRenderer.invoke("runtime:config")')
  })

  it("authenticates only a registered app main frame, never a preview guest", () => {
    const mainFrame = { url: "http://localhost:5173/", parent: null }
    const mainContents = { id: 41, mainFrame }
    const policy = {
      isPackaged: false,
      devRendererOrigin: "http://localhost:5173",
      trustedWebContentsIds: new Set([41]),
    }

    expect(
      isTrustedRendererRequest(
        { webContentsId: 41, webContents: mainContents, frame: mainFrame },
        policy
      )
    ).toBe(true)

    // A preview guest can request the exact backend URL, but its independent
    // webContents id is not registered and therefore never inherits auth.
    const previewFrame = { url: "http://attacker.example/", parent: null }
    expect(
      isTrustedRendererRequest(
        {
          webContentsId: 99,
          webContents: { id: 99, mainFrame: previewFrame },
          frame: previewFrame,
        },
        policy
      )
    ).toBe(false)

    expect(
      isTrustedRendererRequest(
        {
          webContentsId: 41,
          webContents: mainContents,
          frame: { url: "http://localhost:5173/embedded", parent: mainFrame },
        },
        policy
      )
    ).toBe(false)
  })

  it("overrides a preview's requested session with the isolated partition", () => {
    const webPreferences = { partition: "persist:default" }
    const params = { partition: "persist:attacker" }

    forcePreviewPartition(webPreferences, params, "betterc0de-preview")

    expect(webPreferences.partition).toBe("betterc0de-preview")
    expect(params.partition).toBe("betterc0de-preview")
  })

  it("rejects IPC from unregistered or nested renderer frames", () => {
    const mainFrame = { url: "http://localhost:5173/", parent: null }
    const sender = { id: 7, mainFrame, getURL: () => mainFrame.url }
    const policy = {
      isPackaged: false,
      devRendererOrigin: "http://localhost:5173",
      trustedWebContentsIds: new Set([7]),
    }

    expect(() =>
      assertTrustedIpcSender(
        { sender, senderFrame: mainFrame },
        "app:info",
        policy
      )
    ).not.toThrow()
    expect(() =>
      assertTrustedIpcSender(
        {
          sender,
          senderFrame: {
            url: "http://localhost:5173/embedded",
            parent: mainFrame,
          },
        },
        "app:info",
        policy
      )
    ).toThrow("Rejected IPC from untrusted sender")
  })

  it("trusts packaged files only inside the renderer distribution root", () => {
    const root = path.resolve("C:/BetterC0de/resources/app.asar/apps/ui/dist")
    const policy = {
      isPackaged: true,
      packagedRendererRoot: root,
      trustedWebContentsIds: new Set<number>(),
    }

    expect(
      isTrustedRendererUrl(
        pathToFileURL(path.join(root, "index.html")).href,
        policy
      )
    ).toBe(true)
    expect(
      isTrustedRendererUrl(
        pathToFileURL(path.resolve(root, "..", "evil.html")).href,
        policy
      )
    ).toBe(false)
  })
})

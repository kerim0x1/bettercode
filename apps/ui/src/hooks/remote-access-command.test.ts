import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/lib/settings-store"
import {
  createRemotePairingLink,
  getRemoteStatus,
  getTailscaleStatus,
  listRemoteSessions,
  setTailscaleServe,
} from "@/services/backend/remoteApi"
import { executeRemoteAccessCommand } from "@/lib/slash-command-runtime"

vi.mock("@/services/backend/remoteApi", () => ({
  createRemotePairingLink: vi.fn(),
  getRemoteStatus: vi.fn(),
  getTailscaleStatus: vi.fn(),
  listRemoteSessions: vi.fn(),
  setTailscaleServe: vi.fn(),
}))

const tailscaleServing = {
  available: true,
  installed: true,
  state: "running" as const,
  magicDnsName: "desk.tail1234.ts.net",
  tailnetIpv4Addresses: ["100.101.102.103"],
  selfAddresses: ["100.101.102.103"],
  httpsCertificates: true,
  serveEnabled: true,
  serveActive: true,
  servePort: 443,
  httpsBaseUrl: "https://desk.tail1234.ts.net",
}

const enabledStatus = {
  enabled: true,
  listeningOnNetwork: true,
  environmentId: "environment-1",
  host: "0.0.0.0",
  port: 3773,
  authentication: "local" as const,
  currentSessionId: null,
  endpoints: [
    {
      id: "network:192.168.1.50",
      label: "Wi-Fi",
      httpBaseUrl: "http://192.168.1.50:3773",
      wsBaseUrl: "ws://192.168.1.50:3773",
      reachability: "private-network" as const,
      hostedHttpsCompatible: false,
      isDefault: true,
    },
  ],
}

describe("/remote command", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("window", {
      __BETTERC0DE__: { port: 3773, mode: "electron" },
      electronAPI: {
        restartBackend: vi.fn().mockResolvedValue({ port: 3773 }),
      },
      localStorage: {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    })
    useSettingsStore.setState({
      update: vi.fn().mockResolvedValue(undefined),
    })
    vi.mocked(createRemotePairingLink).mockResolvedValue({
      id: "grant-1",
      credential: "ABCD-EFGH-JKLM",
      label: "Chat command pairing",
      createdAt: "2026-07-21T12:00:00.000Z",
      expiresAt: "2026-07-21T12:10:00.000Z",
      links: [
        {
          endpointId: "network:192.168.1.50",
          label: "Wi-Fi",
          url: "http://192.168.1.50:3773/#token=ABCD-EFGH-JKLM",
          isDefault: true,
        },
      ],
    })
    vi.mocked(listRemoteSessions).mockResolvedValue({
      currentSessionId: null,
      sessions: [],
    })
    vi.mocked(getTailscaleStatus).mockResolvedValue({
      ...tailscaleServing,
      serveEnabled: false,
      serveActive: false,
    })
    vi.mocked(setTailscaleServe).mockResolvedValue(tailscaleServing)
  })

  it("turns Tailscale Serve on from the composer and reports the tailnet URL", async () => {
    const output = await executeRemoteAccessCommand(["tailscale", "on"])

    expect(setTailscaleServe).toHaveBeenCalledWith(true)
    expect(output).toContain("https://desk.tail1234.ts.net")
    expect(output).toContain("/remote link")
  })

  it("lists the Tailscale state in status and hides it from a paired browser", async () => {
    vi.mocked(getRemoteStatus).mockResolvedValue(enabledStatus)
    const desktop = await executeRemoteAccessCommand(["status"])
    expect(desktop).toContain(
      "| Tailscale | Connected · desk.tail1234.ts.net · 100.101.102.103 |"
    )
    expect(desktop).toContain("| Tailscale HTTPS | Off |")

    window.__BETTERC0DE__ = {
      port: 3773,
      mode: "remote_http",
      baseUrl: "http://192.168.1.50:3773",
    }
    vi.mocked(getTailscaleStatus).mockClear()
    const paired = await executeRemoteAccessCommand(["tailscale", "on"])
    expect(paired).toContain("only be changed from the BetterC0de desktop app")
    expect(setTailscaleServe).not.toHaveBeenCalled()
    const status = await executeRemoteAccessCommand(["status"])
    expect(status).not.toContain("| Tailscale |")
    expect(getTailscaleStatus).not.toHaveBeenCalled()
  })

  it("enables the desktop listener and returns a fresh one-time link", async () => {
    vi.mocked(getRemoteStatus)
      .mockResolvedValueOnce({
        ...enabledStatus,
        enabled: false,
        listeningOnNetwork: false,
      })
      .mockResolvedValueOnce(enabledStatus)

    const output = await executeRemoteAccessCommand([])

    expect(useSettingsStore.getState().update).toHaveBeenCalledWith({
      remote_access_enabled: true,
    })
    expect(window.electronAPI?.restartBackend).toHaveBeenCalledOnce()
    expect(createRemotePairingLink).toHaveBeenCalledWith(
      "Chat command pairing",
      10
    )
    expect(output).toContain("ABCD-EFGH-JKLM")
    expect(output).toContain("http://192.168.1.50:3773/#token=")
  })

  it("shows status without giving a paired browser owner operations", async () => {
    window.__BETTERC0DE__ = {
      port: 3773,
      mode: "remote_http",
      baseUrl: "http://192.168.1.50:3773",
    }
    vi.mocked(getRemoteStatus).mockResolvedValue({
      ...enabledStatus,
      authentication: "remote",
      currentSessionId: "session-1",
    })

    const output = await executeRemoteAccessCommand([])

    expect(output).toContain("Paired browser")
    expect(output).toContain("restricted to the desktop host")
    expect(createRemotePairingLink).not.toHaveBeenCalled()
    expect(window.electronAPI?.restartBackend).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from "vitest"
import {
  buildTailscaleHttpsBaseUrl,
  classifyTailscaleStderr,
  createTailscaleRemoteAccess,
  findTailscaleServeMapping,
  isTailscaleIpv4Address,
  isTailscaleAddress,
  parseTailscaleStatus,
  reconcileTailscaleServe,
  tailscaleExecutableCandidates,
  tailscaleServeArgs,
  tailscaleServeOffArgs,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
} from "./tailscale"

const STATUS_RUNNING = JSON.stringify({
  BackendState: "Running",
  CertDomains: ["desk.tail1234.ts.net"],
  Self: {
    DNSName: "Desk.tail1234.ts.net.",
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
  },
})

const SERVE_MAPPED = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: {
    "desk.tail1234.ts.net:443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
    },
  },
})

function scriptedRunner(
  script: Record<string, TailscaleCommandResult>
): TailscaleCommandRunner & { calls: string[][] } {
  const calls: string[][] = []
  const runner: TailscaleCommandRunner = async (args) => {
    calls.push([...args])
    const key = args.join(" ")
    return script[key] ?? { ok: false, reason: "exit", exitCode: 1 }
  }
  return Object.assign(runner, { calls })
}

describe("tailscale status parsing", () => {
  it("normalizes the MagicDNS name and keeps only tailnet IPv4 addresses", () => {
    expect(parseTailscaleStatus(STATUS_RUNNING)).toEqual({
      installed: true,
      state: "running",
      magicDnsName: "desk.tail1234.ts.net",
      tailnetIpv4Addresses: ["100.101.102.103"],
      selfAddresses: ["100.101.102.103", "fd7a:115c:a1e0::1"],
      httpsCertificates: true,
    })
  })

  it("maps backend states and tolerates missing fields", () => {
    expect(parseTailscaleStatus('{"BackendState":"NeedsLogin"}').state).toBe(
      "needs-login"
    )
    expect(parseTailscaleStatus('{"BackendState":"Stopped"}').state).toBe(
      "stopped"
    )
    expect(parseTailscaleStatus("{}")).toMatchObject({
      state: "unavailable",
      magicDnsName: null,
      httpsCertificates: false,
    })
    expect(parseTailscaleStatus("not json").state).toBe("unavailable")
  })

  it("recognizes only the CGNAT range Tailscale hands out", () => {
    expect(isTailscaleIpv4Address("100.64.0.1")).toBe(true)
    expect(isTailscaleIpv4Address("100.127.255.254")).toBe(true)
    expect(isTailscaleIpv4Address("100.128.0.1")).toBe(false)
    expect(isTailscaleIpv4Address("192.168.1.2")).toBe(false)
    expect(isTailscaleIpv4Address("100.64.0")).toBe(false)
    expect(isTailscaleIpv4Address("100.64.0.1suffix")).toBe(false)
    expect(isTailscaleIpv4Address("100.64.0.1:443")).toBe(false)
    expect(isTailscaleAddress("fd7a:115c:a1e0:not-an-address")).toBe(false)
    expect(isTailscaleAddress("fd7a:115c:a1e0::1")).toBe(true)
    expect(isTailscaleAddress("::ffff:100.64.0.1")).toBe(true)
  })
})

describe("tailscale serve mapping", () => {
  it("finds the HTTPS port that proxies to this backend", () => {
    expect(findTailscaleServeMapping(SERVE_MAPPED, 3773)).toEqual({
      servePort: 443,
    })
    expect(findTailscaleServeMapping(SERVE_MAPPED, 3774)).toBeNull()
  })

  it("accepts localhost targets and foreground mappings on other ports", () => {
    const foreground = JSON.stringify({
      Foreground: {
        "12345": {
          Web: {
            "desk.tail1234.ts.net:8443": {
              Handlers: { "/": { Proxy: "http://localhost:3773/" } },
            },
          },
        },
      },
    })
    expect(findTailscaleServeMapping(foreground, 3773)).toEqual({
      servePort: 8443,
    })
    expect(findTailscaleServeMapping("{}", 3773)).toBeNull()
    expect(findTailscaleServeMapping("garbage", 3773)).toBeNull()
  })

  it("builds the serve commands and the HTTPS base URL", () => {
    expect(tailscaleServeArgs({ localPort: 3773 })).toEqual([
      "serve",
      "--bg",
      "--https=443",
      "http://127.0.0.1:3773",
    ])
    expect(tailscaleServeOffArgs()).toEqual(["serve", "--https=443", "off"])
    expect(buildTailscaleHttpsBaseUrl("desk.tail1234.ts.net")).toBe(
      "https://desk.tail1234.ts.net"
    )
    expect(buildTailscaleHttpsBaseUrl("desk.tail1234.ts.net", 8443)).toBe(
      "https://desk.tail1234.ts.net:8443"
    )
  })
})

describe("tailscale CLI safety", () => {
  it("classifies wrapped and styled diagnostics while preserving priority", () => {
    expect(
      classifyTailscaleStderr("Access\r\n is\tdenied. tskey-auth-private")
    ).toBe("permission-denied")
    expect(
      classifyTailscaleStderr(
        "\u001b[31mNot logged\u001b[0m in\nhttps://login.example/secret"
      )
    ).toBe("not-logged-in")
    expect(
      classifyTailscaleStderr("permission denied; handler does not exist")
    ).toBe("no-existing-handler")
    expect(classifyTailscaleStderr("permission denied; needs login")).toBe(
      "not-logged-in"
    )
    expect(classifyTailscaleStderr(" \r\n\t")).toBeUndefined()
  })

  it("classifies stderr into labels and never keeps the text", () => {
    expect(classifyTailscaleStderr("")).toBeUndefined()
    expect(classifyTailscaleStderr("error: handler does not exist")).toBe(
      "no-existing-handler"
    )
    expect(
      classifyTailscaleStderr("Logged out. Log in with tskey-auth-abc")
    ).toBe("not-logged-in")
    expect(classifyTailscaleStderr("Access is denied.")).toBe(
      "permission-denied"
    )
    expect(classifyTailscaleStderr("something else tskey-auth-xyz")).toBe(
      "unknown"
    )
  })

  it("spawns tailscale.exe on Windows and falls back to the install directory", () => {
    expect(
      tailscaleExecutableCandidates("win32", { ProgramFiles: "C:\\PF" })
    ).toEqual(["tailscale.exe", "C:\\PF\\Tailscale\\tailscale.exe"])
    expect(tailscaleExecutableCandidates("linux")[0]).toBe("tailscale")
  })
})

describe("tailscale remote access service", () => {
  it("describes a served tailnet endpoint", async () => {
    const run = scriptedRunner({
      "status --json": { ok: true, stdout: STATUS_RUNNING },
      "serve status --json": { ok: true, stdout: SERVE_MAPPED },
    })
    const service = createTailscaleRemoteAccess({ run })
    await expect(
      service.describe({ localPort: 3773, serveEnabled: true })
    ).resolves.toMatchObject({
      installed: true,
      state: "running",
      serveEnabled: true,
      serveActive: true,
      servePort: 443,
      httpsBaseUrl: "https://desk.tail1234.ts.net",
    })
  })

  it("reports a missing CLI without spawning serve status", async () => {
    const run = scriptedRunner({
      "status --json": { ok: false, reason: "not-installed" },
    })
    const service = createTailscaleRemoteAccess({ run })
    const described = await service.describe({
      localPort: 3773,
      serveEnabled: true,
    })
    expect(described).toMatchObject({
      installed: false,
      serveActive: false,
      httpsBaseUrl: null,
    })
    expect(run.calls).toEqual([["status", "--json"]])
  })

  it("caches status briefly so the settings page does not spawn per poll", async () => {
    let now = 1_000
    const run = scriptedRunner({
      "status --json": { ok: true, stdout: STATUS_RUNNING },
    })
    const service = createTailscaleRemoteAccess({ run, now: () => now })
    await service.status()
    await service.status()
    expect(run.calls).toHaveLength(1)
    now += 10_000
    await service.status()
    expect(run.calls).toHaveLength(2)
  })

  it("surfaces serve failures as typed errors and treats a missing handler as off", async () => {
    const run = scriptedRunner({
      "serve --bg --https=443 http://127.0.0.1:3773": {
        ok: false,
        reason: "exit",
        exitCode: 1,
        diagnostic: "not-logged-in",
      },
      "serve --https=443 off": {
        ok: false,
        reason: "exit",
        exitCode: 1,
        diagnostic: "no-existing-handler",
      },
    })
    const service = createTailscaleRemoteAccess({ run })
    await expect(service.enableServe(3773)).rejects.toThrow(
      "Tailscale is installed but not logged in"
    )
    await expect(service.disableServe()).resolves.toBeUndefined()
  })

  it("re-applies the mapping at boot only when both settings ask for it", async () => {
    const enableServe = vi.fn().mockResolvedValue(undefined)
    const tailscale = {
      enableServe,
      disableServe: vi.fn(),
      status: vi.fn().mockResolvedValue(undefined),
      selfAddresses: () => new Set<string>(),
      describe: vi.fn(),
    }
    await reconcileTailscaleServe(tailscale, {
      enabled: true,
      remoteAccessEnabled: false,
      localPort: 3773,
    })
    await reconcileTailscaleServe(tailscale, {
      enabled: false,
      remoteAccessEnabled: true,
      localPort: 3773,
    })
    expect(enableServe).not.toHaveBeenCalled()
    await reconcileTailscaleServe(tailscale, {
      enabled: true,
      remoteAccessEnabled: true,
      localPort: 3781,
    })
    expect(enableServe).toHaveBeenCalledWith(3781)
    // A refusing CLI is logged, never thrown into startup.
    enableServe.mockRejectedValueOnce(new Error("nope"))
    await expect(
      reconcileTailscaleServe(tailscale, {
        enabled: true,
        remoteAccessEnabled: true,
        localPort: 3781,
      })
    ).resolves.toBeUndefined()
  })
})

import { describe, expect, it, vi } from "vitest"
import type { ElectronUpdateStatus } from "@/types/electron-api"
import { describeUpdateStatus } from "./privacy-updates-sections"

vi.mock("@/services/backend/coreApi", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))
vi.mock("@/services/backend/providersApi", () => ({
  getCliStatus: vi.fn(),
}))

function status(
  overrides: Partial<ElectronUpdateStatus>
): ElectronUpdateStatus {
  return {
    mode: "notify",
    reason: "unsigned-build",
    status: "idle",
    currentVersion: "0.1.0",
    availableVersion: null,
    downloadUrl: null,
    releasesUrl: "https://github.com/kerim0x1/bettercode/releases",
    checkedAt: null,
    ...overrides,
  }
}

describe("update status text", () => {
  it("tells users of unsigned builds that updates are not installed automatically", () => {
    expect(describeUpdateStatus(status({}))).toMatch(
      /not code-signed, so it cannot install updates by itself/
    )
  })

  it("names the available version", () => {
    expect(
      describeUpdateStatus(
        status({ status: "available", availableVersion: "0.2.0" })
      )
    ).toBe("Version 0.2.0 is available.")
    expect(
      describeUpdateStatus(
        status({
          mode: "auto",
          reason: null,
          status: "available",
          availableVersion: "0.2.0",
        })
      )
    ).toMatch(/downloading and will be installed when you quit/)
  })

  it("explains package-manager installs and failed checks", () => {
    expect(describeUpdateStatus(status({ reason: "package-manager" }))).toMatch(
      /package manager/
    )
    expect(
      describeUpdateStatus(
        status({ mode: "auto", reason: null, status: "error" })
      )
    ).toBe(
      "Updates download automatically and install when you quit. The last update check failed."
    )
    expect(
      describeUpdateStatus(
        status({ mode: "auto", reason: null, status: "up-to-date" })
      )
    ).toMatch(/You have the latest version\.$/)
  })
})

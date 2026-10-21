import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  BackendStatusBanner,
  nextBackendBannerState,
  type BackendBannerState,
} from "./backend-status-banner"

const hidden: BackendBannerState = { kind: "hidden" }

describe("backend status banner", () => {
  it("announces supervised restarts after a crash", () => {
    expect(
      nextBackendBannerState(hidden, {
        status: "restarting",
        automatic: true,
        attempt: 2,
        reason: "Node backend exited (code=1 signal=none)",
      })
    ).toEqual({
      kind: "restarting",
      attempt: 2,
      reason: "Node backend exited (code=1 signal=none)",
    })
  })

  it("stays hidden for restarts started from settings", () => {
    expect(
      nextBackendBannerState(hidden, {
        status: "restarting",
        reason: "requested from the app",
      })
    ).toEqual(hidden)
  })

  it("offers a manual restart when the backend failed and hides on ready", () => {
    const failed = nextBackendBannerState(hidden, {
      status: "failed",
      reason: "crash 5",
      restartAvailable: true,
      crashLoop: true,
    })
    expect(failed).toEqual({
      kind: "failed",
      reason: "crash 5",
      crashLoop: true,
    })
    // The manual restart the banner starts keeps it visible until ready.
    expect(nextBackendBannerState(failed, { status: "restarting" }).kind).toBe(
      "restarting"
    )
    expect(
      nextBackendBannerState(failed, { status: "ready", port: 4774 })
    ).toEqual(hidden)
  })

  it("ignores unknown statuses", () => {
    const failed: BackendBannerState = { kind: "failed", crashLoop: false }
    expect(nextBackendBannerState(failed, { status: "something-new" })).toBe(
      failed
    )
  })

  it("renders nothing while the backend is healthy", () => {
    expect(renderToStaticMarkup(<BackendStatusBanner />)).toBe("")
  })
})

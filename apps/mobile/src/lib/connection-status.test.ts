import { describe, expect, it } from "vitest"
import { connectionBadge } from "./connection-status"

const base = {
  mode: "live" as const,
  state: "online" as const,
  socketState: "live" as const,
  readOnly: false,
}

describe("connection badge", () => {
  it("says Live only when the desktop answered and the live channel is up", () => {
    expect(connectionBadge(base)).toMatchObject({
      kind: "live",
      label: "Live",
      healthy: true,
    })
    expect(connectionBadge({ ...base, socketState: "error" })).toMatchObject({
      kind: "reconnecting",
      healthy: false,
    })
    expect(
      connectionBadge({ ...base, socketState: "reconnecting" })
    ).toMatchObject({ kind: "reconnecting" })
    expect(
      connectionBadge({ ...base, socketState: "connecting" })
    ).toMatchObject({ kind: "connecting" })
    expect(
      connectionBadge({ ...base, state: "checking", socketState: "idle" })
    ).toMatchObject({ kind: "connecting" })
  })

  it("names the states the user can do something about", () => {
    expect(connectionBadge({ ...base, state: "offline" })).toMatchObject({
      label: "Offline",
      healthy: false,
    })
    expect(
      connectionBadge({ ...base, state: "remote_disabled" })
    ).toMatchObject({ label: "Remote off" })
    expect(connectionBadge({ ...base, readOnly: true })).toMatchObject({
      label: "Watching",
      healthy: true,
    })
    expect(
      connectionBadge({ ...base, mode: "demo", state: "offline" })
    ).toMatchObject({ label: "Demo" })
  })
})
